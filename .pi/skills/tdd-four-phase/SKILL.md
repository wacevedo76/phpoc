---
name: tdd-four-phase
description: "Four-phase TDD workflow for PHPOC: Phase 1 (test exploration / blueprint), Phase 2 (RED / test definition), Phase 3 (GREEN / implementation), Phase 4 (REFACTOR / code review). Use when the user asks to work on a task using this TDD method, mentions '4 Phase TDD', or says 'Phase N' for any N 1-4."
---

# Four-Phase TDD Workflow

Execute feature work in four sequential phases. Each phase has a distinct deliverable, SESSION_HANDOFF update, and report. Never skip phases — each builds on the previous.

## Project Context

This skill operates within the PHPOC project at `/home/wacevedo/code/Testing/phpoc`. Key conventions:

- **SESSION_HANDOFF.md** — Update after every phase with what was done, files created/modified, and current phase status
- **docs/planning/** — Phase 1 blueprints live here as `*_PHASE1.md`. Other phase artifacts may also live here.
- **DOX chain** — Follow AGENTS.md rules. Read applicable AGENTS.md files before editing. Update them after changes.
- **BACKLOG.md** — Full issue queue. Check before starting new work.
- **Test conventions:**
  - Python tests: `tests/` directory, run with `python3 -m pytest tests/ -x`
  - Web tests: `phpoc-web/test/`, run with `node --test`
  - Worker tests: `worker/`, run with `npx vitest run`

## Phase Execution

### Before Any Phase

1. Read `SESSION_HANDOFF.md` for current state
2. Run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context
3. Identify the task from SESSION_HANDOFF.md or user instruction
4. Read any referenced planning docs (e.g., `ROW_LEVEL_STAGING_SYNC_PLAN.md`) to understand the full scope

---

### Phase 1 — Test Exploration (Blueprint)

**Goal:** Define every test assertion needed for full coverage before writing any code.

**Steps:**

1. Analyze the task — identify all modules, functions, endpoints, or components that need tests
2. Group assertions by module/area (e.g., Group A: CRUD, Group B: Edge Cases, Group C: Integration)
3. Create a Phase 1 document at `docs/planning/<FEATURE>_PHASE1.md` with this structure:
   ```markdown
   # <Feature> — Test Exploration (Phase 1)
   > **Plan:** <reference planning doc>
   > **Purpose:** Blueprint of all needed test assertions before writing any test code.
   > **Status:** 🔜 Phase 1 (test exploration)
   > **Next Phase:** Phase 2 (RED: test definition)

   ## Architecture Overview
   <brief description of modules and their relationships>

   ## Test Groups

   ### Group <letter>: <name> — ~N tests
   | ID | Assertion | Purpose | Rationale |
   |----|-----------|---------|-----------|
   | A1 | <what the test checks> | <why it exists> | <why this specific check matters> |
   ```
4. For each assertion, write: a unique ID, one-line assertion, purpose (what correctness property it verifies), and rationale (why this specific check matters for the system)
5. Display a summary report: total assertions, counts by group, key coverage areas
6. Update `SESSION_HANDOFF.md`:
   - Add the Phase 1 doc to "Files Created"
   - Update "Immediate Next Steps" to mark Phase 1 complete and list Phase 2 as next
   - Keep the update concise (SESSION_HANDOFF.md 100-line limit)

**Output:** `docs/planning/<FEATURE>_PHASE1.md` with complete assertion table. SESSION_HANDOFF updated.

---

### Phase 2 — RED (Test Definition)

**Goal:** Write all failing tests based on the Phase 1 blueprint. Tests must be runnable and RED.

**Steps:**

1. Read the Phase 1 document to understand every assertion
2. Create test file(s) in the appropriate test directory:
   - Python: `tests/test_<module>.py`
   - Web: `phpoc-web/test/<module>_test.mjs`
   - Worker: `worker/test/<module>.test.ts`
3. Each test must:
   - Map to a specific assertion ID from Phase 1
   - Use descriptive test names that reference the ID (e.g., `test S1 put stores entry by activity_id`)
   - Import only modules that will exist after Phase 3 (import the future API, write against the expected interface)
   - Fail for the right reason (assertion error, not import error if possible — stub imports when needed)
4. Run the test suite to confirm all new tests are RED (fail as expected)
5. Display a report: test file locations, test counts, assertion IDs covered, any Phase 1 assertions deferred (with reason)
6. Update `SESSION_HANDOFF.md`:
   - Add test files to "Files Created"
   - Update "Immediate Next Steps" to mark Phase 2 complete and list Phase 3 as next

**Output:** Test file(s) with RED tests. All tests fail with meaningful errors. SESSION_HANDOFF updated.

---

### Phase 3 — GREEN (Implementation)

**Goal:** Write the minimum code to make all Phase 2 tests pass. No refactoring yet.

**Steps:**

1. Read the Phase 2 test files to understand the expected API
2. Implement the modules/functions/endpoints:
   - Write only enough code to make tests pass
   - Follow existing project patterns and conventions
   - Handle all edge cases the tests cover
3. Run tests iteratively until all pass:
   - Python: `python3 -m pytest tests/ -x`
   - Web: `cd phpoc-web && node --test`
   - Worker: `cd worker && npx vitest run`
4. Run the full test suite to confirm no regressions:
   - Python: `python3 -m pytest tests/`
   - Web: `cd phpoc-web && node --test`
   - Worker: `cd worker && npx vitest run`
5. Display a report: files created/modified, test pass count, any regressions fixed
6. Update `SESSION_HANDOFF.md`:
   - Add source files to "Files Created" or "Files Modified"
   - Update "Immediate Next Steps" to mark Phase 3 complete and list Phase 4 as next

**Output:** Working implementation. All new tests GREEN. Full suite passes. SESSION_HANDOFF updated.

---

### Phase 4 — REFACTOR

**Goal:** Improve code quality without changing behavior. All tests must stay GREEN.

**Review criteria (in order of priority):**

1. **Modularity** — Can any function/module be extracted? Is there tight coupling that should be loosened? Are responsibilities clearly separated?
2. **Clarity** — Are names descriptive? Are complex sections commented? Is the control flow obvious? Would a new developer understand this in 6 months?
3. **Security** — Are inputs validated? Are errors handled safely? Is sensitive data properly protected per AGENTS.md contracts?
4. **Conciseness** — Can code be shortened without losing clarity? Are there redundant checks or dead code paths? Is there duplication that can be consolidated?

**Steps:**

1. Read the Phase 3 implementation files
2. Review against all four criteria above
3. Implement improvements — one at a time, re-running tests after each change
4. After all improvements, run the full test suite to confirm no regressions
5. Display a report: number of improvements by category, files changed, before/after comparisons
6. Update `SESSION_HANDOFF.md`:
   - Mark the full 4-phase task as ✅ complete
   - Update "Current State" if applicable
   - Update "Immediate Next Steps" to remove this task
   - If handoff is approaching the 100-line limit, archive completed sections to `docs/planning/archive/SESSION_HISTORY_YYYY-MM-DD.md`
7. Update `docs/planning/BACKLOG.md` if the completed task was listed there
8. Follow the Documentation Impact Contract in root AGENTS.md — update any impacted docs

**Output:** Cleaner code. All tests GREEN. SESSION_HANDOFF and relevant docs updated.

---

## After Phase 4

Signal completion clearly:

```
✅ 4-Phase TDD Complete: <task name>
   Phase 1: N assertions blueprinted → docs/planning/<FEATURE>_PHASE1.md
   Phase 2: N tests RED → <test files>
   Phase 3: N tests GREEN → <source files>
   Phase 4: N improvements → <changed files>
   Ready for next task.
```

## Session Continuity

When continuing across sessions, the agent must:
1. Read `SESSION_HANDOFF.md` to identify the current phase
2. Run `git log --oneline -5` to see what was committed
3. Pick up at the next incomplete phase
