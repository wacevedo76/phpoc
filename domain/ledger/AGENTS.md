# Ledger Engine

## Purpose
Ledger chain building, block sealing and signing, chain verification, blind index management, summary policy hierarchy, and remote ledger block sync.

## Ownership
- `chain.py` — `LedgerChain`: block sealing, signing, append, truncate, verify
- `engine.py` — `LedgerEngine`: commit, verify, revert — unified public API
- `index_manager.py` — `IndexManager`: duration index by date/title
- `summary_policy.py` — `SummaryPolicy`: year/month summary block insertion
- `remote_sync.py` — `RemoteLedgerSync`: pull/push ledger blocks and index

## Local Contracts
- Block format must be byte-identical to `core/ledger.py` output (constraint O8)
- Chain structure: Genesis → (Year Summary → Month Summary)* → Day blocks
- Every block is sealed and signed (HMAC-SHA256 Ed25519-proxy)
- **Block seal = ADR-029a closed per-type table** (`chain.py` `SEAL_FIELDS` / `select_seal_fields`): genesis/day seal `{type, day_index, date, prev_hash, entries, original_hash}`; month_summary seals `{type, month, prev_hash, date, original_hash}`; year_summary seals `{type, year, prev_hash, date, original_hash}`. Non-whitelisted fields never sealed; unknown type rejects; `original_hash` optional-if-absent
- Blind index (`index.json`): `{date: {title: total_ms}}` — plaintext, queryable without decryption
- Content hash: SHA-256 of resolved plaintext fields — survives re-encryption
- Master Key = 32 bytes from base64-decoded seed (`RecoveryManager.seed_to_key`)

## Work Guidance
- Use `LedgerEngine` as the sole public API — never call chain methods directly from outside
- Verify after every commit
- Summary blocks are inserted on month/year boundary crossings

## Verification
- Tests: `test_phase3_ledger_engine.py`, `test_phase6b_ledger_equivalence.py`, `test_hierarchy.py`

## Child DOX Index
None — flat directory structure.
