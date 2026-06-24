# Local Import/Export — Web

> Map: file-based ledger import/export. v1/v2/raw-chain formats, two-phase
> validate→confirm import, genesis identity gating. No remote transport involved.
> 8 test suites (112 unit + 170 new = 282 total, all passing).

## Module Map

| File | Concern | Key exports |
|---|---|---|
| `phpoc-web/src/services/ledger_export.js` | Build signed export Blobs (v1 staging, v2 full) | `exportLedger()`, `exportLedgerFull()` |
| `phpoc-web/src/services/ledger_import.js` | Parse + validate imported file (v1, v2, raw chain) | `importLedger()` |
| `phpoc-web/src/ledger/utils.js` | Python-compatible JSON: sorted keys, `": "` / `", "` spacing | `jsonSort()` |
| `phpoc-web/src/crypto/index.js` | `seal()`, `verifySeal()`, `sha256()`, `authenticate()` | `CryptoService` |
| `phpoc-web/src/context/DevModeContext.jsx` | `validateImport` → `confirmImport` two-phase, `exportLedgerAction` | context provider |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | File picker, auth form, destroy warning, keep-staging toggle | — |

## File Formats

### v1 (staging only)
```
{ format_version, exported_at, entries: [{entry_id, title, ..., hash}], seal }
```
Seal = `HMAC(jsonSort(entries), MK)`. Wrapper metadata outside seal.

### v2 (full ledger)
```
{ format_version, exported_at, ledger: [genesis, day, ...], staging: [...], seal }
```
Seal = `HMAC(jsonSort({ledger, staging}), MK)`.

### Raw chain (CLI `ledger.json`)
```
[{ type:"genesis", day_hash, identity, recovery_seed_enc, signature }, { type:"day", prev_hash, entries: [{hash, data}], day_hash }, ...]
```
Detected by top-level array. Per-block seal (`day_hash`/`month_hash`/`year_hash`), prev_hash chain linkage. No separate staging.

## Storage Keys Touched

| Key (IndexedDB) | Read by | Written by |
|---|---|---|
| `phpoc_seed` | export (auth) | import (`confirmImport`) |
| `phpoc_username` | — | import (from genesis identity) |
| `phpoc_email` | — | import (from genesis identity) |
| `ledger:blocks` | export (v2), import (genesis check) | import (v2/chain) |
| `entries` | export (v1/v2), import (keep-staging check) | import (merged staging) |

## Export — Decision Tree

```
[Export] button (Settings or Onboarding)
  ├─ Services loaded (Settings fast path)
  │   ├─ MK cached? → use it
  │   └─ MK null → prompt passphrase → authenticate(passphrase, seed, 600000) → MK
  │
  │   v1: sync.readEntries() → exportLedger(entries, crypto, MK) → Blob
  │   v2: storage.get('ledger:blocks') + sync.readEntries()
  │       → exportLedgerFull(blocks, staging, crypto, MK) → Blob
  │
  └─ Services not loaded (Onboarding slow path)
      → createStorage() → CryptoService.create() → authenticate → export
```

**Pure read** — no staging entries are committed during export.

## Import — Decision Tree (Two-Phase)

### Phase 1: `validateImport(file, passphrase, seed)`

```
1. CryptoService.create() → authenticate(passphrase, seed, 600000) → MK

2. importLedger(file, crypto, MK) → { entries, count, genesisHash, formatVersion, ledger }
   ├─ [v1/v2] Parse JSON → detect format_version
   │   ├─ verifySeal(sealPayload, seal, MK) → fail? throw
   │   └─ per-entry: sha256(jsonSort(entryData)) === entry.hash → fail? throw
   └─ [chain] Detect array
       ├─ genesis.type==="genesis"? day_hash present?
       ├─ per-block seal: verifySeal(jsonSort(blockContent), block[hashField], MK)
       ├─ prev_hash chain linkage (block[i].prev_hash === block[i-1][hashField])
       └─ per-entry hash inside day blocks → fail? throw
   → ANY failure = reject entirely (no partial import)

3. Genesis identity check
   existing = storage.get('ledger:blocks')
   existingGenesis = existing[0]?.day_hash
   incomingGenesis = result.genesisHash
   ├─ both present + same → REJECT (merge not supported)
   └─ new or different → proceed

4. Store pending in pendingImportRef + return to UI
   { needsConfirmation, genesisCheck, stagingCount, blocksCount,
     importEntryCount, formatVersion }
```

### Phase 2: `confirmImport({ keepStaging })`

```
1. keepStaging && existing staging? → savedStaging = [...existingEntries]

2. storage.clear()          ← destroys ALL IndexedDB keys

3. storage.set('phpoc_seed', seed)

4. Merge staging
   importedIds = Set(result.entries.map(e => e.entry_id))
   merged = [...savedStaging.filter(s => !importedIds.has(s.entry_id)),
              ...result.entries]     ← imported wins on collision
   storage.set('entries', merged)

5. result.ledger? → storage.set('ledger:blocks', result.ledger)

6. genesis.identity? → write username + email to storage

7. bootstrapServices({ crypto, MK, storage }) → ready phase
```

## OnboardingScreen Flow

```
Phase: 'import' → Source: 'file'
  ├─ File picker (.json) + Recovery Seed + Passphrase
  ├─ [Import Ledger] → Phase 1: validateImport
  │
  ├─ [existing data?] → inline destroy warning
  │   ├─ ⚠ "{N} committed blocks will be replaced"
  │   ├─ ⚠ "{N} staging entries will be lost unless preserved"
  │   ├─ [Export current ledger] button (if onExportFull available)
  │   ├─ ☑ "I understand this will destroy my existing ledger" (required)
  │   └─ ☑ "Keep {N} staging entries after import" (default checked)
  │
  └─ [Executing spinner] → Phase 2: confirmImport({ keepStaging })
```

## Key Invariants

1. **Seal covers data only** — `exported_at` and `format_version` sit outside the sealed region. Format evolution doesn't break verification.
2. **All-or-nothing import** — any validation failure (seal, hash, chain linkage) rejects the entire file. No partial writes.
3. **Genesis identity gate** — same genesis = reject ("merge not yet supported"). Only new/different genesis accepted.
4. **Entry hash re-validation** — every imported entry's hash recomputed via `sha256(jsonSort(entryData))`. Catches corruption regardless of seal.
5. **Entry merge dedup** — imported entries win on `entry_id` collision. Existing entries (if `keepStaging=true`) with unique IDs preserved.
6. **Full clear before write** — `storage.clear()` ensures no stale keys survive the import.
7. **JSON cross-implementation compat** — `jsonSort()` produces Python-identical output (`": "` / `", "` spacing, sorted at all nesting levels). Seals verify across CLI ↔ Web.
8. **Raw chain: no staging** — CLI `ledger.json` returns `entries: []`, `ledger: blocks[]`. Committed chain written directly — no separate staging recovery.
9. **Two-phase: read-then-write** — `validateImport` is read-only (no storage writes). `confirmImport` executes the destructive write. Enables destroy-warning UI with counts.

## Diagnostic Checkpoints

| # | Check | How |
|---|---|---|
| 1 | File selected + readable? | `file.text()` → valid JSON parse |
| 2 | Format detected? | `result.formatVersion` ∈ `{'1','2','chain'}` |
| 3 | Seal verifies? | `crypto.verifySeal(payload, seal, MK)` |
| 4 | Every entry hash matches? | recompute `sha256(jsonSort(entryData))` per entry/block |
| 5 | Chain linkage intact? (raw chain) | block[i].prev_hash === block[i-1][hashField] |
| 6 | Genesis identity conflict? | `result.genesisHash === existing[0].day_hash` → reject |
| 7 | Seed persisted? | `storage.get('phpoc_seed')` after import |
| 8 | Ledger persisted? (v2/chain) | `storage.get('ledger:blocks')` after import |
| 9 | Identity persisted? | `storage.get('phpoc_username')` / `'phpoc_email'` |
| 10 | Services bootstrapped? | `phase === 'ready'` in context |

## Known Gaps

- Same-genesis merge not wired — `LedgerMerge.merge()` exists in `src/ledger/merge.js` but import rejects with "merge not yet supported".
- v1 imports have no genesis info (`genesisHash: null`) — genesis identity check skipped for v1 files.
- Raw chain entries stay in `ledger:blocks` — no way to extract them into staging for re-commit or editing.
- Seed must be provided as-is — no seed re-derivation from passphrase during import. Lost seed = import fails at auth step.
- File size bounded by browser memory — Blob → text() parses entire file into a string. Large ledgers (>100MB) may OOM.
