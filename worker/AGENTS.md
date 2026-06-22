# Cloudflare Staging Worker

## Purpose
Lightweight Cloudflare Worker that acts as a dumb blob store for PH Ledger remote staging. Stores and retrieves encrypted/obfuscated staging blobs via simple HTTP endpoints. No ledger logic — pure storage proxy.

## Ownership
- `src/index.ts` — Worker entry point (149 lines), handles HTTP GET/PUT/DELETE for staging blobs
- `wrangler.toml` — Cloudflare Worker configuration
- `package.json` — Node.js project manifest (TypeScript, vitest, wrangler)

## Local Contracts
- Worker is a dumb blob store — no decryption, no ledger logic, no auth (encryption provides security)
- HTTP endpoints: GET (pull blob), PUT (push blob), DELETE (clear blob)
- Data stored in Cloudflare KV or similar persistence layer
- Zero knowledge of ledger structure

## Work Guidance
- Keep the worker simple — it's a pass-through for encrypted data
- Don't add ledger logic or validation here
- All security is handled client-side via encryption

## Verification
- Tests run via `npm test` (vitest)

## Child DOX Index
None.
