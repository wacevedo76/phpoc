# CLI Onboarding — Workflow Map

> Three paths: remote via git (`ph onboarding remote`), remote via HTTP/Cloudflare R2
> (`ph onboarding http`), and local file import (`ph onboarding file <path>`).
> All three derive the master key from a recovery seed, then pull/validate/verify data.

## Module Map

| File | Concern |
|---|---|
| `main.py` | Dispatches `ph onboarding` → remote, `ph onboarding http` → HTTP, `ph onboarding file <path>` → local |
| `cli/onboarding.py` | Remote orchestration: `run_onboarding()` (git), `run_onboarding_http()` (Cloudflare R2) — transport setup, pull ledger/staging/index, extract identity, set passphrase, verify |
| `cli/onboarding_file.py` | File orchestration: `run_onboarding_file()` — format detection (v1/v2/chain), seal verification, passphrase prompt, verify |
| `core/sync/transport.py` | `create_transport_from_config()` — factory for `HttpStagingTransport` or `GitStagingTransport` |
| `core/sync/git_transport.py` | `GitStagingTransport` — git-based pull/push for remote onboarding |
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync` — pull/verify ledger blocks + index from remote |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — pull staging blob, deobfuscate |
| `security/recovery.py` | `RecoveryManager.seed_to_key()` — base64 seed → 32-byte master key; `encrypt_seed()` |
| `security/crypto.py` | `CryptoManager` — seal, decrypt, encrypt identity secret |
| `security/auth.py` | `RecoveryAuthenticator` (seed prompt), `PassphraseAuthenticator` (key caching) |
| `core/ledger.py` | `LedgerDomain` — re-export shim; verify, `_get_identity_secret()` |
| `storage/file_store.py` | `LedgerStore` — reads/writes `ledger.json`, `staging.json`, `index.json` |
| `security/device_identity.py` | `RandomUUIDDeviceIdentityProvider` — device label |

## Data Files (written to `data_dir/`)

| File | Writer | Content |
|---|---|---|
| `ledger.json` | `_pull_ledger_blocks()` / `_write_data_files()` | Array of sealed+signed blocks |
| `staging.json` | `_write_staging_json()` / `_write_data_files()` | Array of staging DTOs |
| `index.json` | `_pull_index()` / `_write_data_files()` | `{date: {title: ms}}` blind index |
| `identity.json` | `_extract_identity_from_genesis()` / `_extract_identity()` | `{identity_secret_enc}` from genesis fallback |
| `device_cookie.meta` | `DeviceCookie.create()` (later, during sync) | Device specifier + creation time |

## Remote Onboarding Flow — Git (`ph onboarding` / `ph onboarding remote`)

```
1. Check: ledger.json exists? → prompt overwrite

2. [TRANSPORT] create_transport_from_config(config)
   ├─ config has base_url + transport=http → HttpStagingTransport (from existing config)
   ├─ config has git_remote_url → GitStagingTransport (from existing config)
   └─ neither → prompt interactively for git URL

3. [AUTH] RecoveryAuthenticator.authenticate()
   → prompts for recovery seed → seed_to_key() → 32-byte master key

4. [PULL LEDGER] RemoteLedgerSync.pull_blocks(None)
   → list remote block indices → deobfuscate each → verify chain
   → write ledger.json

5. [IDENTITY] _extract_identity_from_genesis(blocks, mk, identity_path)
   → decrypt identity_secret_enc_fallback from genesis
   → re-encrypt with same key → write identity.json

6. [PULL STAGING] RemoteStagingSync.pull(mk)
   → transport.pull('staging/blobs/current.json') → deobfuscate
   → write entries to staging.json

7. [PULL INDEX] RemoteLedgerSync.pull_index()
   → write index.json

8. [PASSPHRASE] _recover_ledger()
   → prompt new passphrase → PBKDF2(passphrase, "session-salt", 600000)
   → encrypt seed with PDK → update genesis recovery_seed_enc
   → re-seal genesis → re-sign → re-chain all blocks → write

9. [CACHE KEY] PassphraseAuthenticator._cache_key(mk)

10. [VERIFY] LedgerDomain.verify() → checks all seals/signatures/chain linkage

11. [SUMMARY] Print device label, block count, verify result
```

## HTTP/Cloudflare R2 Onboarding Flow (`ph onboarding http`)

```
1. Check: ledger.json exists? → prompt overwrite

2. [TRANSPORT] _prompt_http_transport()
   ├─ Show Worker setup instructions (wrangler deploy steps)
   ├─ Prompt for Worker URL (e.g. https://phpoc-staging.username.workers.dev)
   ├─ Check $PHPOC_CLOUDFLARE_API_KEY env var, or prompt for API key
   ├─ Create HttpStagingTransport
   ├─ Test connectivity (pull non-existent path → expect 404 or 403)
   └─ Return transport + config dict {remote.transport: http, http: {base_url, api_key}}

3. [AUTH] RecoveryAuthenticator.authenticate()
   → prompts for recovery seed → seed_to_key() → 32-byte master key

4-7. [PULL] Same as git flow — transport-agnostic helpers:
   → RemoteLedgerSync.pull_blocks() — lists ledger/blocks/, deobfuscates, verifies chain
   → _extract_identity_from_genesis() — writes identity.json
   → RemoteStagingSync.pull() — pulls staging/blobs/current.json via HTTP GET
   → RemoteLedgerSync.pull_index() — pulls ledger/index.json via HTTP GET

8. [SAVE CONFIG] config_manager.write({remote.transport: "http", http: {base_url, api_key}})

9. [PASSPHRASE] _recover_ledger()
   → prompt new passphrase → PBKDF2 → re-encrypt seed → re-seal → re-sign

10. [CACHE KEY] Cache master key in session

11. [VERIFY] LedgerDomain.verify()

12. [SUMMARY] Same summary output as git flow
```

## File Import Flow (`ph onboarding file <path>`)

```
1. Check: ledger.json exists? → prompt overwrite

2. [READ] json.load(file_path) → detect format:
   ├─ isinstance(list) → raw chain
   ├─ format_version == "1" → v1 export (staging only)
   └─ format_version == "2" → v2 export (ledger + staging)

3. [AUTH] _prompt_seed() → seed_to_key() → master key

4. [VALIDATE] format-specific:
   ├─ chain → _import_raw_chain(): verify block seals, prev_hash linkage, entry hashes
   ├─ v1 → _import_v1(): verify top-level seal; best-effort entry hash check (warn, don't fail)
   └─ v2 → _import_v2(): verify top-level seal over {ledger, staging}; validate chain

5. [WRITE] _write_data_files() → staging.json, ledger.json (v2/chain), empty index.json

6. [IDENTITY] (v2/chain only) _extract_identity() from genesis fallback

7. [PASSPHRASE] (v2/chain only) _set_passphrase()
   → prompt new passphrase → PBKDF2 → re-encrypt seed → re-seal + re-sign chain

8. [CACHE KEY] PassphraseAuthenticator._cache_key(mk)

9. [VERIFY] (v2/chain only) LedgerDomain.verify()

10. [SUMMARY]
```

## Format Detection

| Input | Format | Has ledger? | Has staging? | Auth needed? |
|---|---|---|---|---|
| `[block, ...]` (list) | raw chain | Yes | No | Seed only |
| `{format_version: "1", entries, seal}` | v1 export | No | Yes | Seed only |
| `{format_version: "2", ledger, staging, seal}` | v2 export | Yes | Yes | Seed only |

## HTTP Transport Prompt Detail (`_prompt_http_transport`)

| Step | Prompt | Validation |
|---|---|---|
| Worker URL | User enters `https://<worker>.<account>.workers.dev` | Parses valid URL; strips trailing slash |
| API key | Checks `$PHPOC_CLOUDFLARE_API_KEY` env var first; if absent, prompts user | Stored in config or sourced from env at runtime |
| Connectivity test | `transport.pull("onboarding-health-check")` | Expects None (404) on empty bucket; error 403/401 = auth failure; Timeout = unreachable |

### Error recovery
- **Timeout**: prompt retry or cancel
- **Auth failure (403/401)**: show API key troubleshooting; prompt retry
- **Other failures**: prompt retry with different URL

## Key Invariants

1. **Master key = base64.decode(seed)** — both remote and file paths use `RecoveryManager.seed_to_key()`. No passphrase bridging needed.
2. **Seal = HMAC-SHA256 over `json.dumps(data, sort_keys=True)`** — matches web's `jsonSort` (default Python spacing = spaces after `,` and `:`).
3. **Entry hash formats differ**: staging DTOs use SHA-256 over core fields only; ledger entries use SHA-256 over `json.dumps(data, indent=2)`.
4. **Passphrase only encrypts seed at rest** — setting a new passphrase re-encrypts the seed with PBKDF2 and re-seals the genesis block. The master key itself never changes.
5. **v1 files have no ledger blocks** — import writes staging entries only; user must `ph init` afterward.
6. **File import is not a transport** — it bypasses `AbstractStagingTransport`. The transport interface is for remote storage only.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | Seed valid? | `base64.b64decode(seed)` succeeds; 32 bytes |
| 2 | Seal verified? | `CryptoManager.seal(jsonSort(data)) == stored_seal` |
| 3 | Block chain intact? | Each block's `prev_hash` matches previous block's hash field |
| 4 | Entry hashes match? | Staging: core-field hash or all-field hash. Ledger: 2-space indent hash |
| 5 | Transport reachable? | (Git) `git ls-remote` exits 0; (HTTP) `HttpStagingTransport.pull()` succeeds or returns None |
| 6 | Identity extractable? | `identity_secret_enc_fallback` decrypts to 32-byte hex |
| 7 | Passphrase re-seal complete? | `LedgerDomain.verify()` returns True |
