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

## P4 — CLI Kinks & UX Polish — Paused

**Pause rationale:** CLI is in maintenance mode while browser client is active development target.

**Unblock criteria:** Browser client reaches feature parity.
