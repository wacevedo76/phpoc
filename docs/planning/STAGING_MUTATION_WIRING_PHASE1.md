# Staging Mutation Flow + Specifier Stability (ADR-034 P2) — Test Exploration (Phase 1)

> **Plan:** `STAGING_CHANGE_DETECTION_PLAN.md` §10 step 3 (P2) + `../design/STAGING_CHANGE_DETECTION_DESIGN.md` §6/§9
> **Purpose:** Blueprint of all test assertions needed for the P2 go/no-go gate — the mutation
> flow (recompute `staging_hash`, update the local cookie, bump `seq`, preserve blob-before-cookie)
> and the specifier-stability cleanup (I5) across CLI / Web / Flutter.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED — test definition)

---

## Architecture Overview

P0 landed `compute_staging_hash` / `computeStagingHash` (byte-identical, canonical-row digest).
P1 migrated the cookie schema so `staging_hash`/`seq` (remote) and `last_seen_hash`/`last_seen_seq`
(local) ride the cookie, with backward-compat parse tolerance. P2 makes **mutations actually write
those fields** — every mutation push recomputes the hash of the just-written staging and writes it
into both cookies, bumping `seq` monotonically — and fixes the **specifier churn** (I5) so a
same-device mutation never re-rolls ownership.

```
Mutation flow (ADR-034 §6, every client):
1. interaction check (read flow — P3)      ← pre-mutation reconcile gate
2. apply local mutation                      (capture/end/pause/unpause/modify/remove)
3. recompute staging_hash                   (§4 canonical rows, non-committed only)
4. update LOCAL cookie                      (bump creation_time, set last_seen_hash + last_seen_seq,
                                             KEEP device_specifier)
5. push blob                                 (entries → staging/blob)
6. push REMOTE cookie                        ({device_uuid, specifier UNCHANGED, staging_hash,
                                             seq = last_seen_seq + 1})
                                             ← blob BEFORE cookie (I3)
```

Three invariants govern P2:

- **I3** — blob before remote cookie; the hash in the cookie always equals the hash of the blob
  just pushed.
- **I8** — `seq` increments monotonically per cookie write (`next_seq(last_seen_seq)`); the Worker
  CAS (P1) rejects a stale `seq`.
- **I5** — the `device_specifier` changes only on ownership handoff, never on a same-device mutation.

**Fail-open (I7):** steps 5–6 may fail offline; the local mutation + the step-4 local-cookie update
already persisted, so the stale remote hash heals via merge on the next event.

---

## Key decisions (locked in Phase 1, confirmable in Phase 3)

1. **Hash input = the exact uncommitted canonical rows that are pushed.** Each client converts its
   local staging to canonical rows (`dtoToCanonicalRow` in Python/Web; Flutter's row store already
   holds canonical rows), filters `committed`, then hashes. Never hash raw/encrypted entries — the
   digest must stay key-independent (D8/V3) and byte-identical across clients (I2).
2. **The committed-filter used for hashing must match the committed-filter used for pushing.**
   Flutter's push path (`_pushStagingRowsToRemote`) filters via `_rowIsCommitted` (checks both the
   row-level `committed` flag and `activity.committed`), while `computeStagingHash` filters only the
   top-level `committed`. P2 must pass the *same* row set to both (hash the exact `activeRows`
   pushed, or reconcile the two filters) so I3 holds.
3. **Where the mutation push carries the hash + `seq`:**
   - Python: `push_to_remote()` (WAL background push + daemon) **and** `_push_on_fast_path()`
     (fast-path pending-write push).
   - Web: `pushToRemote()` (explicit) **and** `_pushOnFastPath()` (auto-sync).
   - Flutter: `pushToRemote()` / `_pushCookie()` **and** `_reconcileAndClaimRowLevel()` (handoff).
4. **`seq` increment base = the local cookie's `last_seen_seq`** (via `DeviceCookie.next_seq` /
   `nextSeq`); absent/legacy → `1`. The local cookie's `last_seen_seq` is refreshed to the pushed
   `seq` so the next mutation keeps counting forward.
5. **Step-4 local-cookie update is local-first** — bump `creation_time`, set `last_seen_hash` +
   `last_seen_seq`, keep `device_specifier` — and happens *before* the blob push, so an offline blob
   failure still leaves the local baseline recorded (I7).
6. **Specifier cleanup (I5):** Python `push_to_remote` currently calls
   `DeviceCookie.destroy_locally()` + `DeviceCookie.create()` (a *fresh* specifier) on every push —
   change it to **read/reuse** the existing specifier and only bump the other fields. Specifier is
   regenerated **only** in the handoff path (`_reconcile_and_claim` / `_ensure_cookie`; Web
   `_reconcileAndClaim`; Flutter `_reconcileAndClaimRowLevel`). Web/Flutter already reuse the
   specifier — verify and keep.
7. **Handoff claim is a cookie write too.** When `_reconcile_and_claim` (and the Web/Flutter
   equivalents) creates the fresh-ownership cookie after pushing the merged blob, it must pass
   `staging_hash = compute_staging_hash(merged)` (and a correct `seq`) so I3 holds on the claim path
   as well — not the P1 default `staging_hash=null`.

---

## Test Groups

### Group F — Mutation flow — 24 assertions

#### F-Python (F1–F8) — `domain/staging/service.py`
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `push_to_remote(mk)` pushes a remote cookie whose `staging_hash` equals `compute_staging_hash()` over the non-committed canonical rows of the entries just pushed to the blob | I3 — hash matches pushed blob | A reader that later compares digests must see the same hash the blob represents |
| F2 | `push_to_remote(mk)` derives the hash from canonical rows (`dtoToCanonicalRow` → filter `committed` → sort → SHA-256), not from raw/encrypted entries | key-independent digest (D8/V3) | Encrypted bytes hash non-deterministically; canonical plaintext is the only parity-safe representation |
| F3 | `push_to_remote(mk)` updates the local cookie: bumps `creation_time`, sets `last_seen_hash` = pushed hash, `last_seen_seq` = pushed seq, and KEEPS `device_specifier` | step-4 local-cookie update + I4 | The local baseline is what makes P3's cheap read gate correct |
| F4 | `push_to_remote(mk)` orders writes local-cookie → blob → remote-cookie (blob strictly before remote cookie) | I3 blob-before-cookie | A cookie (hash N) ahead of its blob (N-1) would serve a stale blob to a reader |
| F5 | remote cookie `seq` = `DeviceCookie.next_seq(last_seen_seq)` when the local cookie has no `last_seen_seq` (legacy/absent) → `1` | I8 increment base | Absent seq = legacy → first seq-carrying write is 1 |
| F6 | remote cookie `seq` = `last_seen_seq + 1` when the local cookie already has `last_seen_seq = N` | I8 monotonic | Sequential mutations must produce strictly increasing seq or the Worker CAS rejects them |
| F7 | `push_to_remote(mk)` with no remote transport → no-op; cookies untouched | unchanged local-only path | Local-only CLI must not fabricate remote cookies |
| F8 | blob push raises (offline) → the local cookie was already updated (step 4) and no exception propagates out of `push_to_remote` | I7 fail-open | Offline mutations persist locally and heal via merge on the next event |
| F9 | `_push_on_fast_path(local_cookie)` — when it pushes pending writes — also pushes a remote cookie carrying the recomputed `staging_hash` + bumped `seq` (not a specifier-less `push_blob_only`) | DS5 — every blob push carries a fresh hash | The fast path is the CLI's pending-write push; without the cookie update a peer never sees the change |

#### F-Web (F10–F17) — `phpoc-web/src/sync/sync.js`
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F10 | `pushToRemote(mk)` pushes a remote cookie whose `staging_hash` equals `computeStagingHash()` over the non-committed canonical rows of the entries just pushed | I3 — hash matches pushed blob | Mirrors F1 |
| F11 | `pushToRemote(mk)` derives the hash from canonical rows (`dtoToCanonicalRow` → filter `committed` → sort → SHA-256) | key-independent digest | Mirrors F2 |
| F12 | `pushToRemote(mk)` updates the local cookie: bump `creation_time`, set `last_seen_hash`/`last_seen_seq`, keep `device_specifier` | step-4 + I4 | Mirrors F3 |
| F13 | `pushToRemote(mk)` pushes the blob before the remote cookie (existing order preserved) | I3 blob-before-cookie | Mirrors F4 |
| F14 | `pushToRemote(mk)` remote cookie `seq` = `DeviceCookie.nextSeq(lastSeenSeq)`: absent → 1, N → N+1 | I8 increment base | Mirrors F5/F6 |
| F15 | `pushToRemote(mk)` reads the existing local cookie's `last_seen_seq` as the increment base (not resetting to 0) | I8 monotonic | Mirrors F6 |
| F16 | auto-sync mutation push (`_pushOnFastPath`) carries the recomputed `staging_hash` + `seq` into the remote cookie (not the cookie-less `pushBlobOnly` fast path) | DS5 | The auto-sync path is the Web mutation push; a peer must see the new hash |
| F17 | `_touchLocalCookie()` alone (a read/check tick) does **not** set `last_seen_hash`/`last_seen_seq` — only the mutation push path writes them | I4 reads never mutate baseline | Keeps the read fast-path from poisoning the hash baseline |

#### F-Flutter (F18–F24) — `phpoc-flutter/lib/data/sync/sync_service.dart`
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F18 | `pushToRemote()` pushes a remote cookie whose `staging_hash` equals `computeStagingHash()` over the non-committed canonical rows just pushed | I3 | Mirrors F1/F10 |
| F19 | `_pushCookie(deviceId)` computes `staging_hash` from the rows `_pushStagingRowsToRemote()` pushed and passes it (with `seq`) into the remote cookie | I3 hash matches blob | Flutter separates blob push (`_pushStagingRowsToRemote`) from cookie push (`_pushCookie`) |
| F20 | the hash input is the *same* row set that was pushed (`_rowIsCommitted`-filtered `activeRows`), so no `activity.committed`-only row is hashed but not pushed | I3 consistency | Flutter's `_rowIsCommitted` checks both flags; `computeStagingHash` only the top-level one |
| F21 | `_pushCookie(deviceId)` updates the local cookie: bump `creation_time`, set `last_seen_hash`/`last_seen_seq`, keep `device_specifier` | step-4 + I4 | Mirrors F3/F12 |
| F22 | remote cookie `seq` = `DeviceCookie.nextSeq(lastSeenSeq)`: absent → 1, N → N+1 | I8 increment base | Mirrors F5/F14 |
| F23 | `pushToRemote()` pushes the blob (`_pushStagingRowsToRemote`) before the cookie (`_pushCookie`) | I3 blob-before-cookie | Mirrors F4/F13 |
| F24 | offline blob-push failure → the local mutation + local-cookie update persist; no unhandled error escapes | I7 fail-open | Mirrors F8 |

### Group H — Specifier stability (I5) — 4 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Python: two consecutive `push_to_remote(mk)` calls on the same device leave `device_specifier` identical in both the local and remote cookies (only `creation_time`/`last_seen_hash`/`last_seen_seq` change) | I5 same-device stability | Prevents per-mutation specifier churn (ADR-034 consequence) |
| H2 | Python: `_reconcile_and_claim(mk)` (ownership handoff) regenerates the `device_specifier` (fresh local + remote cookie) | I5 — regenerated only on handoff | Handoff is the one place ownership legitimately moves |
| H3 | Web: `pushToRemote(mk)` reuses the existing `device_specifier` across same-device mutations; `_reconcileAndClaim(mk)` generates a fresh one | I5 | Verify-and-keep the existing Web reuse + handoff-regen |
| H4 | Flutter: `_pushCookie(deviceId)` reuses the existing `device_specifier` across same-device mutations; `_reconcileAndClaimRowLevel()` generates a fresh one | I5 | Verify-and-keep the existing Flutter reuse + handoff-regen |

---

## Deferred (out of P2 scope)

- **Group G — read-flow hash gate** (equal → skip blob; different → pull+merge; missing → full
  pull+merge) is **P3**, per `STAGING_CHANGE_DETECTION_PLAN.md` §10 step 4. P2 only makes mutations
  *write* the hash; it does not yet *read* it to short-circuit the blob pull.
- **Group I — polling removal + hash unification** (retire Flutter 5 s timer / CLI 60 s poll / F3
  `.last_push_hash` / Web encrypted-index SHA) is **P4**.
- Live Worker CAS E2E (group J live) remains deferred to P5.

---

## Implementation map (Phase 3 preview)

| Client | File | Change |
|--------|------|--------|
| Python | `domain/staging/service.py` | import `compute_staging_hash`; `push_to_remote()` → compute canonical hash + `next_seq`, write local cookie (keep specifier), push blob, push remote cookie `{device_uuid, specifier, staging_hash, seq}`; `_push_on_fast_path()` → same hash+seq cookie push; `_reconcile_and_claim()` → pass merged-hash + seq into `DeviceCookie.create` |
| Web | `phpoc-web/src/sync/sync.js` | import `computeStagingHash`; `pushToRemote()` → hash + `nextSeq` + local-cookie update + remote cookie `{staging_hash, seq}`; `_pushOnFastPath()` → same; `_reconcileAndClaim()` → pass merged-hash + seq |
| Flutter | `phpoc-flutter/lib/data/sync/sync_service.dart` | `_pushCookie()` → `computeStagingHash` + `nextSeq` + local-cookie update + remote cookie `{staging_hash, seq}`; `_reconcileAndClaimRowLevel()` → same on handoff |

## Test file map (Phase 2 preview)

- Python: `tests/test_staging_mutation_wiring.py` (F1–F9 + H1–H2) — hermetic, fake transport.
- Web: `phpoc-web/test/staging_mutation_wiring.mjs` (F10–F17 + H3) — hermetic, fake transport/storage.
- Flutter: `phpoc-flutter/test/data/sync/staging_mutation_wiring_test.dart` (F18–F24 + H4) — hermetic, fake transport/storage.

## Verification

- `PYTHONPATH=. .venv/bin/python -m pytest tests/test_staging_mutation_wiring.py -v`
- `node --test phpoc-web/test/staging_mutation_wiring.mjs`
- `cd phpoc-flutter && flutter test test/data/sync/staging_mutation_wiring_test.dart`
