# CLI Interface Layer

## Purpose
Command-line interface for the PH Ledger — user-facing commands, display logic, daemon management, background sync, onboarding, and interactive strategies.

## Ownership
- `main.py` — CLI entry point, argparse wiring
- `cli/interface.py` — `CLIInterface`: view_active, show_rep, list_habits, sync coordination
- `cli/strategies.py` — `InteractiveCLIStrategy` for sync confirmation UI
- `cli/background.py` — Background sync check with notifications
- `cli/daemon.py` / `cli/daemon_sync.py` — `PhDaemon` lifecycle and sync loop
- `cli/daemon_cli.py` — Daemon CLI subcommands
- `cli/onboarding.py` — `ph onboarding remote` flow (git), `ph onboarding http` flow (Cloudflare R2)
- `cli/onboarding_file.py` — `ph onboarding file` flow (v1/v2/chain import)
- `cli/wal.py` — Write-ahead log and background push
- `cli/trace.py` — Trace/debug logging
- `cli/transport_cmd.py` — `ph transport` subcommand
- `cli/cli_parsers.py` — Argument parsers for commands
- `cli/cli_view.py` — View formatting utilities

## Local Contracts
- `CLIInterface` constructor: `CLIInterface(staging_service, ledger_engine, crypto)` — no `self.ledger` references
- Depends on `domain.staging`, `domain.ledger`, `security.crypto`
- All display output goes through `CLIInterface` methods, never directly to stdout
- Session cache at `/dev/shm/phpoc_session`

## Work Guidance
- Follow existing command patterns when adding new subcommands
- Sync before read commands; sync + auth before write commands
- Use `_sync_before_command(require_auth=False)` for reads, `True` for writes

## Verification
- Python test suite under `tests/` (test_modular, test_daemon, test_background_sync, etc.)

## Child DOX Index
None — flat directory structure.
