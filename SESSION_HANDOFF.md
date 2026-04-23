# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` — all commits merged, working tree has uncommitted fixes
- **Tests:** 16/16 passing (test_modular: 12, test_hierarchy: 2, test_recovery: 2)
- **Dependencies:** Pure Python 3.x standard library — zero external deps

## Recent Fixes (uncommitted)
- `core/factory.py`: Fixed `mkdir()` ordering — identity file was written before config dir existed
- `cli/interface.py`: Removed duplicate `show_rep()` method; fixed `list_habits()` — was collecting synced entries but never printing them; extracted `_print_entry()` helper
- `main.py`: `verify` command now prints `True`/`False` instead of silent return

## Crypto Architecture Checklist
| Feature | Status | Notes |
|---|---|---|
| Sovereign Key Model (Seed → Master Key) | ✅ | Seed generated from 32 bytes urandom |
| Passphrase wraps Seed (PDK encrypted) | ✅ | PBKDF2(passphrase, "session-salt") |
| Identity Ed25519-proxy (HMAC-SHA256) | ✅ | Secret encrypted with Master Key |
| Block signing (all block types) | ✅ | Genesis, Day, Month/Year Summary |
| Encrypted timestamps (start/end) | ✅ | AES-CTR with unique nonce per field |
| Blind duration index (index.json) | ✅ | Fast rep queries without decryption |
| Session RAM cache (/dev/shm) | ✅ | One auth per boot |

## Chain Structure
```
Genesis (sealed + signed)
  └── Year Summary (sealed + signed)
        └── Month Summary (sealed + signed)
              └── Day (sealed + signed)
                    └── Entries (hashed individually)
```

## CLI Commands
| Command | Auth Required | Description |
|---|---|---|
| `init` | No | Creates ledger + identity + seed |
| `recover` | No (seed) | Seed-based passphrase reset |
| `add start <title>` | Optional | Starts active task |
| `add end <title>` | Optional | Ends active task |
| `add oneoff` | Optional | Captures completed task |
| `view` | Optional | Shows running tasks |
| `sync` | Yes | Commits staging → immutable ledger |
| `verify` | Yes | Full chain integrity check |
| `rep [days] [--from] [--to]` | Yes | Blind-index reputation summary |
| `list {all,synced,staged} [days]...` | Yes | Decrypted detailed listing |

## Roadmap (Unstarted)
1. **Media Linkage** — Link content hashes (video/audio) to activities
2. **Reconciliation** — Chain-bridging for orphaned blocks
3. **Remote Sync** — `sync/git_sync.py` for git-based backup
4. **Archival** — `phpoc archive --year X` for ledger partitioning

See `CHANGELOG.md` for full history and `ROADMAP.md` for detailed planning.
