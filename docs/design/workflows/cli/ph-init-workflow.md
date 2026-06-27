# CLI Init — Workflow Map (`ph init`)

> Creates a brand-new ledger from scratch. Generates a sovereign recovery seed,
> derives a master key, creates a genesis block with sealed identity, and writes
> the initial data files. No network calls — entirely local operation.

## Module Map

| File | Concern |
|---|---|
| `main.py` | Dispatches `ph init` — prompts for username/email/passphrase, derives PDK, calls `LedgerFactory.initialize()`, displays seed |
| `core/factory.py` | `LedgerFactory.initialize()` — seed generation, key derivation, genesis construction, seal+sign, file writes |
| `security/recovery.py` | `RecoveryManager.generate_recovery_seed()` — 32 bytes urandom → base64; `seed_to_key()` — base64 → 32-byte mk; `encrypt_seed()` — seed encrypted under PDK |
| `security/crypto.py` | `CryptoManager` — `seal()` (HMAC-SHA256), `sign()` (HMAC-SHA256 identity proxy), `encrypt()` (AES-CTR + HMAC) |
| `security/auth.py` | `_cache_key()` — writes master key to `/dev/shm/phpoc_session` (chmod 600) |

## Data Files Written

| File | Writer | Content |
|---|---|---|
| `ledger.json` | `LedgerFactory.initialize()` | Array with one element: the genesis block |
| `identity.json` | `LedgerFactory.initialize()` | `{identity_secret_enc: "<AES-CTR-encrypted identity>"}` |
| `config.json` | `main.py` via `CONFIG.write(CONFIG.read())` | Merged default config (written if file doesn't exist) |
| `staging.json` | Not written by init | Created later on first `ph add start` or `ph capture` |
| `index.json` | Not written by init | Created later on first `ph sync` or `ph rep` |

## Genesis Block Structure

```json
{
  "type": "genesis",
  "day_index": 0,
  "date": "2026-06-27",
  "identity": {
    "username": "alice",
    "email": "alice@example.com",
    "recovery_seed_enc": "<AES-CTR(seed, PDK)>",
    "identity_pub_key": "<SHA-256(identity_secret)>",
    "identity_secret_enc_fallback": "<AES-CTR(identity_secret, master_key)>"
  },
  "prev_hash": "0000...0000",
  "entries": [],
  "day_hash": "<HMAC-SHA256(jsonSort(genesis), master_key)>",
  "signature": "<HMAC-SHA256(day_hash, identity_secret)>"
}
```

## Flow

```
1. [PROMPT] Username, email

2. [PASSPHRASE] Prompt new passphrase (with confirmation loop)
   → PBKDF2-HMAC-SHA256(passphrase, "session-salt", 600000 iterations, 32 bytes)
   → PDK (Passphrase-Derived Key) — used ONLY to encrypt the seed at rest

3. [CONFIG] CONFIG.write(CONFIG.read())
   → Writes default config to ~/.config/phpoc/config.json if not present
   → No-op if config already exists

4. [LEDGER] LedgerFactory.initialize(ledger_path, pdk, username, email)
   ├─ Check: ledger_path already exists? → return None (abort)
   ├─ Generate recovery seed: secrets.token_bytes(32) → base64 → 44-char string
   ├─ Derive master key:   base64.decode(seed) → 32-byte mk
   ├─ Create CryptoManager(mk)
   ├─ Generate identity:    os.urandom(32) → identity_secret
   │   └─ identity_pub_key = SHA-256(identity_secret)
   ├─ Encrypt seed:         CryptoManager(pdk).encrypt(seed) → encrypted_seed
   ├─ Encrypt identity:     crypto.encrypt(identity_secret.hex()) → encrypted_identity
   ├─ Build genesis:        {type, day_index, date, identity, prev_hash: 0*64, entries: []}
   ├─ Seal genesis:         crypto.seal(json.dumps(genesis, sort_keys=True)) → day_hash
   ├─ Sign genesis:         crypto.sign(day_hash, identity_secret) → signature
   ├─ Create data dir:      ledger_path.parent.mkdir(parents=True, exist_ok=True)
   ├─ Write identity.json:  {identity_secret_enc: encrypted_identity}
   ├─ Write ledger.json:    [genesis]
   └─ Return seed string

5. [DISPLAY] Print seed with prominent security warning
   → recovery_seed is displayed ONCE — never stored in plaintext after this

6. [CACHE] auth._cache_key(mk)
   → Writes mk to /dev/shm/phpoc_session (chmod 600, volatile RAM)
   → Subsequent commands in this session won't need the passphrase
```

## Decision Tree

```
ph init
  │
  ├─ ledger.json exists? ──yes──→ "Ledger already exists." → exit
  │
  └─ ledger.json does NOT exist
       │
       ├─ Prompt: Username + Email
       │
       ├─ Prompt: Passphrase (confirm)
       │    └─ PBKDF2(passphrase, "session-salt", 600K) → PDK (32 bytes)
       │
       ├─ Write default config (~/.config/phpoc/config.json)
       │
       ├─ Generate recovery seed (32 random bytes → base64)
       │
       ├─ Derive master key (base64.decode(seed) → 32 bytes)
       │
       ├─ Generate identity secret (32 random bytes)
       │    └─ identity_pub_key = SHA-256(identity_secret)
       │
       ├─ Encrypt seed with PDK → recovery_seed_enc
       │
       ├─ Encrypt identity_secret with mk → identity_secret_enc_fallback
       │
       ├─ Build genesis block
       │    ├─ seal = HMAC-SHA256(jsonSort(genesis_without_hash_sig), mk)
       │    └─ signature = HMAC-SHA256(seal, identity_secret)
       │
       ├─ Create data directory (~/.local/share/phpoc/)
       │
       ├─ Write identity.json + ledger.json
       │
       ├─ Print recovery seed (ONCE — never stored in plaintext)
       │
       └─ Cache master key to /dev/shm/phpoc_session
            → Ready for immediate use (no re-auth needed)
```

## Key Invariants

1. **Master key = base64.decode(recovery_seed)** — seed IS the master key. The base64 encoding is for display only.
2. **Passphrase only encrypts seed at rest** — the PDK is used for exactly one thing: `CryptoManager(pdk).encrypt(seed)`. The master key never touches the passphrase.
3. **Seal = HMAC-SHA256 over `json.dumps(data, sort_keys=True)`** — deterministic; same JSON always yields the same seal.
4. **Identity is HMAC-based proxy** — `sign(blob, identity_secret)` = `HMAC-SHA256(identity_secret, blob)`. Not real Ed25519.
5. **Seed is displayed once** — after `ph init`, the seed exists only encrypted inside the genesis block. No plaintext copy.
6. **Genesis prev_hash = 64 zeros** — genesis has no predecessor; the zero hash anchors the chain.
7. **Identity survives if identity.json is deleted** — `identity_secret_enc_fallback` is embedded in genesis and can be recovered from the ledger alone.
8. **Session cache is volatile** — `/dev/shm` is tmpfs (RAM). Key vanishes on reboot. chmod 600 restricts to current user.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | Seed valid? | `base64.b64decode(seed)` → 32 bytes |
| 2 | Master key correct? | `RecoveryManager.seed_to_key(seed) == mk` |
| 3 | Genesis seal valid? | `CryptoManager(mk).seal(jsonSort(genesis_without_hash_sig)) == genesis["day_hash"]` |
| 4 | Genesis signature valid? | `CryptoManager(mk).sign(day_hash, identity_secret) == genesis["signature"]` |
| 5 | Seed decryptable? | `RecoveryManager.decrypt_seed(enc_seed, pdk) == seed` |
| 6 | Identity recoverable? | `crypto.decrypt(identity_secret_enc_fallback)` → 64-char hex → 32 bytes |
| 7 | Identity pub key matches? | `SHA-256(identity_secret) == identity_pub_key` |
| 8 | Session key cached? | `/dev/shm/phpoc_session` exists, is 32 bytes, chmod 600 |
| 9 | No plaintext seed? | `rg <seed>` across `~/.local/share/phpoc/` returns nothing |
| 10 | Data dir created? | `~/.local/share/phpoc/` exists with ledger.json + identity.json |

## Known Gaps

- **No identity.json update on recover** — `ph recover` re-seals the ledger but does not update `identity.json` with the new encrypted identity. The genesis fallback is always the source of truth, but identity.json can become stale after recovery.
- **No config auto-generation during init** — `CONFIG.write(CONFIG.read())` only writes if config doesn't exist yet; if the user already has a config from a previous init (different data dir), the template is not regenerated.
- **No device_id on init** — the device identity provider (`RandomUUIDDeviceIdentityProvider`) is only created if a remote transport is configured. Local-only setups won't get a device_id until they configure a remote transport.
