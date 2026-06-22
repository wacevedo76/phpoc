# Workflow Specifications

## Purpose
User-facing and system workflow specifications for the PH Ledger, organized by interface. Each doc describes expected behavior end-to-end, covering inputs, processing, outputs, and error states.

## Ownership
- `cli/` — CLI-specific workflows (`ph` command, daemon, background sync)
- `web/` — Web-specific workflows (React app, sync, auth, import/export)

## Local Contracts
- Workflow docs describe expected behavior — test suites validate against these
- Keep workflow docs in sync with test scenarios

## Work Guidance
- Add new CLI workflows to `cli/`, web workflows to `web/`
- Reference upstream design docs when workflows depend on architectural decisions

## Verification
None — workflow docs are specifications, verified indirectly through test suites.

## Child DOX Index
- `cli/AGENTS.md` — CLI workflow specifications
- `web/AGENTS.md` — Web workflow specifications
