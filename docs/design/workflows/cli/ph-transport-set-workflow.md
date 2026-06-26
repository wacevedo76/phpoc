# ph transport — Transport Configuration Workflow

> Map: code locations for `ph transport show` and `ph transport set <git|http> [cloudflare]`.
> Every remote-capable `ph` command (sync, push, pull, pull-remote-ledger) depends on
> a transport being configured. Without one, the CLI operates locally only.

## Module Map

| File | Concern |
|---|---|
| `main.py:245-252` | Argparse setup — `transport` command, subparsers, `transport_type` + `http_provider` args |
| `main.py:555-556` | Dispatch → `cli/transport_cmd.run_transport_command()` |
| `cli/transport_cmd.py` | Full transport management: `_show_transport`, `_set_transport`, `_switch_to_git`, `_switch_to_http_generic`, `_switch_to_cloudflare` |
| `security/config_manager.py` | `ConfigManager` — reads/writes `~/.config/phpoc/config.json` with DEFAULTS merge |
| `storage/implementations/file_config.py` | `FileConfigStore` — file-backed `AbstractConfigStore` |
| `storage/config_store.py` | `AbstractConfigStore` — interface for config read/write |
| `core/sync/transport.py` | `create_transport_from_config()` — factory that instantiates transport from config settings |
| `core/sync/transport_registry.py` | `TransportProvider` registry — used by onboarding for provider-prompted setup |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync` — pull blocks, list remote, get remote block count, verify chain |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — blob obfuscation/deobfuscation (used by RemoteLedgerSync) |
| `security/auth.py` | `PassphraseAuthenticator` — required to decrypt remote genesis for seed comparison |
| `security/recovery.py` | `RecoveryManager` — decrypt_seed, seed_to_key for genesis seed extraction |
| `security/crypto.py` | `CryptoManager` — verify_seal for genesis integrity check |

## Data Paths

| Path | Content |
|---|---|
| `~/.config/phpoc/config.json` | User-editable config (transport, HTTP, auth, storage sections) |
| `~/.local/share/phpoc/ledger.json` | Ledger chain (unaffected by transport change; read for seed comparison) |
| `~/.local/share/phpoc/staging.json` | Staging entries (unaffected by transport change) |
| `/dev/shm/phpoc_session` | Cached master key (read for seed comparison; unaffected by transport change) |

## Transport Config Fields

| Dot Path | Type | Values | Written By |
|---|---|---|---|
| `remote.transport` | string | `"git"` (default), `"http"` | All `_switch_to_*` |
| `remote.git_remote_url` | string or null | Git SSH URL | `_switch_to_git` |
| `http.provider` | string or null | `"cloudflare"`, `"generic"`, null | `_switch_to_http_generic`, `_switch_to_cloudflare` |
| `http.base_url` | string or null | HTTP base URL | `_switch_to_http_generic`, `_switch_to_cloudflare` |
| `http.api_key` | string or null | API key (stored), or null (env var) | `_switch_to_http_generic`, `_switch_to_cloudflare` |

## Decision Tree — `ph transport show`

```
1. Read config:
   ├─ remote.transport = ?
   ├─ remote.git_remote_url = ?
   ├─ http.provider = ?
   ├─ http.base_url = ?
   ├─ http.api_key = ?
   └─ $PHPOC_CLOUDFLARE_API_KEY = ?

2. Display header + transport type

3. Branch by transport:
   ├─ git →
   │   ├─ Print git_remote_url or "(not set)"
   │   └─ Print switch hints ("To switch to HTTP transport: …")
   │
   └─ http →
       ├─ Print provider (or "generic")
       ├─ Print base_url or "(not set)"
       ├─ Print API key status:
       │   ├─ api_key in config → "****  (from config file)"
       │   ├─ $PHPOC_CLOUDFLARE_API_KEY → "****  (from $PHPOC_CLOUDFLARE_API_KEY)"
       │   └─ neither → "(not set)"
       ├─ If cloudflare → print Worker endpoint tables (GET/PUT/prefix)
       └─ Print switch hint ("To switch back to git transport: …")
```

## Decision Tree — `ph transport set git`

```
1. Read current config:
   current_url = config.get("remote.git_remote_url")

2. Branch:
   ├─ current_url is None/empty →
   │   ├─ Prompt: "Git remote URL: "
   │   ├─ User enters empty? → "No URL entered. Transport not changed." → EXIT
   │   └─ User enters URL → continue
   │
   └─ current_url exists →
       ├─ Print: "Current git remote: <url>"
       ├─ Prompt: "Change URL? (y/N): "
       ├─ Answer "y" → Prompt for new URL (empty → keep existing)
       └─ Answer != "y" → keep existing URL

3. config.write({
       remote: { transport: "git", git_remote_url: url },
       http:    { provider: null, base_url: null, api_key: null }
   })

4. Print confirmation + SSH keys note + env var note
```

## Decision Tree — `ph transport set http` (generic)

```
1. Print endpoint requirements:
   ├─ GET  /{path}           → 200 + body | 404
   ├─ PUT  /{path}           → 200 | 413
   ├─ GET  /?prefix={prefix} → 200 + JSON array
   └─ GET with If-None-Match → 304 (zero-byte sync)

2. Prompt: "Base URL (e.g. https://phpoc.example.com): "
   ├─ Empty → "No URL entered. Transport not changed." → EXIT
   └─ Non-empty → strip trailing slash → continue

3. Prompt: "API key (optional, press Enter to use env var): "
   ├─ Empty → api_key = null (use $PHPOC_CLOUDFLARE_API_KEY)
   └─ Non-empty → api_key = value

4. config.write({
       remote: { transport: "http" },
       http:    { provider: "generic", base_url: base_url, api_key: api_key }
   })

5. Print confirmation (base URL, key source) + verify hint
```

## Decision Tree — `ph transport set http cloudflare`

```
1. Print Cloudflare Worker deployment instructions:
   ├─ cd worker && npm install
   ├─ npx wrangler login
   ├─ npx wrangler secret put PHPOC_API_KEY
   ├─ npx wrangler deploy
   └─ Copy Worker URL from deploy output

2. Prompt: "Ready to continue? (Y/n): "
   ├─ "n" → "Transport not changed." → EXIT
   └─ otherwise → continue

3. Prompt: "Worker URL (e.g. https://phpoc-staging.username.workers.dev): "
   ├─ Empty → EXIT
   └─ Non-empty → strip trailing slash → continue

4. Prompt: "API key (optional, press Enter to use env var): "
   ├─ Empty → api_key = null, "Using $PHPOC_CLOUDFLARE_API_KEY from environment at runtime."
   └─ Non-empty → api_key = value

5. config.write({
       remote: { transport: "http" },
       http:    { provider: "cloudflare", base_url: base_url, api_key: api_key }
   })

6. Print confirmation (base URL, key source) + verify hint:
   "To verify it works, run: ph sync"
   "To deploy Worker updates: cd worker && npx wrangler deploy"
```

## Transport Activation — Post-Set Flow

After `config.write()` succeeds, the transport is immediately available for the next
`ph` command invocation. On the next run, `main.py:291` calls:

```
global_transport = create_transport_from_config(config_with_dir)
```

Which branches:

```
create_transport_from_config(config):
  ├─ config.get("remote.transport") == "http" AND config.get("http.base_url") →
  │   └─ HttpStagingTransport(base_url, api_key)
  ├─ config.get("remote.transport") == "git" AND config.get("remote.git_remote_url") →
  │   └─ GitStagingTransport(git_remote_url)
  └─ neither → None (local-only mode)
```

If transport is `None`, commands like `ph sync`, `ph push`, `ph pull` operate locally.

## Key Invariants

1. **Transport write is destructive** — `_switch_to_git` clears HTTP fields; `_switch_to_http_*` clears git fields. Both always write `remote.transport`.
2. **API key dual-source** — if `http.api_key` is null at runtime, `HttpStagingTransport` falls back to `$PHPOC_CLOUDFLARE_API_KEY` env var. If both are null, HTTP requests fail.
3. **Config file is optional** — if `~/.config/phpoc/config.json` doesn't exist, all values come from `ConfigManager.DEFAULTS` (`transport: "git"`, `git_remote_url: null`). The CLI operates locally until transport is set.
4. **Transport change does not affect data** — switching transport never touches `ledger.json`, `staging.json`, `index.json`, or the session cache. Only `config.json` is written.
5. **HTTP endpoint contract** — the server must implement GET/PUT `/{path}` and GET `/?prefix={prefix}` (array response). Cloudflare Workers are the reference implementation.
6. **No connectivity test on set** — `ph transport set` does NOT validate the URL or API key. Validation happens on first `ph sync`. (Unlike `ph onboarding http` which tests connectivity.)
7. **ConfigManager.write() merges** — writing `{"remote": {"transport": "git"}}` merges with current config, so existing `storage`, `auth`, `device` sections are preserved.
8. **Genesis seed = identity** — two ledgers share an identity iff their genesis `identity.recovery_seed_enc` decrypts to the same seed. Same seed → same master key → same user.
9. **Deobfuscation = same-MK test** — if the local master key can deobfuscate the remote genesis block, the two ledgers share the same identity. If deobfuscation fails, the remote has a different master key (different identity).
10. **Empty remote is safe** — if `get_remote_block_count() == 0`, the remote has no ledger. Pushing is always safe. No seed comparison needed.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | Config file exists? | `~/.config/phpoc/config.json` is readable JSON |
| 2 | Transport correctly set? | `config.get("remote.transport")` returns `"git"` or `"http"` |
| 3 | HTTP fields populated? | When transport=HTTP: `http.base_url` is non-null string |
| 4 | Git fields populated? | When transport=git: `remote.git_remote_url` is non-null string |
| 5 | Old transport fields cleared? | When git: `http.{provider,base_url,api_key}` all null. When HTTP: `remote.git_remote_url` may still exist |
| 6 | Transport factory works? | `create_transport_from_config(config)` returns non-None |
| 7 | API key source correct? | If `http.api_key` is null, `$PHPOC_CLOUDFLARE_API_KEY` env var is set |
| 8 | Config merge idempotent? | Setting same transport twice produces same config values |
| 9 | Remote reachable? | `transport.list_files("ledger/blocks/")` returns without timeout/error |
| 10 | Remote block count known? | `remote_sync.get_remote_block_count()` returns >= 0 |
| 11 | Genesis seed match? | `local_seed_str == remote_seed_str` after decrypting both genesis `recovery_seed_enc` |
| 12 | Deobfuscation passes? | `RemoteStagingSync._deobfuscate(raw, mk)` returns non-None bytes (same-MK proof) |
| 13 | Local genesis decryptable? | `RecoveryManager.decrypt_seed(local_genesis.recovery_seed_enc, pdk)` succeeds |
| 14 | Remote genesis integrity? | `CryptoManager.verify_seal(jsonSort(remote_genesis), remote_genesis.day_hash)` returns True |

## Ledger-Aware Transport Set — Extended Verification Layer

> **Design proposal.** Currently `ph transport set` writes config blindly (Known Gap #1).
> This extension adds a post-URL ledger check that probes the remote for an existing
> ledger, compares genesis seeds, and guides the user through the resulting scenarios.

The verification runs after URL collection but before `config.write()`. It creates
a temporary transport, probes the remote for a ledger, and branches on three scenarios.

### Pre-Flight — Auth Gate

```
To inspect the remote ledger, we need access to:
  ┌─ Local master key (for deobfuscating remote genesis)        ← from session cache or passphrase prompt
  └─ Remote connectivity (for listing/pulling blocks)            ← from the URL just entered

IF no local ledger exists:
  → Remote genesis can't be compared against anything local
  → Still probe remote to discover if a ledger IS there
  → If remote has a ledger → prompt for recovery seed to inspect it
  IF local ledger exists AND no session cache exists:
  → Prompt for passphrase (or recovery seed if no local auth)
  → Derive master key from session cache or passphrase prompt
```

### Verification Step — Probe Remote Ledger

```
After URL is collected and transport is instantiated:

   1. CREATE temporary transport:
        transport = create_transport_from_config(tentative_config)
        │
        ├── transport is None → ❌ "Cannot connect. Transport not changed." → EXIT
        └── transport is not None → continue

   2. PROBE remote for ledger blocks:
        remote_sync = RemoteLedgerSync(transport, master_key)
        │
        ├── CONNECTIVITY CHECK
        │   ├── Timeout/network error → "Cannot reach remote at <url>."
        │   │   ├── Retry? → loop to step 2
        │   │   └── Cancel → "Transport not changed." → EXIT
        │   └── Reachable → continue
        │
        └── remote_count = remote_sync.get_remote_block_count()
            │
            ├── remote_count == 0 → ✨ EMPTY REMOTE
            └── remote_count > 0  → 📦 REMOTE HAS LEDGER
```

### Scenario A — No Local Ledger (fresh device / `ph init` not yet run)

```
local_ledger = try json.load(ledger.json) → None or empty

   A1. Remote has NO ledger (remote_count == 0)
       ┌─────────────────────────────────────────────────────────┐
       │ ✓  Both sides are empty — clean fresh setup.            │
       │    Transport will be saved. Run 'ph init' to create      │
       │    a local ledger, then 'ph sync' to push it.            │
       └─────────────────────────────────────────────────────────┘
       → config.write() → "Transport set and verified."

   A2. Remote HAS a ledger (remote_count > 0)
       ┌─────────────────────────────────────────────────────────┐
       │ ℹ   Remote has <N> ledger block(s) but no local ledger. │
       │     To inspect the remote ledger identity:              │
       └─────────────────────────────────────────────────────────┘
       Prompt: "Do you have a recovery seed for this remote?"
       │
       ├── No → "Transport set (remote ledger not inspected).    │
       │          Run 'ph onboarding http' to import it."         │
       │          → config.write() with remote ledger known flag  │
       │
       └── Yes → Prompt for recovery seed
                → Derive mk from seed
                → Pull genesis block: remote_sync.pull_blocks(local_blocks=None)
                → Decrypt genesis identity_secret_enc_fallback with mk
                │
                ├── Decrypt succeeds → Display remote identity
                │   ┌────────────────────────────────────────────┐
                │   │  Remote Identity:                          │
                │   │    Username:  <user>                       │
                │   │    Email:     <email>                      │
                │   │    Blocks:    <N>                          │
                │   │                                           │
                │   │  Save transport and run:                   │
                │   │    ph onboarding http                     │
                │   │  to import the full remote ledger.         │
                │   └────────────────────────────────────────────┘
                │   → config.write() (transport saved, ledger not imported)
                │
                └── Decrypt fails → "Recovery seed does not match
                                       this remote ledger."
                   → Retry seed? / Cancel → config.write() anyway
```

### Scenario B — Local Ledger Exists

```
local_ledger = json.load(ledger.json)  (at least genesis block)
local_genesis = local_ledger[0]
local_seed_enc = local_genesis["identity"]["recovery_seed_enc"]

AUTH CHECK: master key available?
   ├── Session cache exists → decrypt local seed → local_seed_str
   └── No cache → prompt for passphrase → derive PDK → decrypt seed → mk

   B1. Remote has NO ledger (remote_count == 0)
       ┌─────────────────────────────────────────────────────────┐
       │ ✨  Remote is empty. Your local ledger has              │
       │     <N> blocks ready to push.                           │
       │                                                         │
       │     On next 'ph sync', the full chain will be pushed.   │
       │     Genesis block is pushed once (immutable).           │
       └─────────────────────────────────────────────────────────┘
       → config.write() → "Transport set. Remote is empty — ready for first sync."

   B2. Remote HAS a ledger (remote_count > 0)
       → Pull genesis block (000000.json) from remote
       → Deobfuscate with local master key
       │
       ├── DEOBFUSCATION SUCCEEDS → Same master key works on remote
       │   → Extract remote seed:
       │       remote_genesis = json.loads(deobfuscated)
       │       remote_seed_enc = remote_genesis["identity"]["recovery_seed_enc"]
       │   → Compare seeds:
       │       local_seed_str == remote_seed_str?
       │       │
       │       ├── SAME SEED → B2a: Matching identity
       │       └── DIFFERENT SEED → B2b: Divergent identity
       │
       └── DEOBFUSCATION FAILS → Local master key can't decrypt remote
           → The remote ledger was created with a different identity
           → This IS a different genesis seed scenario
           → Fall through to B2b

   B2a. SAME GENESIS SEED — Matching Identity
        ┌─────────────────────────────────────────────────────────┐
        │ ✓  Same identity on both sides.                        │
        │                                                         │
        │    Local:   <N_local> blocks, user: <username>          │
        │    Remote:  <N_remote> blocks, user: <username>         │
        │                                                         │
        │    The remote has the same genesis seed. Sync will      │
        │    merge chains normally. No conflicts expected.        │
        │                                                         │
        │    On next 'ph sync':                                   │
        │      - Pull any remote blocks you don't have            │
        │      - Push any local blocks remote doesn't have        │
        │      - Merge staging                                    │
        └─────────────────────────────────────────────────────────┘
        → config.write() → "Transport set. Ledgers match — ready to sync."

   B2b. DIFFERENT GENESIS SEED — Identity Conflict
        ┌─────────────────────────────────────────────────────────┐
        │ ⚠   The remote ledger has a DIFFERENT genesis seed.    │
        │                                                         │
        │    Your local identity is NOT the same as the remote.   │
        │    Syncing these two ledgers would create conflicts.    │
        │                                                         │
        │    Options:                                             │
        └─────────────────────────────────────────────────────────┘
        Prompt user:
        ┌─────────────────────────────────────────────────────────┐
        │  The remote at <url> contains a ledger with a           │
        │  different identity than your local ledger.             │
        │                                                         │
        │  [1] Keep local, set transport (remote ignored)         │
        │      → Transport is saved. ph sync will push your       │
        │        local chain, overwriting the remote.             │
        │      → WARNING: Remote data will be LOST.               │
        │                                                         │
        │  [2] Import remote as new identity                      │
        │      → Run 'ph onboarding http' to pull the remote      │
        │        ledger into a new data directory.                │
        │      → Your local ledger is preserved at its current    │
        │        location. Use --dir to switch between them.      │
        │                                                         │
        │  [3] Cancel — do not change transport                   │
        │      → Transport is not changed.                        │
        │                                                         │
        └─────────────────────────────────────────────────────────┘
        │
        ├── [1] Keep local → config.write() with force-push note
        │       "Transport set. WARNING: remote has different identity.
        │        On first sync, remote ledger will be overwritten."
        │
        ├── [2] Import remote → Save transport to config
        │       → Print onboarding instructions
        │       "Transport saved.
        │        To import the remote ledger: ph onboarding http"
        │
        └── [3] Cancel → "Transport not changed." → EXIT
```

### Scenario Summary Table

| Local Ledger | Remote Ledger | Genesis Seed | Outcome | User Action |
|---|---|---|---|---|
| ❌ None | ❌ None | N/A | Fresh setup on both sides | Save transport, `ph init` later |
| ❌ None | ✅ Exists | N/A | Remote import opportunity | Optionally inspect identity; `ph onboarding http` |
| ✅ Exists | ❌ None | N/A | Push local to fresh remote | Save transport, `ph sync` pushes |
| ✅ Exists | ✅ Exists | Same | Match — sync ready | Save transport, `ph sync` merges |
| ✅ Exists | ✅ Exists | Different | ⚠ Identity conflict | [1] Overwrite remote / [2] Import as new / [3] Cancel |

### New Modules (added to Module Map above)

| File | Concern |
|---|---|
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync.get_remote_block_count()` — count blocks; `pull_blocks(None)` — fetch genesis |
| `domain/staging/remote_sync.py` | `RemoteStagingSync._deobfuscate()` — decrypt remote genesis blob |
| `security/auth.py` | `PassphraseAuthenticator.authenticate()` — derive MK to decrypt local seed |
| `security/recovery.py` | `RecoveryManager.decrypt_seed()` — decrypt seed from genesis; `seed_to_key()` — derive MK |
| `security/crypto.py` | `CryptoManager.verify_seal()` — validate genesis integrity after deobfuscation |

## Known Gaps

1. **No connectivity test on `ph transport set`** — unlike `ph onboarding http`, `ph transport set` does not verify the URL or API key. Users must run `ph sync` to discover misconfigured endpoints.
2. **Git transport uses SSH only** — no HTTPS git support; assumes SSH keys are configured.
3. **No multi-transport fallback** — only one transport active at a time. No automatic failover from HTTP to git or vice versa.
4. **API key rotation not supported** — to change an HTTP API key, re-run `ph transport set http` and re-enter all fields. No dedicated `ph transport rotate-key` command.
5. **Cloudflare Worker deploy is manual** — `ph transport set http cloudflare` prints wrangler instructions but does not run them. Deployment must be done separately.
6. **Config merge preserves stale git URL** — switching from HTTP→git clears HTTP fields, but switching git→HTTP does NOT clear `remote.git_remote_url` (only HTTP fields are written). The stale git URL lingers in the config file but is ignored by `create_transport_from_config()`.
7. **Ledger-aware verification not yet implemented** — the extended verification layer (Scenarios A/B above) is designed but not wired into `transport_cmd.py`. Currently `ph transport set` only writes config; it does not probe the remote for an existing ledger or compare genesis seeds.
8. **Different-genesis seed detection relies on deobfuscation** — if the remote genesis was created with a different master key, deobfuscation fails and we can't read the seed to show the remote identity. We can only tell the user "different identity" but not whose identity it is. To inspect it, they'd need the remote's recovery seed (via `ph onboarding http`).
