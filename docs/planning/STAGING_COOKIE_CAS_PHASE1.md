# Staging Cookie Schema + Worker CAS (ADR-034 P1) — Test Exploration (Phase 1)

> **Plan:** `STAGING_CHANGE_DETECTION_PLAN.md` §10 step 2 (P1) + `../design/STAGING_CHANGE_DETECTION_DESIGN.md` §3/§3a
> **Purpose:** Blueprint of all test assertions needed for the P1 go/no-go gate — the cookie
> schema migration (`staging_hash` + `seq` remote; `last_seen_hash` + `last_seen_seq` local)
> with backward-compat parse tolerance (Group E) and the Worker stale-write CAS guard (Group J).
> **Status:** ✅ Phase 4 (REFACTOR) — all 30 assertions GREEN (hermetic); live J6–J10 deferred (Worker deploy)
> **Next Phase:** P2 (mutation/read wiring) — per `STAGING_CHANGE_DETECTION_PLAN.md` §10

---

## Architecture Overview

P0 already landed `compute_staging_hash` / `computeStagingHash` (byte-identical across Python /
Web / Flutter) and proved the digest is stable. P1 migrates the **device cookie** so that hash —
and a new `seq` write-arbitration counter — actually ride the cookie, and adds the **only
Worker-side change** in the whole ADR-034 plan: a stale-write CAS guard.

```
Remote cookie (staging/blobs/device_cookie.bin) — unencrypted, ~200 B:
  { "device_uuid": "<UUID>-<client>", "device_specifier": "<32-hex>",
    "staging_hash": "<64-hex>|null", "seq": <int> }

Local cookie (device_cookie.meta / storage 'cookie'):
  { "device_specifier": "<32-hex>", "creation_time": <epoch_ms>,
    "last_seen_hash": "<64-hex>|null", "last_seen_seq": <int> }
```

`staging_hash` = "has remote staging content changed since I last looked?" (read fast-path);
`seq` = "which write is current?" (race protection). Both are **optional/absent for old clients**
(D9): absent `staging_hash` → treat as "unknown" (never "unchanged"); absent `seq` → treat as 0.

### The CAS rule (ADR-034 §3a / I8)

```
isStaleWrite(incomingSeq, storedSeq):
  incomingSeq absent  → false   (legacy client — last-write-wins, D9)
  storedSeq   absent  → false   (nothing to beat — accept)
  incomingSeq <= storedSeq → true   (409)
  incomingSeq >  storedSeq → false  (accept)
```

The Worker applies this **only** to the device-cookie PUT path; every other blob PUT stays a
blind pass-through (the Worker remains "no knowledge of blob format" except for one known
cookie field).

---

## Key decisions (locked in Phase 1, confirmable in Phase 3)

1. **Initial values on `create()`:** a fresh cookie writes `staging_hash = null` (no rows
   hashed yet — the mutation flow fills it in P2) and `seq = 0` ("absent → 0"). The first
   mutation/claim write bumps to `seq = 1` via `last_seen_seq + 1`.
2. **`create()` signature:** gains optional `staging_hash` (default `null`) and `seq`
   (default `0`) params so a caller that just pushed a blob can pass the real hash.
3. **Local cookie keys are snake_case everywhere** (`last_seen_hash` / `last_seen_seq`),
   matching the existing `creation_time`. The Dart *model*
   (`lib/core/models/device_cookie.dart`) uses camelCase **Dart fields** but snake_case **JSON
   keys** — same convention it already uses for `device_uuid`/`creation_time`.
4. **Worker path detection is a suffix match** on `staging/blobs/device_cookie.bin` (so the
   live test prefix `_vitest_…/staging/blobs/device_cookie.bin` also triggers the guard).
5. **Unparseable cookie body = legacy:** if the Worker can't read a numeric `seq` from the PUT
   body (malformed JSON / missing field), it treats the write as legacy (accept, 200) — never
   breaks a broken-but-previously-working client.
6. **`409` body shape** mirrors the existing row-level stale guard in `row_level_staging.ts`:
   `{"error": "Conflict: …"}`.

---

## Test Groups

### Group E — Cookie schema + backward-compat parse tolerance — 17 assertions

#### E-Python (E1–E6)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `DeviceCookie.create(device_id, data_dir)` writes remote `{device_uuid, device_specifier, staging_hash, seq}` **and** local `{device_specifier, creation_time, last_seen_hash, last_seen_seq}` | Full 4+4-field schema | Locks the exact cookie shape all three clients converge on |
| E2 | `create()` defaults `staging_hash` to `null` and `seq` to `0` when not passed; honors explicit values | Initial-value contract | Fresh cookie = "unknown hash, seq 0" (decision 1) |
| E3 | `create_local()` writes `last_seen_hash` + `last_seen_seq` (defaults null/0) alongside `device_specifier` + `creation_time` | Local-only path parity | `create_local` is the no-transport TTL path; must carry the baseline too |
| E4 | `is_valid_locally()` returns the dict **including** `last_seen_hash` + `last_seen_seq` (not stripped) | Baseline preservation | The read fast-path compares against these; dropping them defeats P3 |
| E5 | `parse_remote()` on a legacy cookie (only `device_uuid`/`device_specifier`) returns the dict with `staging_hash`/`seq` absent — no fabrication, no exception | Backward compat (D9) | Old clients still own the remote cookie mid-migration |
| E6 | `parse_remote()` on a full cookie returns `staging_hash` + `seq` verbatim; invalid bytes → `None` (unchanged) | Presence + robustness | Full cookie round-trips; no new crash paths |

#### E-Web (E7–E11)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E7 | `DeviceCookie.create(deviceId, storage, crypto)` writes remote 4 fields + local 4 fields | Full schema | Mirrors E1 |
| E8 | `create()` defaults `staging_hash: null`, `seq: 0`; honors explicit | Initial values | Mirrors E2 |
| E9 | `isValidLocally()` returns the object including `last_seen_hash` + `last_seen_seq` | Baseline preservation | Mirrors E4 |
| E10 | `parseRemote()` legacy → absent fields tolerated (no throw, no fabrication) | Backward compat | Mirrors E5 |
| E11 | `parseRemote()` full → fields verbatim; invalid bytes → `null` | Presence + robustness | Mirrors E6 |

#### E-Flutter (E12–E17)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E12 | `DeviceCookie.create(deviceId, storage)` writes remote 4 fields + local 4 fields | Full schema | Mirrors E1 |
| E13 | `isValidLocally()` returns the map **including** `last_seen_hash` + `last_seen_seq` (today it strips to `{device_specifier, creation_time}` — behavior change) | Baseline preservation | Flutter is the one client that currently drops extra keys |
| E14 | `parseRemote()` legacy → absent fields tolerated (no throw, no fabrication) | Backward compat | Mirrors E5 |
| E15 | `parseRemote()` full → fields verbatim; invalid bytes → `null` | Presence + robustness | Mirrors E6 |
| E16 | Model `DeviceCookie.toJson()`/`fromJson()` round-trip `stagingHash`/`seq`/`lastSeenHash`/`lastSeenSeq` | Second Dart cookie type | `lib/core/models/device_cookie.dart` is used for state, must carry the fields |
| E17 | Model `fromJson()` tolerates absent new fields (defaults null/0) | Backward compat | Old persisted cookies / old remote JSON must still parse |

### Group J — `seq` + Worker CAS — 13 assertions

#### J-CAS pure rule (hermetic, J1–J5)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `isStaleWrite(incomingSeq=undefined, storedSeq)` → `false` | Legacy incoming accepted | D9: CAS applies only when incoming carries `seq` |
| J2 | `isStaleWrite(incomingSeq, storedSeq=undefined)` → `false` | No stored seq to beat | First `seq`-carrying write always accepted |
| J3 | `isStaleWrite(incomingSeq < storedSeq)` → `true` | Reject stale write | A racing peer's late PUT must not clobber |
| J4 | `isStaleWrite(incomingSeq == storedSeq)` → `true` | Reject equal | `<=` boundary — replay/duplicate write rejected |
| J5 | `isStaleWrite(incomingSeq > storedSeq)` → `false` | Accept newer | Monotonic forward progress |

#### J-Worker route (live, J6–J10)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J6 | PUT cookie `seq=5` then `seq=6` → both `200` | Monotonic accept | Happy path round-trip |
| J7 | PUT cookie `seq=5` then `seq=5` (and `seq=4`) → `409` | Stale rejection | The CAS guard is actually wired in the route |
| J8 | PUT legacy cookie (no `seq`) **after** a `seq=5` cookie → `200` (last-write-wins) | D9 legacy path | Old clients are never broken mid-migration |
| J9 | PUT a non-cookie blob (e.g. `staging/blob`) → always `200`, no CAS | Scoped guard | Worker stays blind except the one cookie field |
| J10 | PUT cookie with malformed JSON body → `200` (treated as legacy) | Robustness | Decision 5 — broken body never 409s |

#### J-client seq bump (hermetic, J11–J13)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J11 | Python `next_seq(last_seen_seq)`: `None` → `1`; `N` → `N+1` | Increment base | `last_seen_seq + 1` with absent→0, shared by create/mutation |
| J12 | Web `nextSeq(lastSeenSeq)`: `null/undefined` → `1`; `N` → `N+1` | Increment base | Mirrors J11 |
| J13 | Flutter `nextSeq(lastSeenSeq)`: `null` → `1`; `N` → `N+1` | Increment base | Mirrors J11 |

---

## Implementation map (Phase 3 preview)

| Client | File | Add |
|--------|------|-----|
| Python | `domain/cookie/device_cookie.py` | `create(..., staging_hash=None, seq=0)`, `create_local(..., last_seen_hash=None, last_seen_seq=0)`, `is_valid_locally()` returns full dict, `parse_remote()` tolerates absent fields, static `next_seq()` |
| Web | `phpoc-web/src/sync/cookie.js` | `create(..., {stagingHash=null, seq=0})`, `isValidLocally()` returns full object, `parseRemote()` tolerates absent, `nextSeq()` |
| Flutter | `phpoc-flutter/lib/data/sync/device_cookie.dart` | `create()`/`isValidLocally()`/`parseRemote()` + `nextSeq()` (snake_case storage keys) |
| Flutter | `phpoc-flutter/lib/core/models/device_cookie.dart` | add `stagingHash`/`seq`/`lastSeenHash`/`lastSeenSeq` to `toJson`/`fromJson` (camelCase fields, snake_case JSON, absent-tolerant) |
| Worker | `worker/src/index.ts` (or new `cookie_cas.ts`) | export pure `isStaleWrite()`; suffix-match cookie path in `handlePut` → parse `seq` → `409` on stale |

## Test file map (Phase 2 preview)

- Python: `tests/test_staging_cookie_cas.py` (Groups E-Python + J11)
- Web: `phpoc-web/test/staging_cookie_cas.mjs` (Groups E-Web + J12)
- Flutter: `phpoc-flutter/test/data/sync/device_cookie_test.dart` (extend, Groups E-Flutter + J13) +
  `phpoc-flutter/test/core/models/device_cookie_test.dart` (extend, E16/E17)
- Worker (hermetic): `worker/test/cookie_cas.test.ts` — unit-test `isStaleWrite` (J1–J5), no network
- Worker (live): extend `worker/test/index.test.ts` (or `worker/test/cookie_cas_live.test.ts`) — J6–J10 against the deployed test Worker

## Verification

- `PYTHONPATH=. .venv/bin/python -m pytest tests/test_staging_cookie_cas.py -v`
- `node --test phpoc-web/test/staging_cookie_cas.mjs`
- `cd phpoc-flutter && flutter test test/data/sync/device_cookie_test.dart test/core/models/device_cookie_test.dart`
- `cd worker && npx vitest run test/cookie_cas.test.ts` (hermetic) + `PHPOC_API_KEY=… npx vitest run test/index.test.ts` (live, after `npx wrangler deploy -c wrangler.testing.toml`)
