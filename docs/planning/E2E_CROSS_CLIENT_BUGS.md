# E2E Cross-Client Test — Bugs Found

> **Date:** 2026-06-30
> **Test attempted:** Full roundtrip — CLI → R2 → Web → R2 → CLI
> **Status:** Blocked by 4 bugs + 1 plumbing issue
> **Credentials used:** passphrase `NewPass456!`, recovery seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`, Worker API key `ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO`

## Test Flow Attempted

1. ✅ Generate 7-day mock ledger (26 entries)
2. ✅ CLI onboard from file (`ph onboarding file`)
3. ✅ Configure HTTP transport to testing Worker
4. ✅ Sync CLI → R2 (9 blocks + staging + cookie)
5. ✅ Web onboard from R2 (production preview, port 4173)
6. ✅ Create & stop activity in web ("E2E Active Task")
7. ❌ CLI confirm activity is viewable ← BLOCKED
8. ❌ Stop activity in web → CLI confirm ← NOT REACHED

---

## Bug 1 — Genesis mismatch detection is indiscriminate

**Severity:** Blocks all ledger block sync between web and remote
**File:** `phpoc-web/src/sync/sync.js` lines 438–468, `phpoc-web/src/sync/genesis_gate.js`

### What happens

`_genesisGatePhase()` treats EVERY `compatible === false` result from `GenesisGate.check()` as `GENESIS_MISMATCH`, regardless of the actual reason:

```javascript
// sync.js line 467
if (result.compatible === false) {
    return SyncResult.GENESIS_MISMATCH;
}
```

But `GenesisGate.check()` returns `compatible: false` for six different reasons:
- `'genesis_mismatch'` — actual hash difference
- `'network_error'` — DNS failure, timeout, deobfuscation failure
- `'auth_failure'` — HTTP 403
- `'no_remote_ledger'` — empty bucket
- `'invalid_chain'` — seal/hash verification failure
- `'invalid_genesis'` — first remote block isn't type 'genesis'

### Concrete impact

```
1. Sync Now triggers checkAndSync()
2. _genesisGatePhase() → GenesisGate.check()
3. _pullRemoteChain() → crypto.deobfuscateBlob() fails on block 000000.json
4. GenesisGate returns { compatible: false, reason: 'network_error' }
5. _genesisGatePhase treats this as GENESIS_MISMATCH
6. checkAndSync short-circuits → no staging sync, no block push, no block pull
7. User sees "Genesis mismatch" even though genesis hashes DO match (f1c13074...)
8. Only option presented: nuclear "Clear Remote & Overwrite"
```

### Fix

`_genesisGatePhase()` should check `result.reason`:
- `reason === 'genesis_mismatch'` → return `GENESIS_MISMATCH`
- `reason === 'network_error'` → return `null` (fall through to offline handling)
- `reason === 'auth_failure'` → return `null` (fall through to auth handling)

---

## Bug 2 — Month summary blocks silently dropped during push

**Severity:** Causes incomplete ledger chains on remote
**File:** `phpoc-web/src/sync/sync.js` lines 824–875 (`pushLedgerBlocks`)

### What happens

Month summary blocks have neither `day_index` nor `index`:

```javascript
// sync.js line ~858
const idx = block.day_index ?? block.index;
if (idx == null) continue;  // ← month_summary blocks silently skipped
```

### Concrete impact

```
1. Web commits entry → local chain grows to 11 blocks:
   [0:genesis, 1:day, 2:month_summary, 3:day, 4:day, ..., 9:month_summary, 10:day]
2. pushLedgerBlocks iterates:
   Block 0: idx=0 → pushed as 000000.json ✓
   Block 1: idx=1 → pushed as 000001.json ✓
   Block 2: idx=null → SKIPPED (month_summary)
   Block 3: idx=1 → SKIPPED (already pushed) ✓ (same-index dedup)
   Block 9: idx=null → SKIPPED (month_summary)
   Block 10: idx=7 → pushed as 000007.json → OVERWRITES existing block 8
3. Remote has 9 files, missing both month_summary blocks
4. Block at index 7 is corrupted (overwritten by later day block)
```

### Fix

Month summary blocks need an index. Options:
- Assign computed index (e.g., genesis replacement + month offset)
- Use `block_index` field set during ledger building
- Use index-less push format for month_summary blocks

---

## Bug 3 — Web↔CLI staging format mismatch

**Severity:** Blocks all staging sync between web and CLI
**Files:**
- `domain/staging/service.py` lines 559–620 (`_raw_entry_to_dto`)
- `phpoc-web/src/sync/remote_sync.js` lines 106–124 (`pushBlob`)
- `phpoc-web/src/sync/sync.js` (staging entry storage format)

### Sub-issue A: Same device UUID causes mass overwrite

Both CLI and web derive the same device UUID (`d4959313-3f33-47c7-99f2-2e6d8c5fd1f7`) from the shared identity. `_reconcile_and_claim()` sees same device → pushes local blob without pulling remote:

```python
# service.py lines 690–695
if remote_device_uuid and remote_device_uuid == local_device_uuid:
    self.push_blob_only(master_key=master_key)  # ← overwrites remote with local
```

```
1. Web pushes staging blob {entries: [{title: "E2E Active Task"}]}
2. CLI runs ph login → _reconcile_and_claim()
3. Same device UUID detected → CLI pushes LOCAL staging (empty)
4. R2 staging overwritten: {entries: []}
5. Web client's activity data lost from remote
```

### Sub-issue B: Entry format incompatible

The CLI's `_raw_entry_to_dto()` expects nested format with `_enc` fields:

```python
# CLI expected format:
{
    "hash": "...",
    "data": {
        "title": "Task",
        "startTime_enc": "plain:1782820000000",
        "endTime_enc": "plain:1782820120000",
        # ...
    }
}
```

The web client pushes flat format:

```javascript
// Web pushed format:
{
    "entry_id": "...",
    "title": "E2E Active Task",
    "duration": 120000,
    "is_active": false,
    "start_epoch": 1782820000000,
    "end_epoch": 1782820120000,
    "tags": ["e2e", "live"],
    "hash": "3749eac9bb...",
    // ...
}
```

`_raw_entry_to_dto` tries `data = raw_entry.get("data", {})` → gets `{}`. Then `startTime_enc` is `""` (empty, not `"plain:..."`) → returns `None`. All web entries silently dropped during merge.

### Fix

Either: CLI's `_raw_entry_to_dto` recognizes flat format, or web wraps entries in `{hash, data}` with `_enc` fields, or both migrate to a shared canonical staging format.

---

## Bug 4 — Genesis seal mismatch between creation and verification

**Severity:** Breaks file onboarding and session cache verification
**Files:**
- `core/factory.py` lines 52–58 (creation)
- `cli/onboarding_file.py` line 260 (verification)
- `security/auth.py` line 147 (`_verify_cached_key`)

### What happens

Creation seals the genesis with `"signature": ""` included in the JSON:

```python
# factory.py
genesis = {..., "signature": ""}                           # includes signature: ""
genesis_json = json.dumps(genesis, sort_keys=True)        # signature: "" in JSON
genesis["day_hash"] = crypto.seal(genesis_json)           # seals JSON with signature: ""
genesis["signature"] = crypto.sign(genesis["day_hash"], ...)  # signs the hash
```

Verification strips `signature` before re-computing the hash:

```python
# onboarding_file.py line 260 and auth.py line 147 — BOTH:
check_data = {k: v for k, v in sorted(block.items())
              if k not in (hash_field, "signature")}  # ← signature EXCLUDED
```

### Concrete impact

```
Creation:
  genesis_json = '{"date":"2026-06-30","signature":"",...}'
  day_hash = seal(genesis_json) = sha256(JSON_with_empty_signature)

Verification:
  check_json = '{"date":"2026-06-30",...}'   (NO signature key)
  computed_hash = seal(check_json) = sha256(JSON_without_signature)
  sha256(JSON_with_signature) ≠ sha256(JSON_without_signature)
  → VERIFICATION FAILED
```

**This breaks:** `ph onboarding file` and `ph login` (session cache check). During testing, I manually re-sealed the genesis block to bypass this.

### Fix

Align both paths. Option A: creation strips `signature` before sealing (matches verification). Option B: verification includes `signature` as-is (matches creation).

---

## Bonus Issue — Sync stdin plumbing

**File:** `main.py` lines 765–806

When `ph sync` detects `REAUTH_NEEDED`, it calls `auth.login()` which reads from stdin (even with `PHPOC_PASSPHRASE` set, the `clear_session()` path may still consume stdin). The piped `"S\n"` for the merge prompt is consumed by `login()`, leaving the merge prompt starved.

### Workaround

Run `ph login` first (discrete command), then `ph sync`. The login resolves the cookie/auth issue without consuming the merge stdin.
