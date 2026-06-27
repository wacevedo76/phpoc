# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md` to identify which docs this session's changes affect. Update those docs as part of the work.

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — onboarding redesign complete (Phase 5d), 1493 tests
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON)
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests)
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2)
- **WASM crypto:** Bundled by Vite's native pipeline — `src/crypto/wasm/`, real WASM in both dev and production. No DummyCryptoService fallbacks.

## Immediate Next Steps

### ✅ Settings Genesis Gate Integration — Category C Browser E2E (C2 FIXED)

**Status:** 4 pass / 0 fail / 4 skipped. C2 fixed via Solution B.

| Test | Result | Details |
|------|--------|--------|
| **C1** | ✅ PASS | "✅ Genesis compatible" + entry count shown for correct Worker URL + API key |
| **C2** | ✅ PASS | Fixed: `SyncService.reconfigure(transport)` called from Settings after genesis check. Sync Now uses new transport. |
| **C3** | ⏭️ SKIP | Need Worker with different genesis; testing Worker appears empty. No incompatible Worker available. |
| **C4** | ✅ PASS | "🔌 Cannot reach remote" + "Network error" for non-existent URL |
| **C5** | ⚠️ UNTESTABLE | `fill` command sets DOM `.value` but doesn't trigger React `onChange`. Can't clear URL field to test status→disappear flow via agent_browser. |
| **C6** | ✅ PASS | API key change re-triggers genesis check. Wrong API key → "Authentication failed. Check your API key." |
| **C7** | ⏭️ SKIP | Requires clearing local ledger (destructive). Settings inaccessible during onboarding. |
| **C8** | ⏭️ SKIP | Settings page inaccessible without authentication (requires login → Settings path). |

**Fix implemented:** Solution B — `reconfigure(transport)` method on SyncService. Settings calls `services.sync.reconfigure(transport)` after genesis check, and `services.sync.reconfigure(null)` when URL is cleared. 6 new tests in Group K of `sync_service_test.mjs`. Analysis at `docs/design/TRANSPORT_RECONFIGURATION_ANALYSIS.md`.

### ⏭ Remaining Gaps (future work)

1. **Tier 2 — React component tests** (~9 tests): OnboardingScreen import form state machine — file picker gating, destroy warning display, checkbox gates, genesis error display.
2. **Tier 3 — Browser E2E** (~4 tests): Real browser flow with Playwright — full import from file picker, export from Settings, roundtrip in a fresh session.
3. **Same-genesis merge support**: `LedgerMerge.merge()` exists in `src/ledger/merge.js` but import rejects same-genesis with "merge not yet supported". Needs to be wired into `confirmImport`.
4. **Raw chain staging extraction**: CLI `ledger.json` import puts all entries inside `ledger:blocks` — no way to extract them into staging for editing or re-commit.

## Known Issues

- **SyncService transport not updated on Settings change (2026-06-25):** ✅ FIXED. Solution B implemented — `SyncService.reconfigure(transport)` exposed, called from Settings after genesis check. 6 new tests (Group K). C2 E2E test now passes.
- **Stale session cache trusted without verification (2026-06-26):** ✅ FIXED. `PassphraseAuthenticator.authenticate()` blindly trusted the cached key (`/dev/shm/phpoc_session`) without verifying it against the genesis seal. A stale/wrong cached key caused `ph list all` to silently skip all entries (decryption failed, caught by bare `except:`). Fix: added `_verify_cached_key()` that checks genesis seal before trusting the cache; stale cache is auto-cleared. Also fixed `_print_entry` to show `[encrypted] title (Nm) [run 'ph login' to decrypt]` instead of silently skipping undecryptable entries.
- **TTL cookie ignored for local-only ledgers (2026-06-27):** ✅ FIXED. `check_and_sync()` returned `READY` immediately when `_remote is None`, bypassing the device cookie TTL entirely. Read commands (`ph list`/`view`/`tags`) never prompted for a passphrase because the session cache at `/dev/shm/phpoc_session` has no TTL and the device cookie (which does) was never checked. Fix: `check_and_sync()` now checks `DeviceCookie.is_valid_locally()` even for local-only, returning `REAUTH_NEEDED` on expiry. `_reconcile_and_claim()` creates a local cookie via new `DeviceCookie.create_local()`. `ph login` and `ph recover` handlers also create local cookies. Changes in `domain/cookie/device_cookie.py`, `domain/staging/service.py`, `main.py`.
- **phpoc-web: Remote sync settings not cleared on new ledger (2026-06-27):** ✅ FIXED. When `createNewLedger()` or `confirmImport()` cleared IndexedDB (`storage.clear()`), the `localStorage` keys `phpoc_worker_url` and `phpoc_api_key` were left intact. Result: after creating a new ledger or importing one, the Settings page still showed the previous Worker URL and API Key. Fix: both functions now call `localStorage.removeItem()` for both keys immediately after `storage.clear()`. Change in `phpoc-web/src/context/DevModeContext.jsx`.

## Browser E2E Testing Setup

- **Browser:** Vivaldi with `--remote-debugging-port=9222`. Connect via `agent_browser: connect 9222` with `sessionMode: "fresh"`.
- **Tab rule:** After connecting, run `tab list` → find tab with `localhost:5173` (or 4173) → `tab t<N>` to switch. **Do NOT open new tabs** — reuse the existing one. If server restart opens a new tab, find it via `tab list` by URL.
- **Dev server:** Start with `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Production preview:** `cd phpoc-web && npx vite preview --host 0.0.0.0 --port 4173`
- **WASM crypto is fixed** — artifacts bundled from `src/crypto/wasm/`, Vite handles `.wasm` via `new URL()` asset references.
- **Job mode (`steps`)** works for batched fills.

## Test Ledger Credentials

- **Passphrase:** `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
- **Master seed:** `hopULgZOX/cpcLTlur/T0jbt9gV5Q/w/FEBMpLnR6oA=`
- **Username:** `testuser` | **Email:** `test@example.com`
- **Ledger:** 2 blocks (genesis + 1 day block), 2 entries committed

## Testing Quick Reference

| Resource | Value |
|----------|-------|
| **Worker URL** | `https://phpoc-staging-testing.wacevedo.workers.dev` |
| **R2 bucket** | `phpoc-data-testing` |
| **Test ledger path** | `~/code/phpoc-testing-data/phpoc-robertwallace.json` |
| **phpoc-web URL** | `http://localhost:5173/?dev=false` |
| **Worker configs** | `worker/wrangler.toml` (production, `phpoc-data`) / `worker/wrangler.testing.toml` (testing, `phpoc-data-testing`) |

> **Credentials** (API key, passphrase, recovery seed, wrangler token) are stored locally outside the repo. Ask the user to provide them if needed.
