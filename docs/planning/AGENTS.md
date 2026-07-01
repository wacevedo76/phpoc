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
