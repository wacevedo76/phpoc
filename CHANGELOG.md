# Changelog

All notable changes to the PH Ledger (phpoc) project.

## [0.3.0] — Unreleased (Working Tree Changes)

### Fixed
- `core/factory.py`: Config directory now created before writing identity/ledger files — fixes `FileNotFoundError` on first `init`
- `cli/interface.py`: Removed duplicate `show_rep()` method that was overriding the first definition
- `cli/interface.py`: Fixed `list_habits()` — synced entries were collected but never printed; added `_print_entry()` helper and unified date iteration
- `main.py`: `verify` command now prints `True`/`False` result (was silently returning)

### Added
- `cli/interface.py`: `list_habits()` now splits into `{all, synced, staged}` subcommands with date filtering
- `cli/interface.py`: `show_rep()` extracted from duplicate code into standalone method
- `tests/test_modular.py`: Added tests for `list all`, `list synced`, `list staged`, and date filtering
- `IMPLEMENTATION_GUIDE.md`: Complete rewrite — organized by DESIGN_GOALS.md design principles with full command reference, auth model, file structure, and troubleshooting

---

## [0.2.0] — 641e10e

### Added
- **Lazy Authentication**: RAM-cached session (`/dev/shm/phpoc_session`) for "once-per-boot" passphrase entry
- `add start/end/oneoff` commands now work without passphrase using `NoAuthCryptoManager` (plain-text staging)
- `view` command works without authentication if cached session exists

### Changed
- `main.py`: Commands `sync, verify, rep, list, view` require auth; `add` commands use NoAuth fallback

---

## [0.1.0] — 1cda5c2

### Added
- **Sovereign Key Model**: 256-bit Recovery Seed generated on `init`; passphrase-derived key (PDK) encrypts the seed
- **Recovery Command**: `phpoc recover` — enter seed + set new passphrase; re-encrypts seed and re-seals Genesis
- **Identity System**: Ed25519-proxy (HMAC-SHA256) identity generated during `init`; private key stored encrypted in `identity.json`
- **Identity Signatures**: Every block (Genesis, Day, Month/Year Summary) signed with identity secret
- **Hierarchical Lock Chain**: Genesis → Year Summary → Month Summary → Day → Task, all sealed with HMAC
- **Encrypted Timestamps**: `startTime_enc` / `endTime_enc` in every task entry (AES-CTR)
- **Blind Duration Index**: `index.json` aggregates durations by date for private reputation queries
- **Session Auth**: RAM cache (`/dev/shm`) for Master Key
- `core/factory.py`: `LedgerFactory.initialize()` creates full ledger with identity
- `tests/test_recovery.py`: 2 tests covering seed generation and recovery flow
- `tests/test_hierarchy.py`: 2 tests covering hash chain and summary blocks

---

## [0.0.2] — 30287e4

### Changed
- Modularization checkpoint: split monolith into `core/`, `security/`, `storage/`, `cli/` packages
- Abstract storage interface (`AbstractLedgerStore`) for future database backends
- Abstract crypto interface (`AbstractCryptoManager`) allowing `NoAuthCryptoManager` fallback

---

## [0.0.1] — db5b3e4

### Added
- Initial proof-of-concept: single-file ledger with basic add/sync/list
- Genesis block creation with hardcoded identity
- PBKDF2 passphrase hashing
- Day sync with basic seal
- Verify command (chain traversal)
