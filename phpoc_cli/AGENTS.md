# CLI Interface Layer

## Purpose
Command-line interface for the PH Ledger — user-facing commands, display logic, daemon management, background sync, onboarding, and interactive strategies.

## Ownership
- `main.py` — CLI entry point, argparse wiring
- `phpoc_cli/interface.py` — `CLIInterface`: view_active, show_rep, list_habits, sync coordination
- `phpoc_cli/strategies.py` — `InteractiveCLIStrategy` for sync confirmation UI
- `phpoc_cli/background.py` — Background sync check with notifications
- `phpoc_cli/daemon.py` / `phpoc_cli/daemon_sync.py` — `PhDaemon` lifecycle and sync loop
- `phpoc_cli/daemon_cli.py` — Daemon CLI subcommands
- `phpoc_cli/onboarding.py` — `ph onboarding remote` flow (git), `ph onboarding http` flow (Cloudflare R2)
- `phpoc_cli/onboarding_file.py` — `ph onboarding file` flow (v1/v2/chain import)
- `phpoc_cli/wal.py` — Write-ahead log and background push
- `phpoc_cli/trace.py` — Trace/debug logging
- `phpoc_cli/transport_cmd.py` — `ph transport` subcommand
- `phpoc_cli/cli_parsers.py` — Argument parsers for commands
- `phpoc_cli/cli_view.py` — View formatting utilities

## Local Contracts
- `CLIInterface` constructor: `CLIInterface(staging_service, ledger_engine, crypto)` — no `self.ledger` references
- Depends on `domain.staging`, `domain.ledger`, `security.crypto`
- All display output goes through `CLIInterface` methods, never directly to stdout
- Session cache at `/dev/shm/phpoc_session`

## Work Guidance
- Follow existing command patterns when adding new subcommands
- Sync before read commands; sync + auth before write commands
- Use `_sync_before_command(require_auth=False)` for reads, `True` for writes
- Remote Worker testing: use credentials from `TEST_CREDENTIALS.md` (gitignored) at repo root

## Verification
- Python test suite under `tests/` (test_modular, test_daemon, test_background_sync, etc.)

## Child DOX Index
None — flat directory structure.
