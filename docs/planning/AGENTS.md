# Planning Documentation

## Purpose
Roadmaps, backlogs, and design decisions that track planned and in-progress work across the PHPOC project.

## Ownership
- `ROADMAP.md` — Planned features organized by protocol layer
- `BACKLOG.md` — Paused issues awaiting future attention
- `WEB_ROADMAP.md` — Web/mobile build log (completed steps, bugs found, test plans)
- `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` — React web UI design decisions and multi-deployment architecture
- `ALIGN_WEB_STAGING_SHARING_WITH_CLI.md` — Plan to align web staging sharing behavior with CLI multi-machine pattern
- `STABLE_DEVICE_SPECIFIER_ON_WRITES.md` — Plan: stop re-rolling device cookie specifier on same-device writes (fixes cross-client spurious REAUTH_NEEDED)
- `CLI_READONLY_STAGING_SYNC.md` — Plan: CLI read commands pull remote staging without claiming ownership (fixes `ph view` blocking on specifier mismatch)
- `E2E_CROSS_CLIENT_BUGS.md` — E2E cross-client test findings: 4 bugs + 1 plumbing issue blocking CLI↔Web staging/ledger sync (2026-06-30)
- `E2E_CROSS_CLIENT_FIX_PLAN.md` — Fix plan for cross-client bugs: typed errors (Bug 1), summary block indices (Bug 2), staging format (Bug 3), genesis seal (Bug 4)
- `ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md` — Strategy: hash-index based genesis check replacing full block pulls. 4-phase TDD plan. 210× speedup on common case. (2026-06-30)
- `ONBOARDING_SPEEDUP_TESTS.md` — Phase 1 output: exhaustive test catalog (~62 new tests, ~15 modified). Categories A–J covering hash index data structure, fork detection, push behavior, Tier 1/2 integration, Worker endpoint, E2E, and edge cases. (2026-07-02)
- `STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` — Plan: introduce stable `activity_id` for lifecycle tracking (Staging → Commit) + staging hash index for fast cross-client staging reconciliation. Mirrors ledger hash index architecture. Design decisions, spec conformance, phases, and privacy analysis. (2026-07-07)
- `STAGING_ACTIVITY_ID_TESTS.md` — Phase 1 output: exhaustive test catalog (116 tests across 10 categories A–J) covering activity_id generation, lifecycle, staging hash index data structure, comparison, Tier 1/2 fast paths, Worker endpoint, cross-client sync, backward compat, and edge cases. (2026-07-07)
- `STAGING_HASH_INDEX_WORKFLOW.md` — Workflow specification: full data flow contract for staging activity_id + hash index across push, pull, merge, and transport. Defines checkAndSync() integration, Tier 1/2/3 cascade, worker endpoint contract, backward compat, and LocalCache API surface needed. Single source of truth for mock transport + remaining test categories E–J. (2026-07-07)
- `ROW_LEVEL_STAGING_SYNC_PLAN.md` — Implementation plan for row-level staging sync: 8-scenario LWW resolution table, sync cycle contract, Worker endpoint spec, per-row obfuscation format, migration strategy, and phased test catalog. Companion to ADR-025. (2026-07-08)
- `CLI_COMMAND_TIMING_FIXES.md` — Investigation report + 4-fix plan for `ph view` latency (16 HTTP round-trips, ~5–26s). F1: duplicate check_and_sync, F2: ledger block cache, F3: skip unchanged push, F4: HTTP pooling. Execution order F1→F4 with 4-phase TDD per fix. (2026-07-14)

## Local Contracts
- Roadmaps track status with `✅` (done), `🔜` (planned), `🔮` (future), and `⏸️` (deferred)
- Completed items graduate to `../reference/CHANGELOG.md` on release
- Cross-reference design goals in `../design/DESIGN_GOALS.md` for architectural mandates
- Session-level state is captured in `../../SESSION_HANDOFF.md`, not here

## Work Guidance
- Update roadmap status as milestones are reached
- Move paused items to `BACKLOG.md` with unblock criteria
- Cross-reference between planning docs where features interact
- Web-specific design decisions go in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md`

## Verification
None — planning docs are tracking artifacts, not tested.

## Child DOX Index
None — flat directory.
