# Architectural Design

## Purpose
Architectural Decision Records (ADRs), design goals, cross-platform architecture, multi-device session design, and auth gate workflow specifications.

## Ownership
- `ARCHITECTURAL_DECISIONS.md` — ADR log (ADR-001 through ADR-020)
- `CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` — Cross-platform architecture decisions
- `DESIGN_GOALS.md` — Architectural mandates and design goals
- `DESIGN_MULTI_DEVICE_SESSION.md` — Multi-device session architecture
- `ARCHITECTURAL_MIGRATION_STRATEGY.md` — Historical 7-phase migration record (complete)
- `workflows/` — User-facing and system workflow specifications (cli/ and web/)

## Local Contracts
- ADRs document decisions that have architectural impact — include context, decision, and consequences
- Design goals cross-reference `ROADMAP.md` for planned features
- Workflow docs describe expected behavior — test suites validate against these

## Work Guidance
- Add new ADRs chronologically to `ARCHITECTURAL_DECISIONS.md`
- Keep workflow docs in sync with test scenarios
- Cross-reference between design docs where decisions interact

## Verification
None — design docs are specifications, verified indirectly through test suites.

## Child DOX Index
- `workflows/AGENTS.md` — Workflow specifications: auth gate, remote/local sync, and future workflows
