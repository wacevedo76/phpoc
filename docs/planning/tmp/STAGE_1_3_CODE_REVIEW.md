# Stage 1.3 Code Review — Remove Fallback Cookie

## Files Changed
- `src/hooks/useCookieMonitor.js` — `checkCookieTtl`: no cookie → `true` (graceful skip)
- `src/context/DevModeContext.jsx` — Removed fallback `DeviceCookie.create('local', ...)` block
- `test/reauth_ttl_test.mjs` — Updated test A3

## Modularity ✅
- `checkCookieTtl` is the right location for cookie-validity decisions
- Fallback removal eliminates a dynamic `import('@sync/index.js')` from `bootstrapServices()`
- No new dependencies or coupling added

## Clarity ✅
- Comment on `checkCookieTtl` explains three cases (local-only, fresh-login, pre-reconcile)
- Dead code removed — no more misleading `'local'` deviceUuid comment

## Security ✅
- Cookie is a TTL/conflict mechanism, not an auth boundary (MK in RAM is the real auth)
- `checkAndSync()` gate (Stage 1.1) still handles no-cookie → `REAUTH_NEEDED` correctly
- Expired cookie detection unchanged — only "never existed" case now skips cleanly
- No attack surface change: attacker would need IndexedDB access to delete cookies

## Efficiency ✅
- Removed unnecessary `storage.get('cookie')` + `DeviceCookie.create()` on every login
- `checkCookieTtl` early return on `!cookie` is fast (no async I/O)
