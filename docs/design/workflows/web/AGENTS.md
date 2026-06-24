# Web Workflow Specifications

## Purpose
AI-agent consumable workflow references for the PHPOC React application.
Not user-facing docs — designed to be parsed quickly by an agent tracing
issues, adding features, or reviewing code.

## Ownership
- `Remote_Local-Workflow.md` — Remote/local sync: staging, genesis gate, reconcile, commit, auto-sync
- `Local_Import-Export-Workflow.md` — File-based import/export: v1/v2/raw-chain, two-phase validate→confirm, genesis gating

## Local Contracts
- **Agent-only** — concise tables, decision trees, invariants, checkpoints, gaps.
- Follow the parent `workflows/AGENTS.md` template: Module Map, Storage Keys,
Decision Tree, Key Invariants, Diagnostic Checkpoints, Known Gaps.
- Test suites in `phpoc-web/test/` validate against these.
- Keep module paths and export names current.

## Verification
None — verified indirectly through test suites.

## Child DOX Index
None — flat directory structure.
