# CLI Workflow Specifications

## Purpose
AI-agent consumable workflow references for the PH Ledger CLI.
Not user-facing docs — designed to be parsed quickly by an agent tracing
issues, adding features, or reviewing code.

## Ownership
- `ph-view-workflow-updated.md` — Auth gate proxy workflow (staging sync gate)
- `onboarding-workflow.md` — CLI onboarding flows: remote import + local file import
- `ph-transport-set-workflow.md` — Transport configuration: show / set git / set http / set http cloudflare

## Local Contracts
- **Agent-only** — concise tables, decision trees, invariants, checkpoints, gaps.
- Follow the parent `workflows/AGENTS.md` template: Module Map, Decision Tree,
Key Invariants, Diagnostic Checkpoints, Known Gaps.
- Test suites in `tests/` validate against these.
- Keep module paths and export names current.

## Verification
None — verified indirectly through test suites.

## Child DOX Index
None — flat directory structure.
