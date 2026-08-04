# E2E Cross-Client Fix Plan

> **Created:** 2026-07-01
> **Bug report:** `E2E_CROSS_CLIENT_BUGS.md` (2026-06-30)
> **Test used:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`, isolated dir `/tmp/phpoc-e2e`
> **Goal:** Unblock full roundtrip: CLI → R2 → Web → R2 → CLI

## Legend
- ✅ = Implemented
- 🔜 = Planned (solution agreed, not yet implemented)
- 🔮 = Under discussion

---

## Bug 1 — Genesis mismatch detection is indiscriminate

**Status:** ✅ Implemented  
**Severity:** High — blocks all ledger block sync on transient errors  
**Files:** `phpoc-web/src/sync/sync.js`, `phpoc-web/src/sync/genesis_gate.js`

### Solution: Typed error hierarchy from GenesisGate.check()

Replace the `{ compatible: false, reason: '...' }` return pattern with typed errors:

1. **New error classes** in `genesis_gate.js`:
   - `GenesisMismatchError` — actual hash divergence (permanent)
   - `NetworkGenesisError` — DNS/timeout/transport failure (transient, carries `cause`)
   - `AuthGenesisError` — HTTP 403 (transient)
   - `InvalidChainError` — remote seal/hash verification failed (transient)

2. **GenesisGate._doCheck()** throws these instead of returning `{ compatible: false, reason }`.

3. **`_genesisGatePhase()`** in `sync.js` catches them:
   ```javascript
   try {
     const result = await GenesisGate.check(...);
     // ... persist merged chain ...
   } catch (err) {
     if (err instanceof GenesisMismatchError) return SyncResult.GENESIS_MISMATCH;
     if (err instanceof NetworkGenesisError || err instanceof AuthGenesisError || err instanceof InvalidChainError) return null;
     throw; // unexpected
   }
   ```

4. `no_remote_ledger` and `no_local_ledger` remain as non-error returns (they are normal states, not errors).

### Rationale
- Exhaustiveness: TypeScript/ESLint can verify all branches handled
- Carries context: `NetworkGenesisError` preserves the original `cause` for logging
- Self-documenting: catch blocks read as a decision table
- No magic strings: new failure modes require new error classes

---

## Bug 2 — Month summary blocks silently dropped during push

**Status:** ✅ Implemented  
**Severity:** High — causes incomplete chains on remote  
**Files:** `phpoc-web/src/sync/sync.js` (`pushLedgerBlocks`)

### Architecture constraint
- Day blocks have `day_index` — a block-level position, not tied to individual activities
- Activities inside blocks have no indices (future: alphabetical ordering to obscure chronological order)
- Activity indices belong to staging only — must never leak to the ledger
- File naming (`000000.json`) is a transport-layer concern, not ledger data

### Solution: Position counter for file naming only

Replace the `block.day_index ?? block.index` derivation in `pushLedgerBlocks()` with a position counter used solely for the R2 object key:

```javascript
let position = 0;
for (const block of sorted) {
    // Day blocks use day_index; summary blocks and other types fall back to position
    const fileIdx = block.day_index ?? position;
    position++;

    // Push as `${fileIdx}.json` — index is never stored on the block itself
    const path = `${REMOTE_LEDGER_BLOCKS_PREFIX}${String(fileIdx).padStart(6, '0')}.json`;
    // ...
}
```

- No `block_index` field added to blocks — nothing new enters ledger data
- Day blocks keep `day_index` filenames (backward compatible)
- Summary blocks get position-based filenames (no gaps in remote chain)
- Security concern is moot — index exists only in R2 object key

---

## Bug 3 — Web↔CLI staging format mismatch

**Status:** ✅ Implemented  
**Severity:** High — blocks all staging sync between web and CLI  
**Files:** `domain/staging/service.py`, `phpoc-web/src/sync/remote_sync.js`, `phpoc-web/src/sync/sync.js`, `phpoc-web/src/sync/local_cache.js`, `phpoc-web/src/sync/device_uuid.js`, `security/device_identity.py`

### Sub-issue 3a: Same device UUID causes mass overwrite

**Root cause (historical):** The web app originally used a WASM-derived UUID (`HMAC(mk, "device:id")`) which produced the same value on every client sharing the same passphrase. The web has since been migrated to `crypto.randomUUID()` (see `device_uuid.js` migration comment), but the "same device" fast path in `_reconcile_and_claim()` remains architecturally dangerous.

**Architectural problem:** Even with random UUIDs, two different clients (CLI and web) on the same physical machine could theoretically collide, and the fast path assumes same-UUID = local-is-authoritative, which silently overwrites remote staging.

**Solution — Two-part fix:**

#### Part A: Client suffix on device_id

Add a deterministic client-type suffix so CLI and web always have distinct identities:

- CLI: `{uuid4}-cli`
- Web: `{uuid4}-web`

```python
# security/device_identity.py — new constant
CLIENT_TYPE = "cli"

class RandomUUIDDeviceIdentityProvider:
    def get_device_identity(self, master_key):
        ...
        if "device_id" not in config:
            config["device_id"] = f"{uuid.uuid4()}-{CLIENT_TYPE}"
```

```javascript
// phpoc-web/src/sync/device_uuid.js — new constant
const CLIENT_TYPE = 'web';

export async function getOrCreateDeviceUuid(storage) {
    ...
    const newUuid = `${crypto.randomUUID()}-${CLIENT_TYPE}`;
```

**Migration:** Existing bare UUIDs (no suffix) get the suffix appended on next read. Remote cookies with old bare UUIDs are treated as a different device → safe pull+merge path.

**Auth workflow preserved:** The device proof is `HMAC(mk, "phpoc:device:" + device_id)` — the suffix is just part of the string. Both sides independently compute and verify. No coordination needed.

**Benefits beyond the fix:**
- Cookie ownership guaranteed different: `uuid-cli ≠ uuid-web` → always pull+merge
- Staging entries tagged with client identity (debuggable)
- Re-auth messages can identify which client: "phpoc-web on x13 needs re-auth"
- Independent TTLs per client (web re-auth doesn't expire CLI)

#### Part B: Remove the same-device fast path

Even with suffixes guaranteeing uniqueness, the fast path is still incorrect in principle — same-device doesn't mean local-is-authoritative. Replace with unconditional pull+merge:

```python
# In _reconcile_and_claim() — remove the same-device fast path entirely.
# Always pull remote blob, merge with local, push merged result.
# The merge of same-device→same-device is a no-op (same entries),
# so the only cost is one extra HTTP request.
```

Same change in `phpoc-web/src/sync/sync.js` `_reconcileAndClaim()`.

### Sub-issue 3b: Entry format incompatible
**Status:** 🔜 Planned

**Root cause:** The web writes entries in a flat format (`start_epoch`, no `_enc` suffix, no `data` wrapper) that does not conform to PHPSPEC.md §3.1.1 and §8.1. The CLI and the spec mandate the nested `{hash, data: {startTime_enc: "plain:...", ...}}` format where the `_enc` suffix is the determiner for which fields are encrypted.

**Solution: Canonicalize the web on the spec format.** The CLI is already spec-compliant. The web's reader (`rawEntryToDTO`, `rawCommittedEntryToDTO`) already parses the spec format correctly — only the writer needs to change.

Web changes required:

| Change | Area |
|--------|------|
| `start_epoch` → `startTime_enc: "plain:..."` | `local_cache.js` append/update/writeEntries |
| `end_epoch` → `endTime_enc: "plain:..."` | `local_cache.js` |
| `pauses: []` → `pauses_enc: "plain:[]"` | `local_cache.js` |
| `metadata: {}` → `metadata_enc: "plain:{}"` | `local_cache.js` |
| `device_uuid` → `device_uuid_enc: "plain:..."` | `local_cache.js` |
| Flat entry → `{hash, data: {...}}` wrapper | `local_cache.js` append/writeEntries |
| Blob wrapper → `{device_id_enc, staging, version}` per §8.5 | `remote_sync.js` pushBlob |
| Update tests (mocks, seeders, entry DTO tests) | Multiple test files |

**Rationale:** The `_enc` suffix convention (§3.1.1) is the spec-defined mechanism for determining whether a field is encrypted. The `plain:` prefix (§8.2) is the staging placeholder for fields that will be encrypted at commit time. Both are required for cross-client staging compatibility and future all-field encryption.

---

## Bug 4 — Genesis seal mismatch between creation and verification

**Status:** ✅ Implemented  
**Severity:** Medium — breaks `ph onboarding file` and `ph login`  
**Files:** `core/factory.py`

### What happens

Two code paths disagree on whether `signature` should be included in the JSON text sealed to produce `day_hash`:

| Path | File | Includes `signature`? |
|------|------|-----------------------|
| Creation (CLI) | `core/factory.py` line ~52 | ✅ Yes — `"signature": ""` is in the JSON before `crypto.seal()` |
| Creation (Web) | `phpoc-web/src/ledger/chain.js` line ~264 | ❌ No — comment says "without seal / signature" |
| Verification (file import) | `phpoc_cli/onboarding_file.py` line ~260 | ❌ No — `if k not in (hash_field, "signature")` |
| Verification (session cache) | `security/auth.py` line ~147 | ❌ No — same exclusion pattern |

**The web never had this bug** — its `buildGenesisBlock` builds `genesisContent` without `signature`, seals it, then adds `signature` after. The CLI includes `"signature": ""` in the dict before sealing, which produces a different JSON string and therefore a different SHA-256 hash.

### Solution

Align CLI creation with web creation and both verification paths — strip `signature` before sealing:

```python
# factory.py — strip signature before sealing (matches chain.js buildGenesisBlock)
seal_data = {k: v for k, v in genesis.items() if k != "signature"}
genesis_json = json.dumps(seal_data, sort_keys=True)
genesis["day_hash"] = crypto.seal(genesis_json)
genesis["signature"] = crypto.sign(genesis["day_hash"], identity_secret)
```

### Impact on pre-existing 0.3.0 ledgers

**None — nothing currently working breaks.**

| Ledger type | Currently works with verification? | After fix? |
|-------------|-----------------------------------|-------------|
| New CLI ledger (post-fix) | N/A | ✅ Works — matches web behavior |
| Old CLI ledger (0.3.0, buggy seal) | ❌ Already broken — verification always fails | ❌ Still broken — same state as before |
| Web-created ledger | ✅ Works — web never had this bug | ✅ Works — no change |

Old CLI-created ledgers have always had wrong `day_hash` values. But the seal is only verified during `onboarding file` and `login` — normal operations (`capture`, `commit`, `list`) don't verify chain integrity, so a wrong genesis seal goes unnoticed until re-import or re-auth. The fix doesn't make anything worse; it prevents new ledgers from being created with the same broken seal.
