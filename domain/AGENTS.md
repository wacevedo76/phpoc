# Domain Logic

## Purpose
Core business logic for the PH Ledger — ledger chain building and verification, staging service, cross-device merge, device cookies, and view interfaces.

## Ownership
- `domain/ledger/` — Ledger chain, engine, index manager, summary policy, remote sync
- `domain/staging/` — Staging service, remote sync, merge engine, local cache
- `domain/cookie/` — Device cookie for cross-device session detection
- `domain/interfaces/` — Abstract view interface

## Local Contracts
- Domain modules must not import from `phpoc_cli/` (no UI dependencies)
- Domain modules may import from `security/`, `storage/`
- Staging format uses `NoAuthCryptoManager` with `"plain:..."` prefix
- Sync converts hex-encrypted → plain: at the boundary
- Block format must be byte-identical to output of `core/ledger.py` (constraint O8)

## Work Guidance
- Ledger chain: Genesis → Year Summary → Month Summary → Day blocks, each sealed + signed
- Content hash: SHA-256 of resolved plaintext fields — survives re-encryption
- Merge engine deduplicates by `entry_id`
- Never import from phpoc_cli/ or main.py

## Verification
- Tests: `test_phase2_staging_service.py`, `test_phase3_ledger_engine.py`, `test_phase4_staging_interaction_flow.py`, `test_phase6a_staging_equivalence.py`, `test_phase6b_ledger_equivalence.py`

## Child DOX Index
- `domain/ledger/` — Ledger chain, engine, index, summaries
- `domain/staging/` — Staging service, remote sync, merge
