# PH Ledger (phpoc) Implementation Guide

## Overview

PH Ledger is a privacy-first, zero-dependency personal history tracking system with cryptographic integrity. This guide provides comprehensive documentation for using and implementing the phpoc command-line interface.

---

## Design Goals Alignment

The PH Ledger is designed around five core architectural principles from DESIGN_GOALS.md:

### 1. Cryptographic Integrity & Immutability
- **Hierarchical Chain of Trust**: Genesis → Year → Month → Day → Task
- **Self-Bootstrapping**: Each block's validity depends on previous block's seal
- **Tamper Evidence**: Any modification triggers verification failure

### 2. Privacy & Anti-Forensics  
- **Zero-Knowledge Architecture**: Only user with master passphrase can decrypt data
- **Pattern-of-Life Protection**: Sensitive timestamps encrypted to prevent profiling
- **Blind Indexing**: Reputation queries without exposing exact timing

### 3. Scalability & Durability
- **Partitionable Ledger**: Supports truncation and archiving
- **I/O Optimization**: Hierarchical summary hashes for efficient verification
- **Data Sovereignty**: History reconstructible from constituent blocks

### 4. User Experience & Accessibility
- **Lazy Authentication**: RAM caching for "once-per-day" authentication
- **Modular Interfaces**: Headless engine usable by CLI, Web, or Mobile
- **Storage Independence**: Abstract storage layer supports JSON, SQL, or remote sync

### 5. Recovery & Identity
- **Recovery Seed**: 256-bit entropy seed for passphrase recovery
- **Sovereign Key Model**: All encryption rooted in Recovery Seed
- **Identity Signatures**: Every block signed by local Identity Key

---

## Available Commands

### Initialization & Recovery

#### `phpoc init`
Initialize a new ledger with your identity.

```bash
python3 main.py init
```
**Prompts for:**
- Username
- Email  
- Passphrase (set and confirm)

**Output:** Recovery Seed (SAVE THIS SECURELY!)
**Effect:** Creates XDG-resolved directories with:
- `ledger.json` (encrypted ledger chain)
- `identity.json` (encrypted identity secret)
- `staging.json` (temporary staging area)
- `index.json` (blind duration index)

Config file is auto-initialised on `init` with all default settings.

#### `phpoc recover`
Recover access using your Recovery Seed and set a new passphrase.

```bash
python3 main.py recover
```
**Flow:**
1. Enter Recovery Seed (base64 encoded)
2. Set new passphrase
3. Updates encrypted seed in ledger with new passphrase

**Use Case:** Lost passphrase recovery using your securely stored seed.

### Habit Tracking

#### `phpoc add start <title>`
Start tracking a new task.

```bash
python3 main.py add start "Deep Work"
```
**Effect:** Creates staged entry with current timestamp, marked as active.

#### `phpoc add end <title>`
End an active task.

```bash
python3 main.py add end "Deep Work"
```
**Effect:** Updates staged entry with end time and calculates duration.

#### `phpoc add oneoff`
Capture a completed task (start and end times provided).

```bash
python3 main.py add oneoff
```
**Prompts for:** Title, then calculates duration from 2 minutes ago to now.

### Data Management

#### `phpoc sync`
Finalize staged habits into the immutable ledger.

```bash
python3 main.py sync
```
**Effect:**
- Encrypts all staged entries (converts "plain:" to proper encryption)
- Groups by date
- Creates Day records with cryptographic seals
- Creates Month/Year summaries when crossing boundaries
- Updates blind index for reputation queries
- Clears completed tasks from staging (keeps active tasks)

#### `phpoc view`
View currently active (in-progress) tasks.

```bash
python3 main.py view
```
**Output:** List of tasks started but not yet ended.

### Verification & Integrity

#### `phpoc verify`
Verify the cryptographic integrity of the entire ledger.

```bash
python3 main.py verify
```
**Checks:**
- Hash chain continuity (prev_hash matches)
- Block seals (HMAC signatures)
- Identity signatures (if available)
- Entry hash consistency

**Output:** Success/failure message.

### Data Query & Analysis

#### `phpoc rep [days] [--from DATE] [--to DATE]`
Show reputation summary using blind index (fast and private).

```bash
# Last 7 days
python3 main.py rep 7

# Specific date range
python3 main.py rep --from 2024-01-01 --to 2024-01-31

# All time
python3 main.py rep
```
**Privacy:** Uses blind index (encrypted durations by date/title) without decrypting history.

#### `phpoc list <source> [days] [--from DATE] [--to DATE]`
List detailed habits with decryption (requires authentication).

**Sources:**
- `all`: Both synced and staged activities
- `synced`: Only ledger-synced activities  
- `staged`: Only staged (not yet synced) activities

```bash
# List all activities from last 30 days
python3 main.py list all 30

# List only synced activities for January 2024
python3 main.py list synced --from 2024-01-01 --to 2024-01-31

# List only staged activities
python3 main.py list staged
```
**Output:** Decrypted timeline with start/end times, durations, and metadata.

### Configuration Management

#### `phpoc config show`
Print the full active configuration as JSON. Shows user-set values merged over defaults.

```bash
python3 main.py config show
```

#### `phpoc config get <key>`
Read a single configuration value by dot-separated path.

```bash
python3 main.py config get auth.cache_timeout_minutes
```

#### `phpoc config set <key> <value>`
Write a single configuration value. The value is parsed as JSON; if that fails it is stored as a plain string.

```bash
python3 main.py config set auth.cache_timeout_minutes 60
python3 main.py config set remote.transport '"rsync"'
```

#### `phpoc config init`
Generate a fully-commented config template at the resolved config path. Every setting is present with its default value, commented out with `// `. To activate a setting, remove the leading `//`.

```bash
python3 main.py config init
```

**Template example:**
```json
  // How long to cache the passphrase before re-prompting
  // "cache_timeout_minutes": 30,
  // Set false to allow no-auth mode for add/start/end
  // "passphrase_required": true
```

The template body is valid JSON after stripping all `//`-prefixed lines.

#### `phpoc --config <path>`
Override the config file path for a single invocation (useful for testing or profiles).

```bash
python3 main.py --config /tmp/test-config.json init
python3 main.py --config /tmp/test-config.json add start "Deep Work"
```

#### `phpoc --dir <path>`
Override the data directory for a single invocation (useful for targeting a specific ledger).

```bash
# Verify a different ledger
python3 main.py --dir ~/work-ledger verify

# Initialize a new ledger in a custom location
python3 main.py --dir /mnt/usb/ledger init

# List activities from another data directory
python3 main.py --dir ./test-env list all
```

The `--dir` flag works with all commands and does not change the config file path — config and data directories remain independent.

---

## Path Resolution

The project follows the XDG Base Directory Specification with legacy fallback and full priority chain:

| Purpose | Resolution chain (highest → lowest) |
|---|---|
| **Config file** (`config.json`) | ① `--config` flag → ② `$PHPOC_CONFIG` → ③ `$XDG_CONFIG_HOME/phpoc/config.json` → ④ `~/.config/phpoc/config.json` |
| **Data directory** (ledger, staging, etc.) | ① `--dir` flag → ② `$PHPOC_DATA_DIR` → ③ `config storage.data_dir` → ④ `$XDG_DATA_HOME/phpoc/` → ⑤ `~/.local/share/phpoc/` → ⑥ `~/.config/personal_history_poc/` (legacy auto-detect) |

### Data Directory Priority Chain

| Priority | Source | Example | Scope |
|---|---|---|---|
| 1 (highest) | `--dir` CLI flag | `phpoc --dir /mnt/work verify` | Per-invocation |
| 2 | `$PHPOC_DATA_DIR` env var | `export PHPOC_DATA_DIR=/mnt/work` | Per-session |
| 3 | `storage.data_dir` in config | `phpoc config set storage.data_dir /mnt/work` | Persistent |
| 4 | `$XDG_DATA_HOME/phpoc/` | XDG spec standard path | System-wide default |
| 5 | `~/.local/share/phpoc/` | XDG fallback | System-wide default |
| 6 (lowest) | `~/.config/personal_history_poc/` | Legacy (auto-detect) | Backward compat |

### Config File Priority Chain

| Priority | Source | Example | Scope |
|---|---|---|---|
| 1 (highest) | `--config` CLI flag | `phpoc --config ./profile.json init` | Per-invocation |
| 2 | `$PHPOC_CONFIG` env var | `export PHPOC_CONFIG=/alt/config.json` | Per-session |
| 3 | `$XDG_CONFIG_HOME/phpoc/config.json` | XDG spec standard path | System-wide default |
| 4 (lowest) | `~/.config/phpoc/config.json` | XDG fallback | System-wide default |

---

## Authentication Model

### Lazy Authentication Flow
```
Command        Auth Required  Crypto Manager Used
--------       -------------  -------------------
init           No             N/A (creates new)
recover        No (seed)      N/A (recovery flow)
add start/end  Optional*      NoAuthCryptoManager or CryptoManager
view           Optional*      NoAuthCryptoManager or CryptoManager  
sync           Yes            CryptoManager
verify         Yes            CryptoManager
rep            Yes            CryptoManager (for index access)
list           Yes            CryptoManager (for decryption)
config *       No             N/A (filesystem)

* = Uses cached session if available, otherwise NoAuthCryptoManager
```

### Session Caching
- Successful authentication caches master key in RAM (`/dev/shm/phpoc_session`, chmod 600)
- Subsequent commands use cached session
- Cache persists until process exit or system reboot

---

## File Structure

### XDG-Compliant Layout (default)

```
~/.config/phpoc/
  config.json               # Configuration file (commented defaults)

~/.local/share/phpoc/
  ledger.json               # Encrypted hierarchical ledger (Genesis → Days)
  identity.json             # Encrypted identity secret + metadata  
  staging.json              # Temporary staging area (plain or encrypted)
  index.json                # Blind duration index for reputation queries
```

### Legacy Layout (auto-detected fallback)

```
~/.config/personal_history_poc/
  ledger.json
  identity.json
  staging.json
  index.json
```

The legacy path is used automatically if it exists and the new XDG data path does not. No migration script is needed — users can move files manually.

### Ledger Structure
```json
[
  {
    "type": "genesis",
    "day_index": 0,
    "date": "2024-01-01",
    "identity": {
      "username": "alice",
      "email": "alice@example.com",
      "recovery_seed_enc": "encrypted_base64_seed",
      "identity_pub_key": "sha256_of_identity_secret"
    },
    "prev_hash": "000...000",
    "entries": [],
    "day_hash": "genesis_seal",
    "signature": "identity_signature"
  },
  {
    "type": "day",
    "day_index": 1,
    "date": "2024-01-01",
    "prev_hash": "genesis_seal",
    "entries": [
      {
        "hash": "entry_hash",
        "data": {
          "title": "Deep Work",
          "duration": 3600000,
          "is_active": false,
          "startTime_enc": "encrypted_timestamp",
          "endTime_enc": "encrypted_timestamp",
          "metadata_enc": "encrypted_json"
        }
      }
    ],
    "day_hash": "day_seal",
    "signature": "identity_signature"
  }
]
```

---

## Implementation Examples

### First-time Setup
```bash
# Initialize the ledger
python3 main.py init
# → SAVE THE RECOVERY SEED printed to terminal

# Optionally review the config template
python3 main.py config show
```

### Basic Daily Workflow
```bash
# Start your day
python3 main.py add start "Morning Meditation"
# ... later
python3 main.py add end "Morning Meditation"

python3 main.py add start "Deep Work"
# ... 2 hours later  
python3 main.py add end "Deep Work"

# End of day
python3 main.py sync
python3 main.py rep  # Check today's progress
```

### Configuring Timeouts
```bash
python3 main.py config set auth.cache_timeout_minutes 60
python3 main.py config set timeouts.push_timeout_ms 10000
python3 main.py config show
```

### Weekly Review
```bash
# See week in review (private, fast)
python3 main.py rep 7

# Detailed review (decrypted)
python3 main.py list all 7
```

### Recovery Scenario
```bash
# Lost passphrase, have seed
python3 main.py recover
# Enter seed, set new passphrase
# Continue using ledger
```

---

## Config File Reference

The `config.json` file uses a commented template format. All settings are present with defaults; uncomment to change.

| Section | Key | Default | Description |
|---|---|---|---|
| `storage` | `config_dir` | `~/.config/phpoc` | Config file directory (informational, resolved dynamically) |
| `storage` | `data_dir` | *(not set — uses XDG)* | Data directory override (priority 3 in the chain — between `$PHPOC_DATA_DIR` and XDG defaults). Set via `phpoc config set storage.data_dir <path>` |
| `storage` | `ledger` | `ledger.json` | Ledger chain filename |
| `storage` | `staging` | `staging.json` | Staging filename |
| `storage` | `index` | `index.json` | Blind index filename |
| `storage` | `identity` | `identity.json` | Identity filename |
| `storage` | `config` | `config.json` | Config filename |
| `remote` | `staging_path` | `null` | Remote path for staging |
| `remote` | `ledger_path` | `null` | Remote path for ledger |
| `remote` | `transport` | `git` | Transport protocol |
| `remote` | `git_remote_url` | `null` | Git remote URL |
| `auth` | `cache_timeout_minutes` | `30` | Passphrase cache duration |
| `auth` | `passphrase_required` | `true` | Require passphrase for ops |
| `device` | `device_id` | `null` | Unique device identifier |
| `device` | `device_label` | `null` | Human-readable device label |
| `timeouts` | `remote_check_ms` | `500` | Remote change check interval |
| `timeouts` | `push_timeout_ms` | `5000` | Push operation timeout |
| `staging` | `blob_size_tier` | `64K` | Staging blob size limit |

---

## Security Considerations

### Critical: Save Your Recovery Seed
- The seed is your ONLY recovery mechanism
- Store offline in password manager or secure location
- Without seed + passphrase, data is permanently inaccessible

### Encryption Model
- **Recovery Seed (32 bytes)**: Ultimate root secret, encrypted in genesis block
- **Master Key (32 bytes)**: SHA-256 of seed — derived on auth, cached in `/dev/shm`
- **Encryption Key**: HMAC(master_key, "encryption-key") — used for AES-CTR
- **Integrity Key**: HMAC(master_key, "integrity-key") — used for HMAC-SHA256 auth tags
- **Identity Secret**: HMAC(master_key, "identity-secret") — Ed25519 proxy for block signing
- **Data Encryption**: AES-CTR with 16-byte random nonce + HMAC-SHA256 auth tag (Encrypt-then-MAC)
- **PBKDF2**: 600,000 iterations for passphrase-derived key (OWASP 2026 recommendation)

### Privacy Features
- **Timestamps Encrypted**: `startTime_enc`, `endTime_enc` prevent pattern analysis
- **Blind Index**: `index.json` allows duration sums without decryption
- **No Network Calls**: All operations local, zero telemetry
- **Encryption Suffix Convention**: Any field can be encrypted by appending `_enc` — no hardcoded field lists

---

## Testing

### Run Full Test Suite
```bash
cd /home/pi/phpoc
PYTHONPATH=. python3 -m unittest discover -s tests
```

**Current status:** 941 tests, 0 failures, 0 errors.

### Run Test File by Name
```bash
PYTHONPATH=. python3 -m unittest tests.test_modular
PYTHONPATH=. python3 -m unittest tests.test_phase7_config_integration
```

### Run Single Test
```bash
PYTHONPATH=. python3 -m unittest tests.test_phase7_config_integration.TestConfigInitCommand.test_template_is_valid_json_if_uncommented
```

### Test Organization
| File | Tests | Scope |
|---|---|---|
| `test_modular.py` | 1 | End-to-end init → add → sync → verify |
| `test_recovery.py` | 1 | Seed generation and recovery flow |
| `test_hierarchy.py` | 1 | Hash chain and summary block creation |
| `test_pause.py` | 1 | Pause/unpause duration cascades |
| `test_tags.py` | 1 | Tag normalization and listing |
| `test_sync_confirmation*.py` | 3 files | Sync strategy decisions |
| `test_phase1_storage_interfaces.py` | 1 file | Storage abstract interfaces |
| `test_phase1b_view_interface.py` | 1 file | View interface implementations |
| `test_phase2_staging_service.py` | 1 file | Staging service + device identity |
| `test_phase3_ledger_engine.py` | 1 file | Ledger engine + chain + index |
| `test_phase4_staging_interaction_flow.py` | 69 | Sync lifecycle, every-mutation test |
| `test_phase5_main_wiring.py` | 1 file | main.py wiring, CI strategies |
| `test_phase6a_staging_equivalence.py` | 1 file | staging service equivalence |
| `test_phase6b_ledger_equivalence.py` | 1 file | ledger engine equivalence |
| `test_phase6c_orchestrator_cli.py` | 1 file | orchestrator + CLI interaction |
| `test_phase7_config_integration.py` | 41 | Config commands, path resolution, template, `--dir` flag, `storage.data_dir` config key |

---

## Development

### Architecture (post-Phase 7)

```
phpoc/
├── main.py                     # CLI entry — argparse dispatch, --config, --dir, config commands
├── cli/
│   ├── interface.py            # CLI presentation (view_active, show_rep, list_habits, etc.)
│   └── strategies.py           # View-based InteractiveCLIStrategy
├── core/
│   ├── ledger.py               # Thin backward-compat wrapper over domain/ledger/engine
│   ├── factory.py              # LedgerFactory — init + identity creation
│   └── sync/
│       ├── __init__.py         # Package re-exports
│       ├── decision.py         # SyncDecision, SyncStrategy ABC
│       ├── orchestrator.py     # Sync lifecycle coordinator
│       └── transport.py        # AbstractStagingTransport interface
├── domain/
│   ├── ledger/
│   │   ├── __init__.py         # LedgerDomain facade
│   │   ├── engine.py           # LedgerEngine — commit, verify, revert
│   │   ├── chain.py            # Chain building, sealing, verification
│   │   ├── index_manager.py    # Blind index CRUD + rebuild
│   │   └── summary_policy.py   # Year/month summary transitions
│   └── staging/
│       ├── service.py          # StagingService — CRUD with crypto
│       ├── local_cache.py      # Caching for staging operations
│       ├── merge_engine.py     # Multi-device merge (skeleton)
│       └── remote_sync.py      # Remote sync (skeleton)
├── security/
│   ├── crypto.py               # AES-CTR + HMAC-SHA256, CryptoManager, NoAuthCryptoManager
│   ├── auth.py                 # PassphraseAuthenticator (PBKDF2 600K)
│   ├── recovery.py             # Seed generation, seed_to_key, encrypt/decrypt_seed
│   ├── config_manager.py       # ConfigManager — dot-notation, defaults, file I/O
│   └── device_identity.py      # DeviceIdentity — multi-device device metadata
├── storage/
│   ├── interface.py            # AbstractLedgerStore ABC
│   ├── file_store.py           # JSON file I/O (staging, ledger, index, identity)
│   ├── config_store.py         # AbstractConfigStore ABC
│   ├── identity_store.py       # AbstractIdentityStore ABC
│   ├── index_store.py          # AbstractIndexStore ABC
│   ├── staging_store.py        # AbstractStagingStore ABC
│   ├── ledger_store.py         # AbstractLedgerStore ABC
│   └── implementations/
│       ├── file_config.py      # FileConfigStore + _resolve_config_path + _resolve_data_dir
│       ├── file_identity.py    # FileIdentityStore
│       ├── file_index.py       # FileIndexStore
│       ├── file_ledger.py      # FileLedgerStore
│       └── file_staging.py     # FileStagingStore
├── tests/                      # 16 test files, 936 tests
└── scripts/
    ├── migrate_format_version.py  # v0.2.0→v0.3.0→v0.4.0 format migration
    └── repair_staging.py       # hex-encrypted → plain: conversion
```

### Adding New Commands
1. Add parser in `main.py` (add subparser, or extend `_handle_config_command` for config actions)
2. Implement business logic in the appropriate domain module
3. Add CLI presentation in `cli/interface.py`
4. Write tests in `tests/`

### Cryptographic Extensions
The `AbstractCryptoManager` allows swapping implementations:
- `CryptoManager`: Real AES-CTR encryption with master key
- `NoAuthCryptoManager`: Plain-text staging for unauthenticated adds

### Storage Layer
The project now has abstract store interfaces for each data type. All implementors follow the same pattern:

| Interface | File Implementation | Data |
|---|---|---|
| `AbstractConfigStore` | `FileConfigStore` | `config.json` |
| `AbstractLedgerStore` | `FileLedgerStore` | `ledger.json` |
| `AbstractStagingStore` | `FileStagingStore` | `staging.json` |
| `AbstractIndexStore` | `FileIndexStore` | `index.json` |
| `AbstractIdentityStore` | `FileIdentityStore` | `identity.json` |

---

## Roadmap (Next Steps)

### P1 — Proof of Concept (Rust or TypeScript)
Re-implement the core ledger format in a second language to validate the spec.

### P2 — Portable Export
`phpoc export --range` produces a verifiable chain segment without the full ledger.

### P3 — Remote Sync (git-based)
Implement `AbstractStagingTransport` + `GitStagingTransport` for multi-device staging.

### P4 — Archived Config with `//` Suffix Convention
Extend the `//`-prefix convention from config to broader ledger documentation.

### P5 — Media Linkage
Interface to link content hashes (video/audio) to activities during sync.

---

## Troubleshooting

### Common Issues

#### "Passphrase required for this operation"
- You're trying to run `sync`, `verify`, `rep`, or `list` without authentication
- Solution: The system should prompt for passphrase automatically

#### "No active task found for: <title>"
- You're trying to end a task that wasn't started or already ended
- Check active tasks with `phpoc view`

#### Ledger verification fails
- Possible data corruption or tampering
- Check `ledger.json` structure
- Ensure you're using correct passphrase

#### "ModuleNotFoundError: No module named 'core'"
```bash
export PYTHONPATH=$PYTHONPATH:.
# or
cd /home/pi/phpoc && PYTHONPATH=/home/pi/phpoc python3 main.py
```

---

## Support

### Getting Started
1. `phpoc init` to create your ledger
2. **SAVE THE RECOVERY SEED**
3. Start tracking with `phpoc add start/end`
4. Regular `phpoc sync` to commit to ledger

### Design Philosophy
- **Zero Dependencies**: Pure Python standard library
- **User Sovereignty**: You control all keys and data
- **Privacy by Design**: Encrypt everything, expose minimum
- **Cryptographic Integrity**: Tamper-evident chain of trust

---

*Implementation Guide v3.0 — PH Ledger (phpoc) — 13 May 2026 (post-Phase 7)*
