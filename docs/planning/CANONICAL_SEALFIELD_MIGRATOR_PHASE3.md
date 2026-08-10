# Migrator Block-Seal Field Whitelist — GREEN (Phase 3)

> **Plan:** `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md`
> **Purpose:** Implement the fixes the RED suite surfaced (Group F unknown-type
> safety) so migration fails cleanly without corrupting the input ledger.
> **Status:** ✅ Phase 3 (GREEN: implementation) complete
> **Next Phase:** 🔜 Phase 4 (REFACTOR)

## Fix summary

Phase 2 (RED) found the seal-content assertions (A1/B1/C1/E1) were already
GREEN because `_seal_block` routes through `compute_seal` → the ADR-029a
whitelist. The **genuine RED** was Group F: an unknown/unsealable block type
caused a **corrupting write-then-raise** — Phase 2 skipped sealing it, wrote the
partially-migrated ledger (format_version already bumped to 0.4.0) to disk, then
`chain.verify()` raised `ValueError` before the restore ran, leaving the input
ledger modified.

Phase 3 rejects unknown block types **before anything is written**, making a
failed migration a true no-op on the input ledger.

| ID | Defect | Fix (this phase) | Result |
|----|--------|------------------|--------|
| F1 | Unknown block type → `execute()` writes partially-migrated ledger, then `chain.verify()` raises and the input file is left modified | `phpoc_cli/migrate_format.py:execute()`: new pre-validation loop (right after `_derive_crypto`) walks every block and raises `ValueError` when `_block_hash_key(block)` is `None` — i.e. not one of the 4 canonical types — BEFORE the backup and any write | Input ledger stays byte-identical on failure; `ValueError` raised cleanly |
| F2 | Failed migration left the ledger non-atomic (format_version bumped, unknown block appended) | Same pre-validation as F1 (no write path reachable for unknown types) | Failed migration is a no-op: bytes identical, `format_version` unchanged, unknown block still present in the (untouched) input |

## Files changed (Phase 3 GREEN)

| File | Change |
|------|--------|
| `phpoc_cli/migrate_format.py` | `execute()`: added unknown-block-type pre-validation loop that raises `ValueError` via `_block_hash_key` before backup/write |
| `docs/planning/CANONICAL_SEALFIELD_MIGRATOR_PHASE3.md` | this document |

## Verification (after fix)

```bash
# New seal-whitelist class — all 26 GREEN (F1/F2 now GREEN)
PYTHONPATH=. python3 -m pytest tests/test_migrate_format.py::TestMigrateFormatSealWhitelist   # 26 passed

# Whole migrate-format file — all 43 pass (no regressions)
PYTHONPATH=. python3 -m pytest tests/test_migrate_format.py                                    # 43 passed

# Full Python suite — no regression
PYTHONPATH=. python3 -m pytest tests/                                                           # 2586 passed, 1 skip, 0 fail
```

### Test-by-test final classification

**26/26 GREEN.** Previously-RED now GREEN: F1, F2. Already-GREEN regression
locks (verify seal content is routed through the canonical whitelist): A1–A7
(day), B1–B5 (genesis), C1–C4 (summaries), D1–D4 (e2e accept + closed-set guard),
E1–E4 (`_seal_block`/`_block_hash_key` contract).

### Design note — fail before touch

The migration previously performed destructive work (Phase 1 entry rewrites,
Phase 2 re-seal) then wrote and verified — so any post-write failure (e.g. the
`chain.verify()` `ValueError` on an unsealable block) could only be recovered
by an explicit restore, and that restore never ran on the when-`ValueError`
path. Hoisting the unknown-type rejection into pre-validation means `execute()`
can never enter the write path for a chain it cannot fully migrate — making the
"failed migration is a no-op" guarantee structural rather than dependent on the
verify/restore branch.
