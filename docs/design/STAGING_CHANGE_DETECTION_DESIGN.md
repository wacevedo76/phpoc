# Staging Change Detection via Cookie Hash — Event-Driven Reconciliation

> **Status:** ✅ **ADOPTED (ADR-034)** — design discussion complete; **no code changes made**; implementation + parity vectors pending.
> **Date:** 2026-09 (design session).
> **Scope:** Add a `staging_hash` field to the remote device cookie (and a `last_seen_hash` mirror to the local cookie) to cheaply detect remote staging changes, switch change detection from timer polling to **event-driven** reconciliation (login / reauth / reads / mutations), and **merge in the `seq` + Worker CAS write-arbitration field** so the cookie is migrated once (see DS9).

---

## 1. Goal

Today, detecting "did another device change remote staging?" requires pulling the ~64 KB
staging blob and merging, or relies on the coarse `staging/hash_index.json`
(`[{activity_id, activity_status}]`) which **misses content edits** — a title/tags/times
change to an activity with an unchanged status produces an identical index. The device
cookie (ADR-022) already provides a ~100-byte "who owns staging" token, but carries no
content signal.

This design adds a single field so any client can answer, in **one ~200-byte cookie pull,
with no decryption**, the question: *"has remote staging changed since I last reconciled?"*

The change-detection signal is **not** a timer. It fires on user interaction events:
login, reauth, any staging mutation, and reads. The remote blob + cookie remains the
**source of truth, realized lazily at interaction time**.

---

## 2. Decisions (locked in this session)

> These **DS**-prefixed labels are *this design session's* decisions, distinct from the
> top-level directives **D1–D11** in `TOP_LEVEL_DIRECTIVES.md` (checked in the Decision
> Checklist at the end of this document). Both numbering systems coexist below.

| # | Decision | Rationale |
|---|----------|-----------|
| DS1 | Value is a **content hash**, not a timestamp/counter | No clock skew, no lost-update race; converges under concurrent writers; answers "differs from my state" |
| DS2 | Hash lives **in the device cookie** (small, ~200 B) | Cookie is already the cheap first network read; no new object/file |
| DS3 | Reauth gate keyed on **`device_specifier`** (not `device_uuid`) | Specifier is the ownership token; `device_uuid` stays informational (client-suffixed) |
| DS4 | Check is **event-driven** — login, reauth, reads, mutations (no timer) | Removes the polling battery/request cost; "remote is source of truth" realized lazily |
| DS5 | **Every client checks-and-pushes on every mutation** (CLI included) | Remote stays current; each client can reconcile at any event |
| DS6 | **Merge semantics unchanged** (LWW, terminal-state, committed-filter) | "Remote is source of truth" = *where you reconcile*, not *remote wins conflicts* |
| DS7 | **Reads are in scope** (login / list / view / screen mount) | Lazy truth would otherwise go stale mid-session |
| DS8 | **Hash scope = canonical plaintext rows** (not encrypted bytes) | Only deterministic + key-independent + byte-identical option; cookie carries no user-identifiable content |
| DS9 | **Merge `seq` + Worker CAS into this migration** (was convergence-plan C4) | One cookie migration, not two: `staging_hash` = change detection; `seq` = write arbitration |

---

## 3. Cookie Schema

### Remote cookie — `staging/blobs/device_cookie.bin` (unchanged path)

```json
{
  "device_uuid": "<UUID4>-<client>",
  "device_specifier": "<32-hex>",
  "staging_hash": "<64-hex>",
  "seq": <int>
}
```

- `staging_hash` and `seq` are each **optional/absent** for old clients (backward compat, D9).
- Remote cookie remains **unencrypted** (specifier/hash compare needs no MK) — the hash is a
  digest of staging content, revealing only "content changed," not the content itself.
- Total size ~**200+ bytes** (was ~110).

### Local cookie — gains two fields

```json
{
  "device_specifier": "<32-hex>",
  "creation_time": <epoch_ms>,
  "last_seen_hash": "<64-hex>",
  "last_seen_seq": <int>
}
```

- `last_seen_hash` = "the `staging_hash` I last reconciled to" (after my own push, or after a
  remote merge). This is the comparison baseline for "has remote changed since I last looked."
- `last_seen_seq` = "the `seq` I last wrote/observed" — the increment base for the next cookie
  write (see §3a).
- **TTL rule is unchanged and still binding:** the read/check poll must **not** refresh
  `creation_time` — only mutations and reauth do. A forever-reading client must still reauth
  after 30 min.
- The specifier is preserved across same-device mutations; it is regenerated **only** on
  ownership handoff (`reconcile_and_claim`). (This is a small cleanup: today the CLI
  regenerates it on every full `push_to_remote`, which would churn it under per-mutation pushes.)

### 3a. `seq` + Worker CAS (merged from convergence-plan C4)

- **`seq`** is a single monotonic counter on the cookie *object* (the cookie is a single-owner
  singleton, so one global counter suffices — resolves the previously-open D-C4-1).
- On every cookie write (mutation push or ownership claim), the writer sets
  `seq = last_seen_seq + 1`, using the `seq` observed at its last pull/claim.
- **Worker CAS:** a cookie PUT whose `seq` is present and `<=` the stored `seq` is rejected
  (`409`). Legacy cookies **without** `seq` are accepted last-write-wins (D9) — CAS applies only
  when the incoming cookie carries `seq`, so old clients are never broken mid-migration.
- **On `409`:** the client re-pulls the cookie (fresh `seq` + `staging_hash`), re-merges, and
  retries once — or surfaces `REAUTH_NEEDED` if `device_specifier` changed (ownership moved).
- **Relationship to `staging_hash`:** they change together but answer different questions —
  `staging_hash` = "did content change?" (read cost); `seq` = "which write is current?" (race
  protection). Both ride the same cookie object and the same `push_cookie` path.

---

## 4. `staging_hash` Canonical Spec (the testable core)

### 4.1 Definition

```
staging_hash = SHA-256( JSON_array_of_canonical_rows )
  where:
    canonical_rows = [ canonical_row(r) for r in non-committed staging rows ]
                     sorted ascending by activity_id
    JSON_array_of_canonical_rows = json.dumps(canonical_rows,
                                              sort_keys=True,
                                              separators=(",", ":"))
```

`canonical_row(r)` is the existing cross-client canonical row form (PHPSPEC §8.1 /
`dtoToCanonicalRow` / `canonicalRowToDTO`), including `activity_id`, `activity_status`,
`activity`, `updated_at`, and the extra fields (`committed`, `title`, `start_epoch`, `tags`, …).
Committed rows are **excluded** (they have moved to the ledger, D11).

#### Canonical `activity` key order (pinned — V1)

The `activity` field is a **pre-serialized compact JSON string**, so its internal key order is
**not** normalized by the outer `sort_keys=True` — it is fixed by each language's insertion
order. To guarantee byte-identical digests, the canonical key order is **the Python literal
order in `dtoToCanonicalRow`** (JS and Dart must reorder their `activity` dict construction to
match):

```text
title, start_epoch, end_epoch, duration, tags, comment, media,
entry_id, is_active, is_paused, pauses, metadata, device_uuid,
end_device_uuid, block_index
```

(V1 asserts each client's serialized `activity` string equals the golden bytes in this exact
order.)

#### Field normalization (pinned — V1)

- **`comment`:** empty string (`""`) is normalized to **`null`** before serialization. Python
  `dto.get("comment")` currently yields `""` for an explicit empty string while JS
  `e.comment || null` already yields `null` — the canonical rule is **empty string → `null`**,
  so all three clients emit `null` (Python adds the coercion; Dart matches).

### 4.2 Determinism requirement (why *not* the encrypted bytes)

The hash MUST satisfy, for all three clients:

1. **Deterministic** — same logical staging → same digest.
2. **Key-independent** — survives re-key (`rekey_seed`), so re-encryption does not fake a change.
3. **Byte-identical** — CLI / Web / Flutter produce the same digest for the same plaintext state.

This **rules out hashing the obfuscated/encrypted bytes**: blob/per-row obfuscation uses
random salt/nonce, so re-pushing identical content yields different ciphertext → every push
looks like a change. Hashing the *canonical plaintext* rows is the only representation that
satisfies all three.

The apparent cost — computing the hash requires the master key (to read plaintext rows) — is
not a real cost: the hash is **computed only at mutation time**, when the MK is already in
memory. The read fast-path only **compares** stored digests (no MK, no decrypt).

> **Confirmed decision (ADR-034):** the hash is computed over **canonical plaintext** rows.
> The cookie carries no user-identifiable content — a SHA-256 digest reveals only "content
> changed," never the content itself — so plaintext canonical is the accepted scope.

### 4.3 Unification with existing hashes

This spec **absorbs** two current ad-hoc hashes rather than adding a third:

| Existing | Today | After |
|----------|-------|-------|
| CLI F3 `.last_push_hash` | SHA of raw local entries (MK-dependent, keyed fields) | replaced by `staging_hash` |
| Web Tier-1 staging SHA | SHA of *encrypted* hash index (coarse + key-dependent) | replaced by `staging_hash` |

`staging_hash` is finer-grained (all fields) and key-independent (plaintext canonical). The
`staging/hash_index.json` remains for its own purpose (O(1) activity add/remove signal), but is
no longer the change-detection authority.

### 4.4 Cross-client parity vectors

Adoption requires test vectors proving byte-parity, in the style of the CCS-4 /
deterministic-obfuscation vectors:

- **V1 — canonical serialization:** identical compact JSON for a fixed row set across
  CLI (Python), Web (JS), Flutter (Dart) — including the pinned `activity` key order and
  `comment` empty-string → `null` normalization (§4.1).
- **V2 — digest:** identical `staging_hash` for the same plaintext rows (incl. sorting,
  key order, `updated_at` preservation).
- **V3 — key-independence:** `staging_hash` unchanged after `rekey_seed` re-encryption of the
  same plaintext rows.
- **V4 — change sensitivity:** mutation to any field (title / tags / times / status /
  `updated_at`) changes the digest.

---

## 5. Event-Driven Read Flow

Triggers (client-appropriate): **login / unlock**, **reauth**, **every staging mutation**, and
**reads** (CLI `list/view/tags`; Web screen mount; Flutter screen build). No timer.

```
1. LOCAL TTL gate (no network): local cookie missing OR (now - creation_time) > 30 min
     → clear local cookie → REAUTH_NEEDED
2. NETWORK: pull remote cookie (ETag-cacheable, ~200 B / 304)
     unreachable → OFFLINE (use local, retry next event)
3. HASH compare: remote.staging_hash vs local.last_seen_hash
     EQUAL     → no staging change → SKIP blob pull → done (no reauth if TTL + specifier ok)
     DIFFERENT → staging changed → continue
     MISSING   → old client / first run → treat as "changed" (full pull+merge)
4. SPECIFIER compare: remote.device_specifier vs local.device_specifier
     MATCH    → same-session change → pull blob → merge → push reconciled → set last_seen_hash
     MISMATCH → different ownership → REAUTH_NEEDED (user consents) → reconcile_and_claim
                → set last_seen_hash
```

The hash (step 3) gates only the **expensive blob pull**. TTL (step 1) and specifier (step 4)
are the **security** gates and are never skipped just because the hash is unchanged — all
three checks are served by the one cookie pull.

**Note on ordering:** TTL is checked first here because it is local and free, and it
short-circuits the network call when the session is already stale. The hash remains the first
*gate on the expensive path*.

---

## 6. Mutation Flow (every client, every mutation)

```
1. interaction check (§5)            ← pre-mutation reconcile gate
2. apply local mutation               (capture/end/pause/unpause/modify/remove)
3. recompute staging_hash (§4)
4. update LOCAL cookie                (bump creation_time, set last_seen_hash + last_seen_seq;
                                       keep specifier)
5. push blob                          (raw entries → staging/blob)
6. push REMOTE cookie                 ({device_uuid, specifier UNCHANGED, staging_hash,
                                       seq = last_seen_seq + 1})
                                      ← blob BEFORE cookie
```

Two invariants:

- **Blob before cookie.** If the blob push fails, the cookie is unchanged and the next event
  retries; if the cookie push fails after the blob succeeds, the hash mismatch triggers a
  reconcile that pulls the correct blob. Writing the cookie (hash N) before the blob (N-1)
  would let a reader see hash N and pull a stale blob.
- **The hash in the cookie always corresponds to the blob just pushed.**
- **The `seq` in the cookie is the last-seen `seq` + 1** — a stale write (e.g. a racing peer)
  is rejected by the Worker, never silently clobbers a newer claim.

**Fail-open:** offline, steps 5–6 fail and the local mutation still persists (local cookie
already updated in step 4); the stale remote hash means the next event heals via merge. This
preserves the current guarantee that mutations are local-first.

---

## 7. Reconciliation Semantics (unchanged)

Merging still follows the existing rules — this design changes *when* reconciliation happens
(event-driven) and *how cheaply* it is gated (hash), not *how* it resolves:

- `activity_id` primary key (fallback `entry_id`).
- ADR-033 terminal-state rule: `ended` wins regardless of `updated_at`.
- Otherwise LWW; local wins on `updated_at` tie.
- `committed:true` rows are filtered (moved to ledger, D11).
- ADR-030: ownership-handoff reauth still pulls the remote ledger first, then reconciles
  staging against the ledger hash index (Scenario 5/6).

---

## 8. Performance Characteristics (reads in scope)

A read-check costs **1 cookie GET (~1 KB, one RTT)**; the 64 KB blob pull + merge happens only
when the hash changed. Bandwidth is negligible; the only real risk is **blocking latency on
offline CLI reads**.

| Client | Read trigger | Effect |
|--------|-------------|--------|
| CLI | `ph list/view/tags` | +1 RTT per command; **fail-fast (~500 ms) + fail-open to local** keeps offline reads instant |
| Web | screen mount | async — render local first, reconcile in background → zero perceived latency |
| Flutter | screen build | async, non-blocking; **removes** the existing 5s periodic timer (lighter) |

The hash is what makes reads affordable: 99% of reads stop at ~1 KB + one round-trip.

---

## 9. Invariants

| # | Invariant |
|---|-----------|
| I1 | Cookie (specifier) remains the sole auth decision; `staging_hash` never authorizes |
| I2 | `staging_hash` is deterministic, key-independent, and byte-identical across all clients |
| I3 | Blob is pushed before the remote cookie; the hash always matches the pushed blob |
| I4 | Reads never refresh cookie TTL; only mutations and reauth do |
| I5 | Specifier changes only on ownership handoff, never on same-device mutation |
| I6 | Merge semantics are unchanged by this design |
| I7 | Offline mutations persist locally and heal via merge on the next event |
| I8 | `seq` increments monotonically per cookie write; the Worker rejects stale `seq` (CAS) |

---

## 10. Accepted Consequences

- **Same-machine client switch:** CLI and Web on one machine carry different specifiers, so
  under DS3, alternating between them prompts reauth each switch. This is the intended per-client
  auth model; `device_uuid` remains available if a future "same-machine auto-reconcile" rule is
  ever wanted.
- **Idle staleness:** an open, untouched client does not live-reflect a second device's change
  until its next interaction (login/read/mutation). Accepted in favor of no polling.

---

## 11. Rollout / Migration

- Old clients omit `staging_hash` → new clients treat absent hash as **"unknown → full
  pull+merge"**, never "unchanged."
- `parse_remote` / `matches` in all three clients must tolerate the extra field.
- Worker: cookie path already returns ETag-capable blobs; **confirm the Worker honors
  `If-None-Match → 304`** (and ideally caches the cookie) so the cheap-poll premise holds.
  The **only** Worker-side change is the CAS guard (reject `seq`-present-and-`<=`-stored PUTs
  with `409`); the hash itself stays blind (no decrypt).

---

## 12. Related

- `docs/planning/CROSS_CLIENT_STAGING_CONVERGENCE_PLAN.md` (C4 `seq`+CAS merged here as DS9).
- ADR-022 (device cookie), ADR-024 (hash index fast path), ADR-025 (row-level staging),
  ADR-030 (ledger auto-pull on handoff), ADR-033 (terminal-state rule).
- `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (cross-client gate parity).
- `docs/reference/DEVICE_COOKIE_AND_STAGING_DATABASE_SCHEMA.md` (cookie + row schema).
- `docs/design/TOP_LEVEL_DIRECTIVES.md` (D1–D11; see Decision Checklist below).
- **ADR-034** — adopted; recorded in `docs/design/ARCHITECTURAL_DECISIONS.md`.

### Decision Checklist (D1–D11)

- [x] D1 user owns data — no new server-held secrets (hash is a plaintext digest)
- [x] D2 zero-knowledge — server never decrypts; hash reveals only "changed," not content
- [x] D3 zero deps — SHA-256 + canonical JSON use stdlib `hashlib`/`json`
- [x] D4 chain of trust — staging hash is orthogonal to block seals
- [x] D5 append-only — staging-only change, ledger untouched
- [x] D6 local-first — all mutations still succeed offline
- [x] D7 compartmentalization — hash does not cross key domains
- [x] D8 recoverability — key-independent hash survives re-key/seed replacement
- [x] D9 backward compatible — `staging_hash`/`seq` optional; old clients tolerated
- [x] D10 testing — §4.4 parity vectors V1–V4 required before adoption
- [x] D11 staging/ledger separation — hash covers non-committed staging only
