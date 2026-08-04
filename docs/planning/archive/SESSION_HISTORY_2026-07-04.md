# Session History (archived 2026-07-04)

> Completed work moved here to keep SESSION_HANDOFF.md lean.
> Active work stays in SESSION_HANDOFF.md. Full issue queue in BACKLOG.md.

## Canonical Ledger Format — Phase 3 GREEN Complete (2026-07-03)

All 40 tests GREEN across `tests/test_migration.py` (26 PY), `phpoc-web/test/ledger_chain_test.mjs` (+10 JS), `phpoc-web/test/ledger_import_chain_test.mjs` (+2 JS), and `testdata/canonical_test_vectors.json` (shared).

Results: 1580/1580 PY + 571 JS pass.

New file: `phpoc_cli/migrate.py` — `migrate_chain(chain, master_key_hex, ledger_path=None)` function: backup, strip format_version, rename day_hash→block_hash, fix prev_hash chain, recompute all seals.

Source changes (13 Python): `core/factory.py`, `domain/ledger/chain.py`, `domain/ledger/merge.py`, `security/auth.py`, `phpoc_cli/onboarding_file.py`, `domain/ledger/remote_sync.py`, `domain/ledger/engine.py`, `domain/ledger/summary_policy.py`, `core/sync/orchestrator.py`, `phpoc_cli/onboarding.py`, `compat/v0_3_0.py`, `phpoc_cli/migrate.py` (new).

Source changes (5 JS): `phpoc-web/src/ledger/chain.js`, `phpoc-web/src/ledger/merge.js`, `phpoc-web/src/ledger/utils.js`, `phpoc-web/src/services/ledger_import.js`, `phpoc-web/src/sync/genesis_gate.js`.

## Canonical Ledger Format — Phase 4 Refactor (2026-07-03)

All 5 recommendations implemented:
1. Post-migration self-verification in migrate_chain() ✅
2. Shared _get_block_hash() → domain/ledger/helpers.py ✅
3. _hash_key_for_block() helper in chain.py ✅
4. Rename _get_hash_key → _hash_key_for_block_type ✅
5. Document _verifyBlockData duplication between chain.js and merge.js ✅

## Login Perf: Phase A+B Complete (2026-07-02)

Three of four root causes fixed:
1. Hash index bootstrap gap — outstanding (first-ever login still does full chain pull)
2. pushLedgerBlocks gated on merged flag ✅
3. Duplicate pullCookie eliminated ✅
4. _genesisCompatible cached to true ✅

## Onboarding/Unlock/ReAuth Speedup — Phases 1-3 Complete (2026-07-02)

All 485 tests pass. New file: `phpoc-web/src/sync/hash_index.js` (85 lines).
Tier 1 SHA-256 fast path, Tier 2 hash index fork detection, hash index push on sync.

## E2E Cross-Client Fix — GREEN Phase Complete (2026-07-01)

4 bugs implemented and verified: genesis mismatch typed errors, month summary position counter, UUID suffix, entry format canonicalization, genesis seal signature exclusion.

## Steps 1-5 Completions

- Step 1: Fix getCompleted() duplication bug ✅ (2026-06-28)
- Step 2: Python port of LedgerMerge ✅ (2026-06-28)
- Step 3: Wiring LedgerMerge into CLI orchestrator ✅
- Step 4: Same-genesis merge for phpoc-web ✅ (2026-06-28)
- Step 5: Export/import seal & entry hash fix ✅ (2026-06-28)

## Other Resolved Issues

- Stale session cache trusted without verification ✅
- TTL cookie ignored for local-only ledgers ✅
- phpoc-web: Login blank screen (ErrorBoundary) ✅
- phpoc-web: Reauth overlay → TTL warning + landing redirect ✅
- phpoc-web: Remote sync settings not cleared on new ledger ✅
- New Task — One-off activity checkbox ✅
- Genesis mismatch override — Clear Remote & Overwrite ✅
- Genesis mismatch on Sync Now after cloud onboarding ✅
- Split-ledger prevention ✅
- Web re-rolls device cookie on every write ✅
- clearRemote() deletes wrong staging keys ✅
- Onboarding crash with TypeError ✅
