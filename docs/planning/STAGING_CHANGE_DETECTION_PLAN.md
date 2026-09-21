# Staging Change Detection + Cookie CAS (`staging_hash` + `seq`) — Cross-Client Implementation Plan

> **Status:** 🟢 **P0 complete** — design adopted as **ADR-034** (merged with convergence-plan C4); **P0 (shared helper + V1/V2 parity vectors) landed via 4-phase TDD (2026-09).** P1–P5 remain.
> **Spec / design:** `docs/design/STAGING_CHANGE_DETECTION_DESIGN.md` (decisions DS1–DS9, canonical §4, `seq`+CAS §3a, invariants §9).
> **ADR:** ADR-034 (`docs/design/ARCHITECTURAL_DECISIONS.md`).
> **Scope:** CLI (Python), Web (JS), Flutter (Dart), **Worker** — implement the `staging_hash` +
> `seq` cookie fields + event-driven change detection + stale-write CAS, with cross-client
> parity vectors V1–V4.

---

## 1. Objective

Add a `staging_hash` field (SHA-256 of canonical plaintext staging rows) to the remote
device cookie, and a `last_seen_hash` mirror to the local cookie, so any client can answer
*"has remote staging changed since I last reconciled?"* with **one ~200-byte cookie pull and
no decryption** — and switch change detection from timer polling to **event-driven**
reconciliation (login / reauth / reads / mutations). In the **same migration** (merged from
convergence-plan C4), add a monotonic **`seq`** field + a **Worker CAS** stale-write guard so a
racing device's late cookie PUT cannot silently clobber a newer claim.

This plan covers the mechanical work. The *decisions* are already locked in ADR-034; this
document translates them into concrete file/function-level changes and test groups.

---

## 2. Canonical `staging_hash` (the testable core — from ADR-034 §4)

```
staging_hash = SHA-256( hex )
  over  json.dumps( canonical_rows, sort_keys=True, separators=(",", ":") )
  where canonical_rows = [ canonical_row(r) for r in non-committed staging rows ]
                          sorted ascending by activity_id

canonical_row(r) = { activity_id, activity_status, activity, updated_at, committed }
  activity = compact JSON string (title/start_epoch/end_epoch/duration/tags/comment/
             media/entry_id/is_active/is_paused/pauses/metadata/device_uuid/
             end_device_uuid/block_index)
```

- Rows with `committed == true` are **excluded** before sorting (D11 — they moved to the ledger).
- The 5-field canonical row is serialized **as-is** (its `activity` field is already a compact
  JSON string in all three clients — verified: Python `_canonical_json`, JS `JSON.stringify`,
  Dart `json.encode`). `sort_keys=True` makes top-level key order irrelevant across clients.
- **`activity` key order (pinned — V1):** the `activity` string's internal key order is **not**
  normalized by `sort_keys` (it is a pre-serialized string), so it is fixed to the **Python
  literal order in `dtoToCanonicalRow`**: `title, start_epoch, end_epoch, duration, tags,
  comment, media, entry_id, is_active, is_paused, pauses, metadata, device_uuid,
  end_device_uuid, block_index`. JS/Dart must reorder their `activity` dict to match.
- **`comment` normalization (pinned — V1):** empty string → **`null`**. Python
  `.get("comment")` currently yields `""` for an explicit empty string while JS `|| null`
  yields `null`; canonical rule is `null` (Python adds the coercion; Dart matches).
- `updated_at` is preserved verbatim (no `now` backfill at hash time) — V4 depends on it.

**Determinism contract (V1–V4):** deterministic, key-independent (survives `rekey_seed`), and
byte-identical across CLI / Web / Flutter. This **excludes** hashing encrypted/obfuscated bytes
(random salt/nonce would make every re-push look like a change).

---

## 3. Shared helper — one per client

| Client | New / changed | Location |
|--------|---------------|----------|
| Python | `compute_staging_hash(rows: List[Dict]) -> str` (hex) | `domain/staging/row_merge.py` (co-located with `dtoToCanonicalRow` / `_canonical_json`) |
| Web | `computeStagingHash(rows) -> string` (hex) | `phpoc-web/src/sync/remote_sync.js` (co-located with `dtoToCanonicalRow`) |
| Flutter | `computeStagingHash(List<Map<String,dynamic>>) -> String` (hex) | new `phpoc-flutter/lib/data/sync/staging_hash.dart` |

All three must: filter `committed`, sort by `activity_id` ascending (byte/lexicographic on the
UTF-8 string), serialize with `sort_keys` + compact separators, SHA-256 → lowercase hex.
Flutter already uses `package:crypto` `sha256`; Python uses stdlib `hashlib`; Web uses the
Rust WASM `sha256` (or the existing `sha256` wrapper) — confirm the hex encoding is lowercase
in all three (parity vector V2).

---

## 4. Cookie schema changes

### Remote cookie — add `staging_hash` + `seq`

```json
{ "device_uuid": "<UUID>-<client>", "device_specifier": "<32-hex>", "staging_hash": "<64-hex>", "seq": <int> }
```

`staging_hash` and `seq` are each **optional/absent** for old clients (D9). `parse_remote` /
`parseRemote` must tolerate their absence (absent `staging_hash` → treat as "unknown", never
"unchanged"; absent `seq` → treat as `0`).

### Local cookie — add `last_seen_hash` + `last_seen_seq`

```json
{ "device_specifier": "<32-hex>", "creation_time": <epoch_ms>, "last_seen_hash": "<64-hex>", "last_seen_seq": <int> }
```

`last_seen_hash` = the remote `staging_hash` I last reconciled to (after my own push, or after
a remote merge). It is the comparison baseline. **TTL rule unchanged (I4):** reads/checks never
refresh `creation_time` — only mutations and reauth do.
`last_seen_seq` = the `seq` I last wrote/observed — the increment base for the next cookie write
(§4a).

| Client | Files |
|--------|-------|
| Python | `domain/cookie/device_cookie.py` — `DeviceCookie.create()` writes all four; `create_local()`, `is_valid_locally()` (return dict now carries `last_seen_hash` + `last_seen_seq`), `parse_remote()` tolerates `staging_hash` + `seq` |
| Web | `phpoc-web/src/sync/cookie.js` — `DeviceCookie.create()` / `isValidLocally()` / `parseRemote()`; `sync.js` reads/writes via `storage.get/set('cookie')` |
| Flutter | `phpoc-flutter/lib/data/sync/device_cookie.dart` — `DeviceCookie.create()` / `isValidLocally()` / `parseRemote()`; model `lib/core/models/device_cookie.dart` — add `stagingHash`/`lastSeenHash`/`seq`/`lastSeenSeq` to `toJson`/`fromJson` |

### 4a. `seq` + Worker CAS (merged from convergence-plan C4)

- **`seq`** is a single monotonic counter on the cookie *object* (single-owner singleton → one
  global counter). On every cookie write (mutation push or ownership claim), the writer sets
  `seq = last_seen_seq + 1`.
- **Worker CAS (the only Worker-side change):** reject a cookie PUT whose `seq` is present and
  `<=` the stored `seq` (`409`); accept legacy cookies *without* `seq` last-write-wins (D9 — CAS
  applies only when `seq` is present, so old clients are never broken). Add the guard to the
  Worker cookie PUT route (`worker/`).
- **On `409`:** re-pull the cookie (fresh `seq` + `staging_hash`), re-merge, retry once — or
  surface `REAUTH_NEEDED` if `device_specifier` changed.
- **Push order is unchanged** (blob before cookie); the cookie now carries both `staging_hash`
  and `seq`, so a successful cookie write is atomic with the hash it advertises.

---

## 5. Event-driven wiring (replaces polling)

ADR-034 decision 4 removes continuous polling. Per-client:

### CLI (Python)

- **Reads in scope (DS7):** `phpoc_cli/interface.py` `_sync_before_command()` already calls
  `check_and_sync(timeout_ms=500)` before commands — keep this as the read gate; the hash
  (step 3 of §5 read flow) makes the common case stop at the cookie pull without a blob pull.
- **Mutations (DS5):** today CLI `capture/end/pause/unpause` are local-only ("No remote sync");
  remote push only on explicit sync/daemon. ADR-034 makes **every client check-and-push on every
  mutation** — so CLI mutation commands must now route through `push_to_remote` (via
  `_defer_push()` / `_push_if_remote()`) after `_touch_local_cookie()`, same as Web/Flutter.
  *(Confirm whether this is a `ph`-interactive-only change or also the daemon file-watcher path.)*
- **Daemon (DS4):** `phpoc_cli/daemon.py` `_run_event_loop()` 60 s `pull_check()` and
  `phpoc_cli/daemon_sync.py` `DaemonSyncWorker.pull_check()` are periodic remote-drift probes.
  Under ADR-034 they are **retired or re-scoped** to event-triggered push only (file-watcher
  already triggers on local writes). Flag for confirmation: keep the daemon for background WAL
  push, drop the 60 s remote poll.

### Web (JS)

- **Reads (DS7):** screen-mount already bootstraps `checkAndSync()`; the hash makes it cheap.
  `useCookieMonitor.js` (60 s **local-TTL-only** poll, no network) **stays** — it enforces TTL
  (I4), not remote drift, so it does not violate DS4.
- **Mutations (DS5):** `useAutoSync.js` already debounce-pushes after each mutation — after the
  change, the push path (`pushToRemote` → `_pushCookie`) must carry the recomputed `staging_hash`.
- **`checkAndSync()` phases:** insert the hash gate into `_fastPathPhase()` (step 3 of §5 read
  flow) — `remote.staging_hash === local.last_seen_hash` → skip blob pull; else proceed to
  `_authGatePhase()` / `_reconcileAndClaim()`.

### Flutter (Dart)

- **Reads (DS7):** screen build already triggers `checkAndSync()`.
- **Mutations (DS5):** `_afterMutation()` → `_touchLocalCookie()` + `_schedulePush()` already
  debounce-pushes; the push path (`pushToRemote` → `_pushCookie`) carries the recomputed hash.
- **Polling removal (DS4):** delete `startPeriodicSync()` / `stopPeriodicSync()` /
  `_onPeriodicTick()` in `sync_service.dart`, and the `PeriodicSyncCoordinator` /
  `periodic_sync_coordinator.dart` / `periodic_sync_orchestrator.dart` wiring (the 5 s
  `defaultPeriodicSyncInterval` timer). Replace with event-driven triggers only.

---

## 6. Mutation flow (all clients — ADR-034 §6)

```
1. interaction check (§5 read flow)          ← pre-mutation reconcile gate
2. apply local mutation                       (capture/end/pause/unpause/modify/remove)
3. recompute staging_hash (§2)
4. update LOCAL cookie                        (bump creation_time, set last_seen_hash + last_seen_seq, KEEP specifier)
5. push blob                                  (rows → staging/blob)
6. push REMOTE cookie                         ({device_uuid, specifier UNCHANGED, staging_hash, seq = last_seen_seq + 1})
                                              ← blob BEFORE cookie (I3)
```

Implementation points:

- **Step 3/4** — Python `StagingService.push_to_remote()` / `_push_on_fast_path()`; Web
  `pushToRemote()` / `_touchLocalCookie()`; Flutter `pushToRemote()` / `_touchLocalCookie()`:
  after building rows, compute the hash and bump `seq`, write both into both cookies.
- **Step 6 ordering** — already blob-before-cookie in all three; preserve it and make the
  hash in the pushed cookie always equal the just-pushed blob's hash (I3), and the `seq` always
  `last_seen_seq + 1` (I8).
- **Specifier cleanup (I5):** Python currently regenerates the specifier on every full
  `push_to_remote` — change it to **only regenerate in `reconcile_and_claim`** (ownership
  handoff). Web/Flutter already reuse the specifier across same-device mutations; verify and
  keep.

---

## 7. Read flow (all clients — ADR-034 §5)

```
1. LOCAL TTL gate: local cookie missing OR (now - creation_time) > 30 min → REAUTH_NEEDED
2. NETWORK: pull remote cookie (~200 B / ETag 304; yields `staging_hash` + `seq`);
   unreachable → OFFLINE (fail-open)
3. HASH: remote.staging_hash vs local.last_seen_hash
     EQUAL     → skip blob pull → done
     DIFFERENT → continue
     MISSING   → old client / first run → treat as "changed" (full pull+merge)
4. SPECIFIER: remote.device_specifier vs local.device_specifier
     MATCH    → pull blob → merge → push reconciled → set last_seen_hash
     MISMATCH → REAUTH_NEEDED → reconcile_and_claim → set last_seen_hash
```

- The hash (step 3) gates only the **expensive blob pull**; TTL (step 1) and specifier (step 4)
  are the security gates and are never skipped when the hash is unchanged. The cookie pull
  (step 2) also yields the current `seq` (stored as `last_seen_seq`) for the next write.
- CLI reads keep the existing `timeout_ms=500` **fail-open** so offline reads stay instant;
  Web/Flutter reads are async and render local-first.

---

## 8. Hash unification (ADR-034 §4.3)

| Existing ad-hoc hash | Action |
|----------------------|--------|
| CLI F3 `.last_push_hash` (SHA of raw local entries, MK-dependent) | Remove; `staging_hash` replaces it |
| Web Tier-1 staging SHA (SHA of *encrypted* hash index — coarse + key-dependent) | Remove the change-detection use; `staging_hash` replaces it (`staging_hash_index.js` `computeHashForIndex` / `compareStagingHashIndexes`) |

`staging/hash_index.json` **remains** for its O(1) activity add/remove signal; it is simply no
longer the change-detection authority.

---

## 9. Test plan (4-phase TDD)

Run the standard 4-phase TDD workflow per client (`docs/planning/AGENTS.md`), then the
cross-client parity gate last.

### Groups (shared assertion taxonomy across clients)

| Group | Verifies | Maps to |
|-------|----------|---------|
| **A** — canonical serialization (V1) | identical compact JSON for a fixed row set | §2 |
| **B** — digest parity (V2) | identical `staging_hash` (sorting, key order, `updated_at`, committed exclusion) | §2 |
| **C** — key-independence (V3) | hash unchanged after `rekey_seed` re-encryption | §2, DS8 |
| **D** — change sensitivity (V4) | any field change (title/tags/times/status/`updated_at`) changes digest | §2 |
| **E** — cookie schema + backward compat | `parse_remote`/`matches` tolerate `staging_hash`/`last_seen_hash`; absent hash → "unknown" | §4, D9 |
| **F** — mutation flow | hash recompute + local cookie update (bump `creation_time`, set `last_seen_hash`, keep specifier) + blob-before-cookie | §6 |
| **G** — read-flow hash gate | equal→skip blob; different→pull+merge; missing→full pull+merge | §7 |
| **H** — specifier stability (I5) | specifier unchanged across same-device mutations; regenerated only on handoff | §6 |
| **I** — hash unification | F3 `.last_push_hash` / Web encrypted-index SHA retired | §8 |
| **J** — `seq` + CAS | monotonic `seq` bump (`last_seen_seq + 1`); Worker rejects `seq`-present-and-`<=`-stored with `409`; legacy no-`seq` cookie accepted | §4a, I8 |

### Per-client test files

- **Python:** `tests/test_staging_hash.py` (groups A–J) + update `tests/test_device_cookie.py`,
  `tests/test_cli_sync_gate_wiring.py` for the schema/wiring changes.
- **Web:** `phpoc-web/test/staging_hash_test.mjs` (groups A–J) + update `cookie` / `sync` /
  `ccs2_row_level_reconcile` suites for schema/wiring changes.
- **Flutter:** `phpoc-flutter/test/data/sync/staging_hash_test.dart` (groups A–J) + update
  `device_cookie_test` / `sync_service_test` / `periodic_sync_coordinator` suites (timer removal).
- **Worker:** add a cookie-CAS test (group J) to the Worker test suite — stale `seq` PUT → `409`,
  legacy no-`seq` PUT → accepted.

### Cross-client parity gate (V1–V4)

Follow the CCS-4 / deterministic-obfuscation pattern: a shared fixture (fixed row set + expected
digest) consumed by all three clients to prove byte-parity:

- **V1** — `tests/` + JS + Dart each serialize the fixture and compare to one golden compact JSON.
- **V2** — each client computes `staging_hash`; all three must equal one golden hex digest.
- **V3** — re-key (`rekey_seed`) the fixture rows; digest unchanged across all three.
- **V4** — mutate one field per fixture; digest changes (and matches the peer's changed digest).

---

## 10. Phasing / dependency order

1. **P0 — shared helper + parity vectors (V1/V2).** Land `compute_staging_hash` in all three
   clients and prove byte-parity on a frozen fixture *before* any wiring. This is the
   ADR-034 §4.4 gate ("parity vectors required before adoption is complete").
   **Phases 1–4 COMPLETE (2026-09):** `STAGING_HASH_PARITY_PHASE1.md` (22 assertions, groups A–G).
   GREEN all three clients (Python 11/1skip · Web `node --test` 5/5 · Flutter 6/6) + regressions clean
   (Python 2741/2skip · Web vitest 181/1skip · `flutter analyze`/`dart analyze` clean). Phase 4 extracted
   Web's inlined SHA-256 into `phpoc-web/src/crypto/sha256.js`. **✅ DONE.**
2. **P1 — cookie schema + CAS** (remote `staging_hash` + `seq`, local `last_seen_hash` +
   `last_seen_seq`) with backward-compat parse tolerance (group E), plus the **Worker CAS guard**
   (group J).
3. **P2 — mutation flow** (hash recompute + local cookie update + specifier-stability cleanup +
   blob-before-cookie), group F/H.
4. **P3 — read flow** (hash gate in `check_and_sync` / `_fastPath*`), group G.
5. **P4 — polling removal + hash unification** (retire Flutter 5 s timer, CLI 60 s poll, F3 /
   Web encrypted-index hashes), group I.
6. **P5 — cross-client E2E** against the live Worker (mirror CCS-4 pairs): confirm the cookie
   hash round-trips and that a second client's mutation flips the first client's `staging_hash`
   on next event.

---

## 11. Effort estimate

- Shared helper + parity vectors: **~0.5 day** (small, pure functions).
- Cookie schema ×3 + Worker CAS: **~1 day**.
- Mutation + read wiring ×3: **~2 days** (largest surface — `service.py` / `sync.js` /
  `sync_service.dart`).
- Polling removal + hash unification: **~1 day** (includes daemon/coordinator re-scope).
- Cross-client E2E: **~1 day**.
- **Total: ~5.5 days** (with 4-phase TDD per client).

---

## 12. Risks / open items

- **CLI daemon re-scope (DS4):** whether the 60 s `pull_check` is fully removed or re-scoped to
  push-only needs user confirmation (CLI has no in-app "screen mount" trigger, so reads are
  per-command — the daemon's background role may still be wanted for unattended push).
- **Worker ETag:** confirm the Worker honors `If-None-Match → 304` for the device cookie so the
  cheap ~200 B poll premise holds (no Worker code change for the hash itself).
- **`activity` string parity:** V1 must confirm all three clients store `activity` as a
  *compact* JSON string (no whitespace) so the outer `json.dumps(sort_keys=True)` digest matches.
- **Commitment on every CLI mutation:** ADR-034 decision 5 changes the CLI from "local-only mutations +
  explicit sync" to "push on every mutation" — verify this is intended before wiring.
- **Overlap with convergence-plan C4 — RESOLVED (merged, 2026-09):** C4 (`seq` + Worker CAS) is
  now **merged into this plan** (§4a) as ADR-034 decision 8 (design doc DS9) — one cookie migration, not two.
- **Worker CAS guard (new):** the `seq`-present-and-`<=`-stored `409` rule must be implemented in
  the Worker PUT handler, and must **not** reject legacy cookies that omit `seq` (D9 — CAS applies
  only when `seq` is present). This is the first Worker-side change in this plan; confirm the
  Worker route and add a CAS test (group J).
- **Legacy-write transition edge:** until all clients ship `seq`, a legacy (no-`seq`) cookie PUT
  can still overwrite a newer `seq`-carrying cookie (last-write-wins). Accepted as a
  single-user-migration window (D9); it self-heals once all clients write `seq`.

---

## 13. Verification (DOX)

- `docs/reference/MAP.md` — planning-doc entry added (this file).
- `docs/planning/BACKLOG.md` — active issue referencing this plan.
- `docs/design/STAGING_CHANGE_DETECTION_DESIGN.md` / `ARCHITECTURAL_DECISIONS.md` — ADR-034
  adopted and **amended to merge C4 (`seq` + CAS)**; no further doc change until implementation.
- `docs/planning/CROSS_CLIENT_STAGING_CONVERGENCE_PLAN.md` — C4 re-scoped to point at ADR-034 decision 8 / design doc DS9.
