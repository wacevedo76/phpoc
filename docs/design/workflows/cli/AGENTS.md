# CLI Workflow Specifications

## Purpose
CLI-specific workflow specifications for the PH Ledger (`ph` command, daemon, background sync).

## Ownership
- `ph-view-workflow-updated.md` — Auth gate proxy workflow (staging sync gate)
- `onboarding-workflow.md` — CLI onboarding flows: remote import + local file import

## Local Contracts
- Workflow docs describe expected behavior — test suites in `tests/` validate against these

## Work Guidance
- Add new CLI workflows as standalone markdown files in this directory
- Reference `cli/AGENTS.md` for CLI architecture

## Verification
None — workflow docs are specifications, verified indirectly through test suites.

## Child DOX Index
None — flat directory structure.
