# Approach B: Don't Mutate — Fix verify() After Cloud Restore

**Created:** 2026-08-08
**Status:** 🔜 Planning
**Branch:** `Flutter-features_and_ux`

## Problem Summary

`LedgerChain.verify()` returns false after Restore from Cloud. Three root causes,
each independently fatal:

| # | Root Cause | Fail Point |
|---|-----------|-----------|
| RC1 | Genesis seal computed with `json.encode()` (unsorted), `_verifyBlockSeal` uses `jsonSort` (sorted) | Block 0 |
| RC2 | `_buildAndPersistGenesis` SQL-updates block 1's `prev_hash` without re-sealing | Block 1 |
| RC3 | `_validateImportedChain` auto-heals entry hashes + prev_hash without re-sealing | Any auto-healed block |

## Design Principle

**The chain is immutable.** Blocks sealed by one client must verify on every
other client. Approach B achieves this by never modifying imported blocks and
by fixing the verification code to handle all serialization formats.

## Changes by File

### 1. `phpoc-flutter/lib/data/ledger/chain.dart`

**Fix: `_verifyBlockSeal` uses `verifySeal` with 3-way fallback**

Currently `_verifyBlockSeal` does a direct `computeSeal` comparison (only
`jsonSort` format). This fails for Web-created blocks (no-space format) and
Flutter-created genesis blocks (`json.encode` unsorted). Change to use
`verifySeal()` which tries all 3 formats:

```dart
// Before:
final expectedHash = _sealBlock(block, hashKey);
return storedHash == expectedHash;

// After:
final sealData = <String, dynamic>{};
for (final entry in block.entries) {
  if (entry.key != hashKey && entry.key != 'identity_seal') {
    sealData[entry.key] = entry.value;
  }
}
return verifySeal(sealData, storedHash);
```

This fixes RC1 for all genesis blocks (local + R2) and fixes seal
verification for Web-created blocks.

### 2. `phpoc-flutter/lib/data/storage/database.dart`

**Add: seed vault helpers on `_phpoc_meta` table**

The `_phpoc_meta` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) already
exists. Add two helpers:

```dart
// Store PDK-encrypted seed
Future<void> setSeedVault(String encryptedSeed) async {
  await customStatement(
    'INSERT OR REPLACE INTO _phpoc_meta (key, value) VALUES (?, ?)',
    ['recovery_seed_enc', encryptedSeed],
  );
}

// Read PDK-encrypted seed, or null
Future<String?> getSeedVault() async {
  final rows = await customSelect(
    'SELECT value FROM _phpoc_meta WHERE key = ?',
    ['recovery_seed_enc'],
  );
  return rows.isNotEmpty ? rows.first['value'] as String : null;
}
```

### 3. `phpoc-flutter/lib/services/onboarding_service.dart`

**New: `_storeSeedInVault()` method**

Extract seed vault writing from `_buildAndPersistGenesis`:

```dart
Future<void> _storeSeedInVault(String passphrase, String seedB64) async {
  final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
  final encryptedSeed = crypto.encrypt(seedB64, pdk);
  await db.setSeedVault(encryptedSeed);
}
```

**Modify: `_postImportSetup` — two paths**

For cloud restore, the chain already has a genesis block from R2. Don't
replace it — only store the seed in the vault:

```dart
Future<void> _postImportSetup(String passphrase, String seedB64,
    {bool keepExistingGenesis = false}) async {
  final mk = crypto.deriveMasterKey(seedB64);
  crypto.setMasterKey(mk);

  if (keepExistingGenesis) {
    // Cloud restore: R2 genesis exists, just store seed + update prev_hash
    // but DON'T replace genesis or mutate any block
    await _storeSeedInVault(passphrase, seedB64);
  } else {
    // Local creation: build genesis block + store seed in vault
    await _buildAndPersistGenesis(passphrase, seedB64);
  }

  final uuid = crypto.generateUuid();
  await preferences.setDeviceUuid(uuid);
  await preferences.setHasExistingData(true);
}
```

**Modify: `_buildAndPersistGenesis` — keep for local flows, fix seal**

For local creation (`createNewLedger`, `importFromSeed`, `importFromFile`),
still create genesis, but:
1. Fix seal computation to use `jsonSort` instead of `json.encode` (RC1 fix
   for local chains)
2. Also store seed in vault (so AuthService can read from vault uniformly)

```dart
// Fix genesis seal — use jsonSort instead of json.encode
final genesisPayloadObj = {
  'type': 'genesis',
  'day_index': 0,
  'date': FormatUtils.epochToIsoDate(nowSeconds),
  'prev_hash': Block.genesisPrevHash,
  'entries': <dynamic>[],
};
final genesisPayload = jsonSort(genesisPayloadObj);  // ← sorted!
final blockId = crypto.seal(genesisPayload, mk);
```

**Modify: `restoreFromCloud` — pass `keepExistingGenesis: true`**

```dart
if (result.success) {
  await _postImportSetup(passphrase, seedB64, keepExistingGenesis: true);
}
```

**Remove: `_buildAndPersistGenesis` block 1 prev_hash SQL UPDATE**

The `UPDATE blocks SET prev_hash = ... WHERE block_type = 'day' AND block_index = 1`
is no longer needed because we're not replacing genesis. The R2 genesis's hash
remains the same, so block 1's prev_hash is already correct.

### 4. `phpoc-flutter/lib/services/auth_service.dart`

**New: `_readSeedFromVault()` helper**

Reads PDK-encrypted seed from `_phpoc_meta` vault. Falls back to genesis
`dataEnc` for backward compatibility with chains created before this fix:

```dart
Future<String?> _readEncryptedSeed() async {
  // Try vault first (post-fix chains)
  final fromVault = await db.getSeedVault();
  if (fromVault != null) return fromVault;

  // Fall back to genesis data_enc (pre-fix chains)
  final genesis = await _findGenesisBlock();
  if (genesis == null) return null;

  try {
    final decoded = utf8.decode(base64.decode(genesis.dataEnc));
    final genesisJson = json.decode(decoded) as Map<String, dynamic>;
    return genesisJson['seed'] as String?;
  } catch (_) {
    return null;
  }
}
```

**Modify: `_decryptSeedFromGenesis` → `_decryptSeed`**

Renamed and simplified — takes an encrypted seed string directly instead of
extracting it from genesis:

```dart
String _decryptSeed(String pdkHex, String encryptedSeed) {
  final seedB64 = crypto.decrypt(encryptedSeed, pdkHex);
  final seedBytes = base64.decode(seedB64);
  if (seedBytes.length != CryptoService.seedByteLength) {
    throw AuthException('Decrypted seed has wrong length');
  }
  return seedB64;
}
```

**Modify: `unlock()` — validation path**

```dart
// Before: reads from genesis
final genesis = await _findGenesisBlock();
if (genesis != null) {
  final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
  _decryptSeedFromGenesis(pdk, genesis);
}

// After: reads from vault (with genesis fallback)
final encryptedSeed = await _readEncryptedSeed();
if (encryptedSeed != null) {
  final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
  _decryptSeed(pdk, encryptedSeed);
}
```

**Modify: `reauthenticate()` — read from vault**

Same pattern: call `_readEncryptedSeed()` instead of `_findGenesisBlock()` +
`_decryptSeedFromGenesis()`.

**Modify: `exportSeed()` — read from vault**

Same pattern.

**Modify: `changePassphrase()` — write to vault**

```dart
// Before: re-encrypts in genesis data_enc, re-seals genesis
// After: re-encrypts in seed vault only

final encryptedSeed = await _readEncryptedSeed();
if (encryptedSeed == null) {
  throw AuthException('No recovery seed found');
}
final currentSeedB64 = _decryptSeed(oldPdk, encryptedSeed);
final newEncryptedSeed = crypto.encrypt(currentSeedB64, newPdk);
await db.setSeedVault(newEncryptedSeed);

// For backward compatibility: also update genesis if it uses old format
final genesis = await _findGenesisBlock();
if (genesis != null && _genesisHasSeedField(genesis)) {
  // Update genesis data_enc too (pre-fix chain with seed in genesis)
  ...
}
```

### 5. `phpoc-flutter/lib/services/ledger_pull_service.dart`

**Remove: auto-heal mutations from `_validateImportedChain`**

Stop mutating entry hashes and prev_hash in the in-memory blocks. Instead,
validate and fail the import with a clear error if validation fails:

```dart
// Before (auto-heals):
if (!verifyEntryHashTwoWay(data, hash)) {
  final recomputed = computeEntryHash(data);
  entry['hash'] = recomputed;  // ← mutation!
}

// After (validate-only):
if (!verifyEntryHashTwoWay(data, hash)) {
  throw FormatException(
    'Entry hash mismatch at block $i, entry $j. '
    'Hash: $hash does not match any serialization format for data: $data'
  );
}
```

Same for prev_hash linkage:
```dart
// Before (auto-heals):
blocks[i]['prev_hash'] = prevHash;  // ← mutation!

// After (validate-only):
if (prevHash.isNotEmpty && actualPrev != prevHash) {
  throw FormatException(
    'Prev_hash linkage break at block $i: expected $prevHash, got $actualPrev'
  );
}
```

### 6. `phpoc-flutter/lib/features/settings/settings_screen.dart`

No changes needed — `LedgerEngine.verify()` works correctly after above fixes.

### 7. Tests

**New/modified tests:**
- `test/data/ledger/chain_test.dart`: Add `_verifyBlockSeal` tests for all 3
  JSON formats (Python sort_keys, JS no-space, Flutter jsonSort)
- `test/services/auth_service_test.dart`: Update tests to use seed vault
  instead of genesis data_enc
- `test/services/onboarding_service_test.dart`: Add cloud restore path test
  verifying genesis is NOT replaced
- `test/services/ledger_pull_service_test.dart`: Add test verifying
  `_validateImportedChain` fails on bad data instead of auto-healing

## Verification Checklist

- [ ] `verify()` passes on locally-created chain (genesis only)
- [ ] `verify()` passes on locally-created chain with day blocks
- [ ] `verify()` passes after cloud restore (CLI-created blocks)
- [ ] `verify()` passes after cloud restore (Web-created blocks)
- [ ] `unlock()` works with seed vault (post-fix chains)
- [ ] `unlock()` works with genesis fallback (pre-fix chains)
- [ ] `reauthenticate()` works from vault
- [ ] `changePassphrase()` works — updates vault, old passphrase no longer works
- [ ] `exportSeed()` returns correct seed from vault
- [ ] `createNewLedger()` still works — genesis + vault both populated
- [ ] `importFromSeed()` still works
- [ ] `importFromFile()` still works
- [ ] Full test suite: no regressions

## Tradeoffs Recap

| | Approach B (this plan) |
|---|---|
| Changes block hashes? | **No** — chain is untouched |
| Cross-client hash consistency? | **Preserved** — same hashes as source |
| Papers over bugs? | **No** — entry hash failures become import errors |
| Schema/AuthService refactor? | **Yes** — but `_phpoc_meta` already exists |
| Effort | **Medium** — 6 files, ~120 lines changed |
| Long-term correctness | **Best** — clean separation of seed storage from chain |
