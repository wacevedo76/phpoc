# Architectural Design

## Purpose
Architectural Decision Records (ADRs), design goals, cross-platform architecture, multi-device session design, auth gate workflow specifications, and top-level directives that govern all design and code changes.

## Ownership
- `ARCHITECTURAL_DECISIONS.md` — ADR log (ADR-001 through ADR-031)
- `CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` — Cross-platform architecture decisions
- `DESIGN_GOALS.md` — Architectural mandates and design goals
- `SYSTEM_ARCHITECTURE.md` — Comprehensive system architecture: key hierarchy, chain structure, staging pipeline, transport layer, multi-device sync, cross-platform strategy, crypto core, web app, CLI (synthesizes ADRs + directives + design goals)
- `DESIGN_MULTI_DEVICE_SESSION.md` — Multi-device session architecture
- `ARCHITECTURAL_MIGRATION_STRATEGY.md` — Historical 7-phase migration record (complete)
- `workflows/` — User-facing and system workflow specifications (phpoc_cli/ and web/)
- `flaws/ISSUES_TO_ADDRESS.md` — Guiding document: 17 design flaws organized by severity with dependency graph and recommended attack order
- `flaws/PHPSPEC-Design_Flaws.md` — Brutally honest assessment of PHPSPEC design conflicts and weaknesses
- `FLUTTER_ARCHITECTURE.md` — Flutter mobile architecture: comparative analysis (web vs CLI), state management (Riverpod), navigation (go_router), data layer (SQLite/drift), flutter_rust_bridge integration, project structure, screen inventory (2026-07-17)
- `FLUTTER_AXIOMS.md` — 31 axioms for Flutter app development organized into 6 categories: Protocol (A1–A8), Architecture (B1–B6), State Management (C1–C5), Data (D1–D6), Development (E1–E6), Decision (F1–F6). Quick-reference card with 20 yes/no checks before writing code. (2026-07-17)
- `TOP_LEVEL_DIRECTIVES.md` — Binding principles (D1–D11) read first for every architectural discussion. Referenced by `SESSION_HANDOFF.md`.
- `CANONICAL_SEAL-FIELD_Design.md` — Cross-client block-seal field-set convergence design (**ADR-029 adopted**: closed 6-field whitelist incl. `original_hash`)

## Local Contracts
- **TOP_LEVEL_DIRECTIVES.md is the first read-in for every architectural discussion.** All ADRs, design goals, axioms, and workflow specs must be consistent with D1–D11.
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
