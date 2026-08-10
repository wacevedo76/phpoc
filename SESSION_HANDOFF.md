# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/SESSION_HISTORY_2026-08-10.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Flutter test suite:** 1600/1663 passing (63 failing: all pre-existing)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)
- **Canonical Seal-Field (ADR-029/029a):** Phases 1–5 complete (Python/Web/Flutter/Migrator/PHPSPEC). Ph-6 (vectors) & Ph-7 (phone e2e) next.
- **Python suite:** 2586 pass / 1 skip / 0 fail. **Naming conformance (`test_naming_i04.py`): 50/50 GREEN** (fixed latent `_section_text` regex bug).

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
- **Backlog:** `docs/planning/BACKLOG.md` §CCS

## Immediate Next Steps 🎯

### 🥇 QUEUE TOP: Canonical Seal-Field (ADR-029/029a) — Python ✅ · Web ✅ · Flutter ✅ · Migrator ✅ · **PHPSPEC ✅ · Ph-6 vectors / Ph-7 phone 🔜**
- **Plan:** `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md` (7 phases, each 4-phase TDD)

**Ph-5 PHPSPEC — DONE (P1–P4):**
- Rewrote `docs/spec/PHPSPEC.md` §5.2 → **Block Seal Field Set** (per-type genesis/day/month/year), **Closed-Set Rule** (excluded `format_version`,`key_version`,`identity`,`identity_seal`,`signature`,hash key), `original_hash` optional-if-absent, **Unknown Block Types** reject; fixed §1.4 + §9.3 stale `format_version`-in-seal claims; routed `scripts/migrate_format_version.py` through `select_seal_fields`. Blueprint: `docs/planning/CANONICAL_SEALFIELD_PHPSPEC_PHASE1.md` (27 assertions). Fixed `test_naming_i04.py` latent `_section_text` regex bug + H12 closed-set allowance. Full suite 2586 pass/1 skip/0 fail.

**🔜 Next — Ph-6 Cross-client canonical seal vectors:**
- Generate genesis/day/month/year blocks (with/without `original_hash`) + expected 6-field seals into `testdata/`; Python/Web/Flutter verify against SAME vectors.
- **Then Ph-7:** re-migrate 0.4.0 ledger (backup first), rebuild Flutter APK, `adb install -r`, on-device `verify()` 129/129.

## Other In-Flight
- **Staging Auto-Sync** (queued): bidirectional `checkAndSync()` — `docs/planning/STAGING_AUTO_SYNC_PLAN.md`

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- Pre-existing Web red (unchanged): `ledger_merge_test` (block-1 entry-hash), `import_entries_test`, `genesis_gate_test`; `sync_service_test` 42 red
- 2 pre-existing Flutter `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie. Remove after legacy path cleanup.
- **🟢 `verify()` after cloud restore** — FIXED (Plan B: RC1–RC3). See `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`.
