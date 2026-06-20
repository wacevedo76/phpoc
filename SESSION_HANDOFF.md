# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.

## Immediate Next Steps

1. **🔴 Settings genesis compatibility gate** — Pull remote genesis block, compare hashes. Same genesis → use LedgerMerge for divergent chains. Different genesis → block connection. LedgerMerge is GREEN (99 assertions, 0 failures) with input chain validation.
2. **Companion bridge server** (Python, ~80-100 lines) — same HTTP API as Worker, enables CLI ↔ web without remote infra.
3. **Docker + multi-tenant Worker** — one-command deploy for self-hosted users.

> Full historical step-by-step status is in `docs/planning/WEB_ROADMAP.md`. This file is the session-level snapshot.

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
- WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.
- IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage (`FallbackStorage`), data lost on refresh. Now cached at module level so it survives logout/login within the same session.
- **Ledger merge — GREEN (2026-06-19):** `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. 7-step algorithm + Step 0 input chain validation. 99 assertions, 0 failures. ⏭ Next: Wire into genesis compatibility gate.
- **No genesis gate on remote connection (2026-06-18):** The Settings screen lets users configure a Worker URL without verifying it belongs to the same ledger. Step 6 addresses this with a genesis compatibility gate: pull remote block 0, decrypt, compare hashes. G₁≠G₂ → block connection.
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this for raw chain verification.
- **`isWasmDerivedUuid` regex too broad (2026-06-18):** The hex regex `/^[0-9a-f]{32,}$/` matches MD5 (32 chars), SHA-1 (40), and dash-stripped UUID4 (32 chars). Should be `{64}` for HMAC-SHA256. Low risk in practice.
- **Index-based staging operations have stale-index race (2026-06-18):** `end()`, `pause()`, `unpause()` call `readEntries()` to find an index, then call `update()` by that index. Between the read and write, another operation could change the array order.
- **`_getDeviceId()` called twice in push operations:** `pushToRemote()` calls it for `pushBlob` and again for `_pushCookie`.
- **`createStoragePlugin` lan/saas branch still creates `HttpBackend`:** The architecture decision says SaaS should be IndexedDB (local) + HttpTransport (remote), but the branch returns `HttpBackend` directly. Full storage unification deferred.
- **apiKey normalization differs between factories:** `createRemoteTransport` uses `|| null`, `createStoragePlugin` uses `|| ''`. Both intentional but divergent.
