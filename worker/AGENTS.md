# Cloudflare Staging Worker

## Purpose
Cloudflare Worker serving as the remote staging store for PH Ledger. Provides two service tiers:
1. **Generic blob store** — HTTP pass-through to R2 for opaque encrypted blobs (original design)
2. **Row-level staging** (ADR-025) — per-activity CRUD with manifest, push guard, and LWW sync support

No decryption or ledger logic — all security is client-side via encryption.

## Ownership
- `src/index.ts` — Worker entry point: CORS, auth routing, generic blob handlers
- `src/row_level_staging.ts` — Row-level staging types, validation, manifest helpers, HTTP handlers
- `wrangler.toml` / `wrangler.testing.toml` — Cloudflare Worker config (prod/test)
- `package.json` — Node.js project manifest (TypeScript, vitest, wrangler)
- `test/index.test.ts` — 49 blob store integration tests
- `test/row_level_endpoints.test.ts` — 55 row-level staging integration tests

## Local Contracts
- Worker has no knowledge of phpoc encryption, ledger structure, or blob format
- Auth: X-Api-Key header required if PHPOC_API_KEY secret is set
- CORS: all responses include permissive CORS headers
- Data stored in R2 (Cloudflare object storage), swap to S3/B2 by changing binding

### Row-Level Staging Endpoints (ADR-025)
- `GET /.../storage/staging/manifest` → `{rows: [...], version: N}`
- `GET /.../storage/staging/rows/{id}` → row JSON or 404
- `PUT /.../storage/staging/rows/{id}` → 200 | 400 (validation) | 409 (stale updated_at)
- `DELETE /.../storage/staging/rows/{id}` → 200 | 404
- Push guard: rejects PUT when `updated_at ≤ existing.updated_at`

## Work Guidance
- Keep row-level staging logic in `row_level_staging.ts`
- `index.ts` is the thin router — imports handlers, no staging logic inline
- Don't add ledger logic or decryption here

## Verification
- Tests run via `npm test` (vitest) — 104 integration tests against live deployment
- Deploy test Worker before running tests: `npx wrangler deploy -c wrangler.testing.toml`

## Child DOX Index
None.
