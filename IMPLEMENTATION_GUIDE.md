# PH Ledger (phpoc) Implementation Guide

## Overview

PH Ledger is a privacy-first, zero-dependency personal history tracking system with cryptographic integrity. This guide provides comprehensive documentation for using and implementing the phpoc command-line interface.

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
**Effect:** Creates `~/.config/personal_history_poc/` with:
- `ledger.json` (encrypted ledger)
- `identity.json` (encrypted identity secret)
- `staging.json` (temporary staging area)
- `index.json` (blind duration index)

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

* = Uses cached session if available, otherwise NoAuthCryptoManager
```

### Session Caching
- Successful authentication caches master key in RAM (`/dev/shm`)
- Subsequent commands use cached session
- Cache persists until system reboot or manual clearance

## File Structure

### Configuration Directory
`~/.config/personal_history_poc/`

```
ledger.json      # Encrypted hierarchical ledger (Genesis → Days)
identity.json    # Encrypted identity secret + metadata  
staging.json     # Temporary staging area (plain or encrypted)
index.json       # Blind duration index for reputation queries
```

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

## Implementation Examples

### Basic Daily Workflow
```bash
# Start your day
phpoc add start "Morning Meditation"
# ... later
phpoc add end "Morning Meditation"

phpoc add start "Deep Work"
# ... 2 hours later  
phpoc add end "Deep Work"

# End of day
phpoc sync
phpoc rep  # Check today's progress
```

### Weekly Review
```bash
# See week in review (private, fast)
phpoc rep 7

# Detailed review (decrypted)
phpoc list all 7
```

### Recovery Scenario
```bash
# Lost passphrase, have seed
phpoc recover
# Enter seed, set new passphrase
# Continue using ledger
```

## Security Considerations

### Critical: Save Your Recovery Seed
- The seed is your ONLY recovery mechanism
- Store offline in password manager or secure location
- Without seed + passphrase, data is permanently inaccessible

### Encryption Model
- **Master Key**: 32-byte key derived from Recovery Seed
- **Passphrase**: Unlocks encrypted seed in ledger (PDK → decrypt seed → Master Key)
- **Identity Secret**: Ed25519-proxy for signing blocks
- **Data Encryption**: AES-CTR with unique nonce per encryption

### Privacy Features
- **Timestamps Encrypted**: `startTime_enc`, `endTime_enc` prevent pattern analysis
- **Blind Index**: `index.json` allows duration sums without decryption
- **No Network Calls**: All operations local, zero telemetry

## Testing

### Run Test Suite
```bash
export PYTHONPATH=$PYTHONPATH:.
python3 tests/test_modular.py
python3 tests/test_recovery.py  
python3 tests/test_hierarchy.py
```

### Test Coverage
- **test_modular.py**: Core functionality (encryption, ledger operations, listing)
- **test_recovery.py**: Seed generation and recovery flow
- **test_hierarchy.py**: Hash chain and summary block creation

## Development

### Architecture
```
phpoc/
├── core/
│   ├── ledger.py      # Business logic (capture, sync, verify)
│   └── factory.py     # Ledger initialization
├── security/
│   ├── crypto.py      # AES-CTR, HMAC, abstract crypto interface
│   ├── auth.py        # Passphrase and recovery authentication
│   └── recovery.py    # Seed generation and management
├── storage/
│   ├── interface.py   # Abstract storage interface
│   └── file_store.py  # JSON file implementation
├── cli/
│   └── interface.py   # CLI presentation layer
├── tests/             # Integration tests
└── main.py           # Entry point with argument parsing
```

### Adding New Commands
1. Add parser in `main.py`
2. Implement business logic in `core/ledger.py` if needed
3. Add CLI presentation in `cli/interface.py`
4. Write tests in `tests/`

### Cryptographic Extensions
The `AbstractCryptoManager` allows swapping implementations:
- `CryptoManager`: Real encryption with master key
- `NoAuthCryptoManager`: Plain-text staging for unauthenticated adds

## Roadmap (Next Steps)

### 1. Media Linkage
Interface to link content hashes (video/audio) to activities during sync.

### 2. Reconciliation Logic  
"Chain-Bridging" to link orphaned activity blocks back to master genesis.

### 3. Remote Sync
`sync/git_sync.py` to backup signed ledger blocks to git repository.

### 4. Archival Automation
`phpoc archive --year X` to partition ledger by year.

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

*Implementation Guide v2.0 - PH Ledger (phpoc) - April 23, 2026*