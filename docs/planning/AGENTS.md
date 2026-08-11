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
- `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — **Implementation plan** for cross-client staging sync and reconciliation (CCS). Consolidates B-04, B-05, ADR-025, P3. Defines CCS-1 through CCS-4 phases, implementation scorecard, dependency graph, and per-client source file index. References abstract protocol workflow in `../reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12. (2026-08-07)
- `CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` — **Implementation plan** for ADR-029 canonical block-seal whitelist: 7 phases (Python, Web, Flutter, migration tool, PHPSPEC, canonical vectors, phone e2e), each run through the 4-phase TDD workflow. Cross-client convergence so migrated 0.4.0 ledgers verify on every client. (2026-08-09)
- `CANONICAL_SEALFIELD_PYTHON_PHASE1.md` — Phase 1 test exploration for **CANONICAL_SEALFIELD Phase 1/7 (Python `chain.py`)**: 26 assertions across 5 groups (A–E) for the ADR-029/029a **type-aware** per-type seal whitelist (summaries seal `month`/`year`). Phase 1–3 GREEN (P4 REFACTOR next). (2026-08-09)
- `CANONICAL_SEALFIELD_WEB_PHASE1.md` — Phase 1 test exploration for **CANONICAL_SEALFIELD Phase 2/7 (Web `chain.js`)**: 27 assertions across 5 groups (A–E) converging Web sealer/verifier + the duplicated `merge.js` verifier onto the closed whitelist (fixes latent `format_version`/`key_version`/stray-field sealing). **Phases 1–4 complete** (2026-08).
- `CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md` / `CANONICAL_SEALFIELD_MIGRATOR_PHASE3.md` — **CANONICAL_SEALFIELD Phase 4/7 (migration tool)**. P1 blueprint: 26 assertions A–F (day/genesis/summary seal whitelist, e2e accept + closed-set guard, `_seal_block`/`_block_hash_key`, unknown-type safety). P3 GREEN: `execute()` rejects unknown block types before write (F1/F2 no-op guarantee). P4 REFACTOR next. (2026-09)
- `CANONICAL_SEALFIELD_PHPSPEC_PHASE1.md` — Phase 1 test exploration for **CANONICAL_SEALFIELD Phase 5/7 (PHPSPEC spec doc)**: 27 spec-conformance assertions across 6 groups (A–F) documenting the ADR-029/029a closed per-type whitelist in `docs/spec/PHPSPEC.md` §5.2, the closed-set excluded-field rule, `original_hash` optionality, and removal of stale §9.3 `format_version`-in-seal claims. **Phases 1–4 complete** (2026-08-10).
- `CANONICAL_SEALFIELD_PHASE6_VECTORS_PHASE1.md` — Phase 1 test exploration for **CANONICAL_SEALFIELD Phase 6/7 (cross-client canonical seal vectors)**: 29 assertions across 5 groups (A–E). Supersedes the stale open-set `testdata/canonical_test_vectors.json` with a closed-whitelist `canonical_seal_vectors.json` (8 vectors, two chain-linked sequences); exact-assert python/web B-vectors via `select_seal_fields`; ports per-type `month`/`year` into Flutter `_sealFields`; divergence-detection on the Flutter summary bug. **Phases 1–4 complete** (2026-08-10): Fixture + generator created; Python B1–B5/A/D/E1 & Web B1-js–B5-js exact-asserted; Flutter per-type summary sealing converged (Group C + D2); P4 refactor DRYed vector generator/test loader (byte-identical fixture).
- `CCS1b_PHASE1.md` — Phase 1 test exploration for CCS-1b (Flutter obfuscation compatibility). 16 assertions across 5 groups (A–E): key derivation parity, deterministic API, cross-client read/write, integrity. (2026-08-07)
- `VERIFY_RESTORE_FIX_PLAN_B.md` — Approach B: fix `verify()` after cloud restore (3 root causes). 6 Flutter files, ~120 lines. (2026-08-08)
- `VERIFY_RESTORE_FIX_PLAN_B_PHASE1.md` — Phase 1 test exploration for Plan B: 65 assertions across 12 groups (A–L). Phase 2 RED pending. (2026-08-08)
- `CLI_COMMAND_TIMING_FIXES.md` — Investigation report + 4-fix plan for `ph view` latency (16 HTTP round-trips, ~5–26s). F1: duplicate check_and_sync, F2: ledger block cache, F3: skip unchanged push, F4: HTTP pooling. Execution order F1→F4 with 4-phase TDD per fix. (2026-07-14)
- `I02_PHASE1.md` — Phase 1 test exploration for I-02 (blind index encryption + staging field key encryption). 74 assertions across 9 groups (A–I). (2026-07-16)
- `RELEASE_CHECKLIST.md` — Google Play Store release checklist: device testing tiers, build requirements, app signing setup, Rust crypto cross-compilation targets, encryption export compliance, data safety declarations, permissions, store listing assets, testing tracks, and phase-gated rollout sequence. (2026-07-17)
- `flutter/SCREENS_PHASE1.md` — Phase 1 test exploration for screens layer (109 assertions, 10 groups A–J). (2026-07-17)
- `flutter/INITIAL_PLAN.md` — Flutter mobile app development plan: 8 phases (bottom-up), staging-only MVP, dependency graph, cross-references to axioms, architecture, ADRs, and spec. Draft — under discussion. (2026-07-17)

## Local Contracts
- Roadmaps track status with `✅` (done), `🔜` (planned), `🔮` (future), and `⏸️` (deferred)
- Completed items graduate to `../reference/CHANGELOG.md` on release
- Cross-reference design goals in `../design/DESIGN_GOALS.md` for architectural mandates
- Session-level state is captured in `../../SESSION_HANDOFF.md`, not here

## Work Guidance
- **Cross-client staging sync changes**: Consult `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — the authoritative implementation plan for all CCS work. References abstract protocol workflow in `../reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12.
- Update roadmap status as milestones are reached
- Move paused items to `BACKLOG.md` with unblock criteria
- Cross-reference between planning docs where features interact
- Web-specific design decisions go in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md`

## Verification
None — planning docs are tracking artifacts, not tested.

## Child DOX Index

### Flutter
- `flutter/` — Flutter mobile app plans (no AGENTS.md yet)
  - `flutter/INITIAL_PLAN.md` — 8-phase development plan
  - `flutter/MODELS_PHASE1.md` — Phase 1 test exploration for domain models (93 assertions, 9 groups) ✅
  - `flutter/CRYPTO_FFI_PHASE1.md` — Phase 1 test exploration for crypto FFI bridge (74 assertions, 11 groups) ✅
  - `flutter/STORAGE_PHASE1.md` — Phase 1 test exploration for storage layer (100 assertions, 11 groups) ✅
  - `flutter/SYNC_CORE_PHASE1.md` — Phase 1 test exploration for sync core (106 assertions, 10 groups) ✅
  - `flutter/PUSH_TO_R2_PHASE1.md` — Phase 1 test exploration for push-to-R2 (45 assertions, 9 groups) 🔜 Phase 1
