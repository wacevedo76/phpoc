# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

## Documentation Impact Contract

Every code or design change that falls into the categories below must update the corresponding doc. The agent identifies impacted docs before editing, and includes doc updates with the change.

| Change type | Doc to update | What to do |
|---|---|---|
| Feature implemented or milestone reached | `docs/planning/ROADMAP.md` | Change status (🔜 → ✅), update notes |
| Feature deprioritized or paused | `docs/planning/BACKLOG.md` | Add entry with pause rationale and unblock criteria |
| New architectural decision made | `docs/design/ARCHITECTURAL_DECISIONS.md` | Add ADR with context, decision, consequences |
| Architecture invariant changed | `docs/reference/MAP.md` §Architecture Invariants | Update or add invariant |
| File created, moved, deleted, or renamed | `docs/reference/MAP.md` | Update file inventory, HOT/COLD annotations |
| Release cut | `docs/reference/CHANGELOG.md` | Add versioned entry with Added/Changed/Fixed |
| Build milestone completed (web/mobile) | `docs/planning/WEB_ROADMAP.md` | Add build step with date, tests, commit |
| Bug discovered or fixed | `SESSION_HANDOFF.md` known issues | Add (discovered) or remove (fixed) with context |
| Next steps change | `SESSION_HANDOFF.md` Immediate Next Steps | Replace the list |
| AGENTS.md hierarchy change | This file + affected children | Update Child DOX Index, update child doc |

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md

- **Documentation impact contract** (2026-06-20): Every code/design change must update the corresponding doc per the contract table above. Agent identifies impacted docs before editing and includes doc updates in the same commit.
- **Git context on session start** (2026-06-20): Agent reads `SESSION_HANDOFF.md` on new context. Follow the trigger directive there.
- **Live ledger protection** (2026-06-23): Never read, write, modify, or delete files under `~/.local/share/phpoc/` unless the user explicitly asks. This directory contains the user's actual committed ledger chain (`ledger.json`), staging area (`staging.json`), index (`index.json`), identity (`identity.json`), and write-ahead log (`wal/`). For testing or mock data, write to a separate location such as `/tmp/`, a `testdata/` directory in the project root, or a custom path the user provides. Use the real files only as read-only reference to understand data format, field names, and structure. For data format details, see `docs/spec/PHPSPEC.md`. For config defaults, see `security/config_manager.py` (ConfigManager.DEFAULTS, 9 sections, 27 fields). For mock generation, see `scripts/generate_mock_data.py` — use the `--output` flag, not `--apply`.

## Child DOX Index

### Source Code
- `cli/AGENTS.md` — CLI interface layer: commands, display, daemon, onboarding, background sync
- `core/AGENTS.md` — Core orchestration: factory, sync orchestrator, transports, sync confirmation
- `domain/AGENTS.md` — Domain logic: ledger chain, staging service, device cookies, view interfaces
  - `domain/ledger/AGENTS.md` — Ledger engine: chain building, sealing, verification, index, summaries
  - `domain/staging/AGENTS.md` — Staging service: auth gate, remote sync, cross-device merge
- `security/AGENTS.md` — Security: crypto (AES/HMAC), auth, device identity, recovery, config
- `storage/AGENTS.md` — Storage layer: abstract interfaces + file-based implementations

### Frontend & Cross-Platform
- `phpoc-web/AGENTS.md` — React web application (Vite + IndexedDB + WASM)
- `phpoc-crypto-core/AGENTS.md` — Portable Rust crypto library (WASM / iOS / Android)
- `worker/AGENTS.md` — Cloudflare Worker for remote staging blob storage

### Documentation & Testing
- `docs/AGENTS.md` — Central documentation hub
  - `docs/spec/AGENTS.md` — Format specification (PHPSPEC.md)
  - `docs/planning/AGENTS.md` — Roadmaps, backlogs, and design decisions
  - `docs/design/AGENTS.md` — Architectural decisions, design goals, workflows
  - `docs/reference/AGENTS.md` — Changelog, project map, and quick-reference material
- `tests/AGENTS.md` — Python test suite (30 files, 1341 tests)

### Not Indexed (no AGENTS.md needed)
- `archive/` — Retired design docs and reference artifacts (all COLD)
- `compat/` — Backward compatibility shims (2 files, COLD)
- `scripts/` — Utility scripts (maintenance tools, COLD)
- `staging_log/` — Trace log files (runtime artifacts, not source)
- Root-level files (`README.md`, `SESSION_HANDOFF.md`, `LICENSE`, `.gitignore`, `pytest.ini`, `main.py`) — Owned by this root AGENTS.md
