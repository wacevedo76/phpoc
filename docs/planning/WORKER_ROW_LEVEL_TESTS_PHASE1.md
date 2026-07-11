# Worker Row-Level Endpoints — Phase 1 Test Exploration

> **Status:** 🔜 Phase 1 complete — to be used in Phase 2 (RED)
> **Date:** 2026-07-11
> **Purpose:** Temporary reference document listing every test assertion needed for full coverage of the 4 new Worker endpoints. Used as the blueprint for Phase 2 test creation.

## New Endpoints Under Test

| Method | Path | Success | Error |
|--------|------|---------|-------|
| GET | `/storage/staging/manifest` | 200 + JSON | — |
| GET | `/storage/staging/rows/{activity_id}` | 200 + JSON | 404 |
| PUT | `/storage/staging/rows/{activity_id}` | 200 | 400, 409 |
| DELETE | `/storage/staging/rows/{activity_id}` | 200 | 400, 404 |

These replace the current monolithic `GET/PUT /{path}` blob endpoints for staging data.

---

## Group M: Manifest Endpoint (`GET /storage/staging/manifest`)

### M1: Returns 200 with correct Content-Type
**Assertion:** `GET /storage/staging/manifest` returns status 200 with `Content-Type: application/json`.
**Purpose:** Ensures the manifest endpoint is reachable and returns proper HTTP semantics. Clients parse JSON responses.

### M2: Returns correct JSON structure
**Assertion:** Response body is a JSON object with keys `rows` (array) and `version` (number).
**Purpose:** Contract compliance. Every client expects this exact shape. Missing or extra fields break deserialization.

### M3: Empty manifest returns `{rows: [], version: 0}`
**Assertion:** When no rows have been created, the manifest returns an empty rows array and version 0.
**Purpose:** Clean initial state. Clients use this to detect "fresh start" — nothing to sync.

### M4: Row objects have required fields
**Assertion:** Each element in `rows` has `activity_id` (string), `activity_status` (string), and `updated_at` (number).
**Purpose:** Schema contract. Missing fields cause client-side deserialization failures. The `activity` blob is NOT in the manifest — it's fetched per-row.

### M5: Version increments on row creation
**Assertion:** After PUTing a new row, the manifest `version` is greater than before the PUT.
**Purpose:** Monotonic version enables future etag/conditional-request optimizations. Must be reliably increasing.

### M6: Version increments on row update
**Assertion:** After updating an existing row's `updated_at`, the manifest `version` is greater than before.
**Purpose:** Same as M5 — updates count as manifest mutations.

### M7: Version increments on row deletion
**Assertion:** After DELETEing a row, the manifest `version` is greater than before.
**Purpose:** Deletes are also manifest mutations. A row disappearing must bump the version.

### M8: Manifest reflects row creation
**Assertion:** After PUTing a row, that row's `activity_id`, `activity_status`, and `updated_at` appear in the manifest.
**Purpose:** The manifest is the source of truth for diffing. If rows don't appear, clients can't detect them.

### M9: Manifest reflects row update
**Assertion:** After updating a row (newer `updated_at`), the manifest shows the new `updated_at`.
**Purpose:** Diff detection depends on accurate `updated_at` in the manifest. Stale values cause incorrect LWW resolution.

### M10: Manifest reflects row deletion
**Assertion:** After DELETEing a row, that `activity_id` no longer appears in the manifest.
**Purpose:** Deleted rows must vanish from the manifest. If they linger, clients will try to pull them (and get 404).

### M11: Manifest is always reachable (no 404 for empty)
**Assertion:** `GET /storage/staging/manifest` never returns 404, even when no manifest file exists yet.
**Purpose:** Robustness. An empty staging area is a valid state, not an error. The manifest endpoint should always respond 200.

---

## Group R: Row CRUD Endpoints

### R1: GET existing row returns 200
**Assertion:** After PUTing a row, `GET /storage/staging/rows/{activity_id}` returns 200.
**Purpose:** Basic happy path. The row endpoint must serve stored data.

### R2: GET row returns correct JSON structure
**Assertion:** Response has `activity_id` (string), `activity_status` (string), `activity` (string), and `updated_at` (number).
**Purpose:** Contract compliance. The full row object is the unit of sync. All four fields are required.

### R3: GET row returns the exact data that was PUT
**Assertion:** A PUT-then-GET round-trip preserves all four fields exactly as written.
**Purpose:** Data integrity. The Worker must not mutate, reorder, or add fields to stored rows.

### R4: GET nonexistent row returns 404
**Assertion:** `GET /storage/staging/rows/nonexistent` returns 404.
**Purpose:** Clear signal to clients that this row doesn't exist (e.g., was deleted between manifest fetch and row pull).

### R5: PUT returns 200 on success
**Assertion:** PUTing a valid row body returns 200.
**Purpose:** Happy path acknowledgment. Clients need to know the write was accepted.

### R6: PUT requires JSON Content-Type
**Assertion:** PUTing with `Content-Type: text/plain` returns 400.
**Purpose:** Input validation. The Worker should reject non-JSON payloads with a clear error code.

### R7: PUT with missing activity_id returns 400
**Assertion:** PUT body missing `activity_id` field returns 400.
**Purpose:** Validation. `activity_id` is the primary key — it's mandatory.

### R8: PUT with missing activity_status returns 400
**Assertion:** PUT body missing `activity_status` field returns 400.
**Purpose:** Validation. The manifest exposes `activity_status` in plaintext; it must be present.

### R9: PUT with missing activity returns 400
**Assertion:** PUT body missing `activity` field returns 400.
**Purpose:** Validation. The `activity` field carries the obfuscated entry blob — it's the payload.

### R10: PUT with missing updated_at returns 400
**Assertion:** PUT body missing `updated_at` field returns 400.
**Purpose:** Validation. `updated_at` is the version signal for the push guard — mandatory.

### R11: PUT with invalid activity_id format returns 400
**Assertion:** PUTing with `activity_id` longer than 20 chars or containing non-alphanumeric chars returns 400.
**Rationale:** Activity IDs are 10-char CSPRNG alphanumeric. Defensive validation prevents injection/storage attacks.

### R12: PUT with path traversal in activity_id returns 400
**Assertion:** PUTing with `activity_id` containing `../` or `/` returns 400.
**Purpose:** Security. Activity IDs become part of R2 keys. Path traversal could overwrite non-row storage.

### R13: PUT with invalid activity_status returns 400
**Assertion:** PUTing with `activity_status` not in `["staged", "active", "paused"]` returns 400.
**Purpose:** Domain validation. Only these three statuses are valid. Arbitrary strings would break client logic.

### R14: PUT with non-numeric updated_at returns 400
**Assertion:** PUTing with `updated_at` as a string or float returns 400.
**Purpose:** Type validation. `updated_at` must be an integer for push guard comparison.

### R15: PUT with negative updated_at returns 400
**Assertion:** PUTing with `updated_at: -1` returns 400.
**Purpose:** Domain validation. Timestamps are Unix epoch milliseconds; negative values are invalid.

### R16: PUT with empty activity string returns 400
**Assertion:** PUTing with `activity: ""` returns 400.
**Purpose:** Domain validation. An empty activity blob is a data error — there should be an obfuscated entry body.

### R17: DELETE existing row returns 200
**Assertion:** After PUTing a row, DELETEing it returns 200.
**Purpose:** Happy path. The delete endpoint must work.

### R18: DELETE nonexistent row returns 404
**Assertion:** DELETEing a row that was never created returns 404.
**Purpose:** Clear signal to clients. Deleting a phantom row should not silently succeed.

### R19: DELETE removes row from manifest
**Assertion:** After DELETE, the row's `activity_id` no longer appears in the manifest.
**Purpose:** Consistency. If the manifest still lists a deleted row, clients will try to pull it.

### R20: DELETE then GET returns 404
**Assertion:** After PUT → DELETE → GET, the GET returns 404.
**Purpose:** DELETE is durable. The row must actually be gone.

### R21: Multiple rows with different activity_ids are independent
**Assertion:** PUT row A, PUT row B, DELETE row A → row B is still retrievable.
**Purpose:** Isolation. Rows must not interfere with each other. Deleting one must not cascade.

### R22: PUT row with extra fields preserves them
**Assertion:** PUTing a body with extra fields (e.g., `{activity_id, activity_status, activity, updated_at, extra: "hi"}`) — the extra field is preserved on GET.
**Rationale:** The Worker is a pass-through store for row data. It should not strip unknown fields. However, this is debatable — strict validation might reject extra fields. **Decision: allow extra fields** to maintain forward compatibility (future fields added by newer clients). The Worker validates required fields but is lenient with unknown ones.

---

## Group P: Push Guard (`PUT 409 Conflict`)

### P1: First PUT always succeeds
**Assertion:** PUTing a new row (no existing row with that activity_id) succeeds regardless of `updated_at` value.
**Purpose:** No guard when no conflict exists. The push guard only applies to updates.

### P2: PUT with newer updated_at succeeds
**Assertion:** PUT row with `updated_at: 100` → PUT again with `updated_at: 200` → 200.
**Purpose:** Normal update. Newer timestamps always win.

### P3: PUT with same updated_at returns 409
**Assertion:** PUT row with `updated_at: 100` → PUT again with `updated_at: 100` → 409.
**Purpose:** Idempotency guard. The same `updated_at` means no change or a race duplicate — reject it.

### P4: PUT with older updated_at returns 409
**Assertion:** PUT row with `updated_at: 200` → PUT again with `updated_at: 100` → 409.
**Purpose:** Core push guard. Older writes must not overwrite newer data. This prevents the worst transport race.

### P5: 409 response has CORS headers
**Assertion:** 409 response includes `Access-Control-Allow-Origin: *`.
**Purpose:** Browser clients must be able to read the 409 status code. Without CORS, the browser blocks the response.

### P6: After 409, row data is unchanged
**Assertion:** PUT v1 → PUT v2 (newer, succeeds) → PUT v1 (older, 409) → GET returns v2 data.
**Purpose:** The guard must actually protect data. A 409 that still wrote the old data is a broken guard.

### P7: 409 response body indicates conflict
**Assertion:** 409 response body is a JSON object with an error message, not empty.
**Purpose:** Clients log/report errors. A meaningful body helps debugging.

### P8: Consecutive PUTs with increasing updated_at all succeed
**Assertion:** PUT(100) → PUT(200) → PUT(300) → all 200.
**Purpose:** Monotonic updates should never falsely trigger the guard. Regression test.

### P9: Manifest version does NOT increment on 409
**Assertion:** PUT(100) → version V1. PUT(100 again) → 409. Manifest version is still V1.
**Purpose:** Failed writes are not mutations. The manifest version should only increment on actual state changes.

### P10: Push guard uses numeric comparison, not string
**Assertion:** PUT with `updated_at: 9` then PUT with `updated_at: 10` succeeds (10 > 9 numerically). Also test that `"9"` (string) is rejected by validation.
**Purpose:** String comparison of numbers is bug-prone (`"10" < "9"` lexicographically). The guard must use numeric comparison.

---

## Group A: Auth & CORS for New Endpoints

### A1: Manifest requires API key
**Assertion:** `GET /storage/staging/manifest` without `X-Api-Key` header returns 403.
**Purpose:** All storage endpoints must be authenticated. The manifest exposes plaintext `activity_status` — still needs auth.

### A2: Row GET requires API key
**Assertion:** `GET /storage/staging/rows/someid` without `X-Api-Key` header returns 403.
**Purpose:** Row data is obfuscated but auth is still required as a defense-in-depth layer.

### A3: Row PUT requires API key
**Assertion:** `PUT /storage/staging/rows/someid` without `X-Api-Key` header returns 403.
**Purpose:** Unauthenticated writes would allow data pollution/DoS.

### A4: Row DELETE requires API key
**Assertion:** `DELETE /storage/staging/rows/someid` without `X-Api-Key` header returns 403.
**Purpose:** Unauthenticated deletes would be destructive.

### A5: 409 response has CORS headers
**Assertion:** 409 response includes `Access-Control-Allow-Origin: *`.
**Purpose:** Already listed as P5, but included here to ensure CORS test coverage is complete for all new status codes that the new endpoints emit (200, 400, 403, 404, 409).

### A6: 400 response has CORS headers
**Assertion:** 400 response (from invalid PUT body) includes `Access-Control-Allow-Origin: *`.
**Purpose:** Browser clients must be able to read validation error bodies.

---

## Group E: Edge Cases & Integration

### E1: Manifest consistency after rapid PUT/DELETE sequence
**Assertion:** PUT A, PUT B, DELETE A, PUT C → manifest has {B, C} with correct status/timestamps.
**Purpose:** Stress test for manifest update logic. Rapid mutations should not cause stale or duplicate manifest entries.

### E2: Row with special characters in activity blob round-trips
**Assertion:** PUT row with `activity` containing JSON special chars (quotes, backslashes, null bytes), GET returns exact same string.
**Purpose:** The `activity` field carries obfuscated binary data (base64-encoded). Special characters must not be mangled.

### E3: GET row with URL-safe activity_id containing hyphens
**Assertion:** PUT row with `activity_id: "AbC3-XyZ7"` → GET returns 200 with correct data.
**Rationale:** The ROW_LEVEL_STAGING_SYNC_PLAN.md says IDs are "10-char CSPRNG alphanumeric" which implies `[A-Za-z0-9]`. But if hyphens are ever allowed, the URL routing must not break. **Decision: for now, validate activity_id as alphanumeric only (no hyphens). This test is noted but may be excluded.**

### E4: Concurrent PUTs to different rows are safe
**Assertion:** PUT row A and PUT row B concurrently → both succeed, manifest has both.
**Purpose:** Worker handles parallel writes without data corruption. R2 is eventually consistent but per-key writes are atomic.

### E5: Large activity blob (512KB) PUT + GET succeeds
**Assertion:** PUT row with 512KB `activity` string → 200, GET returns correct data.
**Purpose:** Staging blobs can be up to 512KB (tier 4 padding). The row endpoint must handle large payloads.

---

## Summary: Test Count by Group

| Group | Tests | Rationale |
|-------|-------|-----------|
| M — Manifest | 11 | Format contract, version monotonicity, CRUD reflection |
| R — Row CRUD | 22 | Happy path, validation, error handling, data integrity |
| P — Push Guard | 10 | LWW enforcement, 409 semantics, idempotency |
| A — Auth & CORS | 6 | Defense-in-depth, browser compatibility |
| E — Edge Cases | 5 | Concurrency, large payloads, special chars |
| **Total** | **54** | Full coverage for 4 new endpoints |

## Test Environment Notes

- Tests hit the **live test Worker** at `https://phpoc-staging-testing.wacevedo.workers.dev`
- Test data is scoped to a unique prefix per run (`_vitest_${timestamp}_${random}/`)
- Cleanup deletes all test objects after suite runs
- Before Phase 3 implementation, all new-endpoint tests will fail (RED) because the endpoints don't exist yet
- After Phase 3 implementation, all 54 tests must pass (GREEN)
