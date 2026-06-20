# PHPOC Backlog — Paused Issues

> Issues parked for future attention. Completed items are tracked in `CHANGELOG.md`
> and `WEB_ROADMAP.md`. This file only tracks what remains.

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

## P4 — CLI Kinks & UX Polish — Paused

**Pause rationale:** CLI is in maintenance mode while browser client is active development target.

**Unblock criteria:** Browser client reaches feature parity.
