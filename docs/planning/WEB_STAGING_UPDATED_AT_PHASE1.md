# Web Staging `updated_at` Persistence (Option A) — Test Exploration (Phase 1)

> **Plan:** Fixes `cross_client_web_test.mjs` 2.4c (cross-device end propagation). Spec: PHPSPEC §8.1 (`updated_at` is ✅ required), §8.5 (LWW, local-wins-on-tie).
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phases 1–4 complete (2026-09-03)
> **Next Phase:** — (done)

## Architecture Overview

The web has two staging representations that meet in `SyncService._mergeRemoteIntoLocal`:

1. **Legacy `LocalCache`** (`entries` key → `{hash, data, committed, block_index}`) — the authoritative
   CRUD/DTO store used by `capture`/`end`/`pause`/`unpause` and the CLI cross-client path.
2. **Canonical `RowStagingStore`** (`staging:row:*` → `{activity_id, activity_status, activity, updated_at}`)
   — used by the row-level reconcile path; already persists `updated_at`.

**Root cause.** The legacy path never persists `updated_at`:
- `LocalCache.append()` writes no `updated_at`; `_rawToDto()`/`_dtoToRaw()` drop it; `update()`/`addPause()`/
  `closePause()` never bump it.
- `dtoToCanonicalRow(e, deviceId, now)` therefore falls back to `updated_at: e.updated_at ?? now`, and
  `_mergeRemoteIntoLocal` calls it with the **same** `Date.now()` for both local and remote legacy rows.
- Result: every local↔legacy-remote comparison is an artificial **tie**, and §8.5 "local wins on tie"
  silently keeps the local `active` copy — masking the remote `ended` state (2.4c). This also violates
  §8.1, which marks `updated_at` required.

**Fix (Option A).** Persist `updated_at` through the legacy path so LWW sees real timestamps:

| # | Change | File |
|---|--------|------|
| 1 | `append()` sets `raw.updated_at = now` (wrapper level, **not** inside hashed `data`) | `local_cache.js` |
| 2 | `update()`, `addPause()`, `closePause()` bump `raw.updated_at = now` | `local_cache.js` |
| 3 | `_rawToDto()` emits `updated_at`; missing → backfill `start_epoch` (deterministic, never `Date.now()`) | `local_cache.js` |
| 4 | `_dtoToRaw()` persists `updated_at` | `local_cache.js` |
| 5 | `markCommitted()` leaves `updated_at` untouched | `local_cache.js` |
| 6 | Add `options.now` clock-injection seam (defaults `Date.now`) for deterministic tests | `local_cache.js` |
| 7 | `canonicalRowToDTO()` emits `updated_at: row.updated_at` | `entry_dto.js` |
| 8 | `rawEntryToDTO()` emits `updated_at` when the raw legacy entry carries it (forward-compat) | `entry_dto.js` |

`dtoToCanonicalRow` / `_rowsFromRemoteBlob` keep their `?? now` fallback — still needed for legacy remote
blobs that genuinely lack a per-entry timestamp (that fallback is what lets a stopped legacy remote win in
2.4c: remote `now` > local capture time).

**Out of scope (separate decision, later):** Flutter's *terminal-state rule* ("ended beats active regardless
of `updated_at`") is **not** part of Option A. Option A fixes the tie by fixing timestamps; the
"resume-after-end re-open" edge case and the §8.5-vs-Flutter wording question remain open (Option B/C).

## Test Groups

### Group A: capture persists `updated_at` (LocalCache unit) — 4
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `append()` stores a numeric `updated_at` on the raw entry wrapper | Capture writes the LWW timestamp | Without it the raw entry has no modification timestamp (§8.1 violation) |
| A2 | `append()`'s `updated_at` equals the injected clock (`options.now`), **not** `start_epoch` | Timestamp reflects *modification* time, decoupled from a back-dated task start | LWW must order by when the row changed, not when the activity logically began |
| A3 | `readEntries()` DTO exposes `updated_at` equal to the stored raw value | Read path round-trips the timestamp | `dtoToCanonicalRow` needs the real value, not a backfill |
| A4 | `writeEntries(dtos)` → `readEntries()` round-trips an explicit DTO `updated_at` | Write path persists the timestamp | `_mergeRemoteIntoLocal` writes merged DTOs back; the timestamp must survive |

### Group B: mutation bumps `updated_at` (LocalCache unit) — 5
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `update()` (e.g. end/edit) bumps `updated_at` to the current clock | Status/data change updates LWW | §8.1: "updated on any status change or data modification" |
| B2 | `addPause()` bumps `updated_at` | Pause is a status change | Same as B1 |
| B3 | `closePause()` bumps `updated_at` | Unpause is a status change | Same as B1 |
| B4 | `markCommitted()` does **not** change `updated_at` (🟢 guard) | Committed flag is orthogonal to LWW | `committed` is handled by merge's irreversible-committed rule, not the timestamp |
| B5 | `append()` stores `updated_at` on the wrapper (sibling of `hash`), **not** inside the hashed `data` | Timestamp is metadata, not content | If `updated_at` were inside `data`, every bump would change the content hash and break hash-based dedup/verification |

### Group C: backward-compat fallback (LocalCache unit) — 2
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `_rawToDto` backfills a missing `updated_at` to `start_epoch` (deterministic), never `Date.now()` | Pre-existing entries read with a stable timestamp | A stale entry must not look "newest" — that would re-create the tie bug |
| C2 | A legacy-format raw entry (no `updated_at` key) still reads all fields correctly with `updated_at === start_epoch` | Old on-disk entries are readable | Migration safety for users with existing staging data |

### Group D: canonical/legacy DTO bridge (entry_dto unit) — 2
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `canonicalRowToDTO(row)` emits `updated_at: row.updated_at` | Remote-won merges preserve the winning timestamp | `_mergeRemoteIntoLocal` rebuilds DTOs via `canonicalRowToDTO`; dropping the timestamp re-introduces the backfill tie on the *next* merge |
| D2 | `rawEntryToDTO(rawEntry)` emits `updated_at` when the raw legacy entry carries it | Forward-compat with updated legacy blobs | Once other clients attach per-entry timestamps, the web must honor them |

### Group E: push path carries persisted `updated_at` (SyncService integration) — 1
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | After `capture` + `pushToRemote`, the pushed canonical row's `updated_at` equals the locally-persisted value (not a fresh push-time `now`) | Local's real timestamp propagates to peers | The other device's LWW depends on receiving the true local timestamp, not push-time noise |

## Acceptance Regressions (existing tests — no new code)

| Test | Expected after Phase 3 | Why |
|------|------------------------|-----|
| `cross_client_web_test.mjs` **2.4c** (local active + legacy-remote ended) | 🔴 → 🟢 GREEN | Remote legacy backfills `now` > local capture time → `ended` wins |
| `ccs2_row_level_reconcile_test.mjs` **A4** (local active + remote ended, equal `updated_at`) | 🟢 stays GREEN | Local now persists its timestamp; the test reads it back → genuine tie → local wins (correctly, no longer a backfill race) |
| All other `cross_client` / `ccs2` / `sync_service` / `unlock` suites | 🟢 stay GREEN | No behavior change to merge semantics; only timestamps become real |

## Summary

- **New assertions:** 14 (Group A 4 · B 5 · C 2 · D 2 · E 1)
- **Expected RED in Phase 2:** 13 (all except B4, which is a guard)
- **Guards:** B4 (1)
- **Acceptance flips:** 1 existing test RED→GREEN (2.4c); 1 stays GREEN (ccs2 A4)
- **Source files to change (Phase 3):** `phpoc-web/src/sync/local_cache.js`, `phpoc-web/src/sync/entry_dto.js`
- **Test files to create (Phase 2):** `phpoc-web/test/local_cache_updated_at_test.mjs` (Groups A–C),
  `phpoc-web/test/entry_dto_updated_at_test.mjs` (Group D), `phpoc-web/test/sync_push_updated_at_test.mjs` (Group E)
