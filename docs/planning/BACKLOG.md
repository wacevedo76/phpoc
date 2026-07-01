# PHPOC Backlog — Paused Issues

> Issues parked for future attention. Completed items are tracked in `CHANGELOG.md`
> and `WEB_ROADMAP.md`. This file only tracks what remains.

## Entry Hash Format — Eventual indent=2 Consolidation

**Status (2026-06-25):** CLI engine (`engine.py`, `chain.py`) and web app (`utils.js`) now
both use `indent=2` for entry hashes. `onboarding_file.py` verifies entries in both formats.
`chain.py`'s `_verify_entry_hash_flex()` handles both. New entries are all indent=2.

**Pause rationale:** Sole user, no immediate need. No production mixed-format chains exist.
When the last pre-alignment chain is retired (all entries using old no-indent hashes),
the dual-format verification shims can be removed and `indent=2` becomes the canonical
single format.

**Unblock criteria:** All existing ledger chains have been migrated or retired.

### Remaining (pre-removal cleanup)
- [ ] Update `scripts/migrate_format_version.py` `verify_chain()` to try both
      entry hash formats (no-indent + indent=2), matching `_verify_entry_hash_flex()`
- [ ] Once all chains are indent=2 only, remove `_verify_entry_hash_flex()` from `chain.py`
      and `onboarding_file.py`, simplify to single-format verification

## P3 — Remote Sync (git-based) — Paused

**Pause rationale:** Browser client takes priority. Git transport is functional for CLI
but the remaining items (ledger sync via git, async transport) are deferred.

**Unblock criteria:** Browser client reaches parity with CLI sync features.

### Remaining
- [ ] **Ledger sync** — sync the ledger chain (blocks, identity) via git, not just staging
- [ ] **Async git transport** — make `GitStagingTransport._git()` non-blocking via `asyncio.create_subprocess_exec()`; enforce `timeout_ms` properly; keep `StagingService` and above synchronous (blocking absorbed by transport layer with `asyncio.run()`)
- [ ] Cross-device sync test (laptop ↔ debagent04)
- [ ] Handle case where `~/.local/share/phpoc/` doesn't exist yet on pull
- [ ] First-time `phpoc view` on a machine with no local staging

## P5 — CLI Unlock Latency (up to 10s) — Paused (2026-07-01)

**Investigation:** `docs/investigations/UNLOCK_PERFORMANCE_CLI.md` (full diagnostic trace).

**Root causes (3 compounding factors):**

1. **Broken HTTP timeout plumbing** — `check_and_sync(timeout_ms=500)` accepts the parameter but never passes it to transport calls. `_reconcile_and_claim()` calls `pull_cookie()` + `pull()` bare, which use `http.client.HTTPSConnection` with `_DEFAULT_TIMEOUT_S = 60.0`. The `check_remote_available(timeout_ms=500)` method only measures elapsed time after the call — it doesn't enforce the timeout on the socket.

2. **Multiple sequential network calls during unlock** — `_reconcile_and_claim()` makes up to 3 HTTP requests (cookie pull → blob pull → blob push), each with the 60s default timeout, each creating a new TCP+TLS connection (no keep-alive/pooling).

3. **Read commands make unnecessary network calls** — `ph list`/`ph view`/`ph tags` call `check_and_sync()` which reaches out to remote for cookie verification even when just displaying local data.

**Why "sometimes 10s":** Cloudflare Worker cold starts add 1-5s per request. With 2-3 sequential requests + TLS handshake, total = 3-15s. Warm Worker = 1-2s. Unreachable remote = up to 60s.

**What's NOT the bottleneck:** PBKDF2 600K iterations (~0.09s via OpenSSL-backed `hashlib`), JSON parsing (~1ms for 105 blocks), file I/O.

**Proposed solutions (priority order):**

| # | Solution | Effort | Impact |
|---|----------|--------|--------|
| B | Pre-check remote reachability via `check_remote_ping()` before cookie/blob pulls | Small | Prevents 60s hangs on unreachable |
| A | Fix timeout plumbing: pass `timeout_ms` through all layers, reduce default from 60s → 5s | Medium | Caps worst-case at 3-5s |
| C | Skip network calls for read-only commands (add `check_local_only()`) | Medium | `ph list`/`view` become instant |
| D | HTTP connection pooling / keep-alive | Large | Eliminates TLS handshake overhead (0.5-2s) per-request after first |
| E | Worker warmup (paid plan, cron trigger, or warmup endpoint) | Small (infra) | Eliminates cold-start component |

**Files affected:** `core/sync/http_transport.py` (line 56, `_DEFAULT_TIMEOUT_S`), `domain/staging/service.py` (`check_and_sync`, `_reconcile_and_claim`), `domain/staging/remote_sync.py` (`pull_cookie`, `pull`, `check_remote_available`), `main.py` (read-command dispatch).

**Pause rationale:** Web unlock takes priority. CLI is in maintenance mode.

**Unblock criteria:** Web unlock latency investigation complete; user prioritizes CLI work.

## P4 — CLI Kinks & UX Polish — Paused

**Pause rationale:** CLI is in maintenance mode while browser client is active development target.

**Unblock criteria:** Browser client reaches feature parity.
