# Workflow Specifications

## Purpose
AI-agent consumable workflow references — NOT user-facing docs. Each file maps
the modules, decision trees, invariants, diagnostic checkpoints, and known gaps
for a single workflow so an agent can trace issues without reading source.

## Ownership
- `phpoc_cli/` — CLI-specific workflows (`ph` command, daemon, background sync)
- `web/` — Web-specific workflows (React app, sync, auth, import/export)
- `Cross_Device_Staging-Workflow.md` — Cross-device staging sharing: CLI ↔ Web via Worker/R2

## Local Contracts
- **Agent-only** — these docs are written for and consumed by AI agents during
debugging, feature work, and code review. They are not user documentation.
- **Concise and parseable** — prefer tables, decision trees, and numbered
invariants over prose paragraphs. Every section should be directly actionable.
- **Fingerprinted** — every file must include a Module Map (exact file paths +
exports), Key Invariants (what must never break), Diagnostic Checkpoints
(code expressions for each check), and Known Gaps (what's not yet implemented).
- Test suites in `phpoc-web/test/` and `tests/` validate against these specs.
- Keep workflow docs in sync with module paths and exported function names.

## Work Guidance
- Start new workflow docs from the existing templates in `web/` or `phpoc_cli/`.
- Module Map: every source file touched by the workflow with exact path and exports.
- Decision trees: ASCII-branch style showing every possible path and outcome.
- Diagnostic checkpoints: numbered table — what to check + exact code expression.
- Key invariants: numbered list — behaviors that must never regress.
- Known gaps: only things that exist as source but aren't wired, or real limitations.
- Add new CLI workflows to `phpoc_cli/`, web workflows to `web/`.

## Verification
None — workflow docs are specifications, verified indirectly through test suites.

## Child DOX Index
- `phpoc_cli/AGENTS.md` — CLI workflow specifications
- `web/AGENTS.md` — Web workflow specifications
- `Cross_Device_Staging-Workflow.md` — Cross-device staging sharing: sync gate, merge engine, device cookie, genesis gate across CLI and Web
