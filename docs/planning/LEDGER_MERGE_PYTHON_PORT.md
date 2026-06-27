# Python Port of LedgerMerge — Test Specification (TDD)

> **Source:** `phpoc-web/src/ledger/merge.js` (~275 lines) + `phpoc-web/test/ledger_merge_test.mjs` (~1434 lines, 40 tests)
> **Target:** `domain/ledger/merge.py` + `tests/test_ledger_merge.py`
> **Phase:** TDD RED first — write all 41 tests, then implement.

## Architecture

`LedgerMerge` is a standalone static class (no Engine/Chain dependency). Signature:

```python
class LedgerMerge:
    @staticmethod
    async def merge(local_chain, remote_chain, crypto, master_key,
                    identity_secret=None, summary_policy=None) -> dict:
        """
        Returns: {"merged_chain": list[dict], "stats": dict, "index": dict}
        stats keys: forkIndex, localEntries, remoteEntries, duplicatesSkipped,
                    mergedEntries, newBlockCount
        """

    @staticmethod
    async def _verify_chain(label, chain, crypto, master_key, identity_secret=None):
        """Raises on validation failure, checks seals + prev_hash + entry hashes."""

    @staticmethod
    def _verify_block_data(block, crypto, master_key, identity_secret=None) -> bool:
        """Checks seal, optional signature, entry hashes for a single block."""
```

## 7-Step Merge Algorithm (from merge.js)

1. **FIND FORK POINT** — walk both chains, stop where block hashes diverge
2. **EXTRACT DIVERGENT ENTRIES** — collect all entries from post-fork blocks
3. **DE-DUPLICATE** — strict `content_hash` match; keep local, skip remote dupes
4. **SORT** — alphabetically by `data.title` (privacy-first ordering)
5. **REBUILD CHAIN** — common prefix + rebuilt day blocks with summary inserts
6. **REBUILD INDEX** — aggregate durations by date and title
7. **RETURN** — merged chain, stats, and index

## Test Helpers Needed (define in `tests/test_ledger_merge.py`)

All helpers mirror the JS `ledger_merge_test.mjs` helpers exactly:

| Helper | Purpose |
|--------|---------|
| `_MockCrypto` | Reversible encrypt/decrypt (`enc:` prefix + hex), HMAC-SHA256 seal/sign/verify. Use same pattern as `tests/test_phase3_ledger_engine.py` lines 33-75. |
| `make_entry(title, start_epoch, duration, tags, comment, content_hash)` | Returns `{"hash": str, "data": dict}` with encrypted startTime_enc/endTime_enc, computed content_hash and entry hash |
| `compute_content_hash(data)` | SHA-256 of sorted content fields (title, startTime_enc, endTime_enc, duration, tags, pauses_enc, metadata_enc, comment, media) |
| `compute_entry_hash(data)` | SHA-256 of `json.dumps(data, sort_keys=True, indent=2)` — matches `engine.py` convention |
| `get_block_hash(block)` | `block.get("day_hash") or block.get("month_hash") or block.get("year_hash")` |
| `build_day_block(entries, prev_hash, date_str, day_index)` | Sealed day block with optional identity signature. Entries normalized to `{hash, data}` format. |
| `build_genesis_block()` | Genesis block with deterministic identity fields, sealed with `_MockCrypto.seal()` |
| `build_chain(day_specs)` | Genesis + sequence of day blocks from specs. `day_specs = [{"date": "2026-06-10", "entries": [e1, e2]}, ...]` |
| `decrypt_start_epoch(entry_data)` | Decodes `enc:` prefix and parses epoch int |
| `epoch_for_date(date_str)` | `datetime.strptime(date_str + "T00:00:00Z", ...).timestamp() * 1000` — midnight UTC ms |

### Constants

```python
MASTER_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
IDENTITY_SECRET = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"
ZERO_HASH = "0" * 64
```

### Pre-built Test Entries

Match JS exactly: ENTRY_A through ENTRY_F, ENTRY_A2, ENTRY_A_LATE, ENTRY_A_DIFFTAGS, ENTRY_A_DIFFDUR. Defined at module level with `make_entry()`.

---

## Test Groups (TDD RED Phase — All 41 Tests)

### Module Existence (1 test)
| ID | Test | Assertion |
|----|------|-----------|
| M1 | `LedgerMerge.merge` is callable | Module exists, `merge()` is a function |

### Group A — Fork Detection (4 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| A1 | Fork at genesis | Two chains with same genesis but first day block differs → `forkIndex=0` |
| A2 | Fork after N blocks | Common prefix of 1 day block, then different entries → `forkIndex=1` |
| A3 | Fork after summary block | Chains share day block at 2026-06-30, diverge at 2026-07-01 → `forkIndex=1` |
| A4 | Identical chains | Same chain for both local and remote → `forkIndex=len(chain)-1`, all remote are duplicates, no new blocks |

### Group B — Simple Merge, No Duplicates (4 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| B1 | Remote empty | Remote is genesis-only (0 entries) → merged preserves all local entries, `remoteEntries=0` |
| B2 | Local empty | Local is genesis-only → merged preserves all remote entries, `localEntries=0` |
| B3 | Non-overlapping entries | Local has 2 entries, remote has 2 different entries → `mergedEntries=4`, 0 duplicates |
| B4 | Different dates | Local 2026-06-10, remote 2026-06-15 → at least 2 day blocks in merged chain |

### Group C — Dedup via content_hash (6 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| C1 | Exact duplicate | Same title+time entry in both chains → `duplicatesSkipped=1`, `mergedEntries=1` |
| C2 | Multiple duplicates | 2 shared entries + 1 unique → `duplicatesSkipped=2`, `mergedEntries=3` |
| C3 | All remote are duplicates | Every remote entry matches a local entry → `newBlockCount=0`, no rebuild |
| C4 | Same title, different times | Different start_epoch → different content_hash → NOT deduplicated → `mergedEntries=2` |
| C5 | Same title, different tags | Different tags → different content_hash → NOT deduplicated → `mergedEntries=2` |
| C6 | Same title, different duration | Different duration → different content_hash → NOT deduplicated → `mergedEntries=2` |

### Group D — Summary Block Handling (3 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| D1 | Divergent summary blocks regenerated | Two chains with June 30 block, diverge at July 1 → merged chain gets fresh summary blocks |
| D2 | Year boundary summary regeneration | Local Dec 31, remote Dec 31 + Jan 1 → year_summary inserted at year boundary |
| D3 | Empty day blocks not carried over | Source chains have empty day blocks → those blocks don't appear in merged chain |

### Group E — Alphabetical Ordering (3 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| E1 | Sort order | Zebra, Alpha, Middle → sorted as [Alpha, Middle, Zebra] |
| E2 | Same-title stability | Two entries both titled "AAA" → both kept, both have title "AAA" |
| E3 | Mixed-case ordering | "apple task", "Apple Task", "zebra" → all present, localeCompare ordering |

### Group F — Chain Integrity After Merge (5 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| F1 | Full verify passes | All block seals in merged chain verify with `crypto.verify_seal()` |
| F2 | prev_hash linkage correct | Every block's `prev_hash` matches previous block's hash throughout merged chain |
| F3 | Entry hashes preserved | Original entry hashes from source chains are present in merged chain |
| F4 | content_hash unchanged | Original `data.content_hash` values preserved in merged chain |
| F5 | Block seals verify with crypto | Each merged block's seal matches recomputed `crypto.seal()` |

### Group G — Index Rebuild (2 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| G1 | Index contains both chains' entries | Merge returns an `index` dict, it's a non-null object |
| G2 | Durations summed correctly | Two "Running" entries on same date with durations 3600000+1800000 → index shows 5400000 |

### Group H — Stats Accuracy (5 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| H1 | Entry counts match | Non-overlapping 2+2 → `localEntries=2`, `remoteEntries=2`, `mergedEntries=4` |
| H2 | Zero duplicates | Non-overlapping entries → `duplicatesSkipped=0`, `mergedEntries = local+remote` |
| H3 | All duplicates → correct stats | Identical chains → `duplicatesSkipped=2`, `mergedEntries=2`, `newBlockCount=0` |
| H4 | forkIndex correct | 2 common blocks then divergence → `forkIndex=1` (index of last common block) |
| H5 | newBlockCount correct | Local has 1 block, remote adds 2 unique dates → `newBlockCount>=2`, 3 day blocks total |

### Group I — Edge Cases (4 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| I1 | Genesis-only chains | Both chains are `[genesis]` → `forkIndex=0`, `mergedEntries=0`, `newBlockCount=0` |
| I2 | Genesis mismatch → error | Different genesis blocks → merge raises error containing "genesis" |
| I3 | Remote subset of local | Remote has first day only of local's 2-day chain → remote is subset, 0 new blocks |
| I4 | Local subset of remote | Local has 1 entry, remote has 3 (including the 1) → `duplicatesSkipped=1`, new blocks added |

### Group J — Input Chain Validation (10 tests)
| ID | Test | What It Proves |
|----|------|----------------|
| J1 | Tampered block seal → rejects | Flip first byte of a day_hash → `_verify_chain()` raises "seal" validation error |
| J2 | Broken prev_hash → rejects | Set block[2].prev_hash to wrong value → raises "prev_hash mismatch" |
| J3 | Tampered entry hash → rejects | Flip first byte of entry hash → raises "entry hash" validation error |
| J4 | Empty chain passes validation | `_verify_chain("local", [])` → no error (trivially valid) |
| J5 | Valid chain passes silently | `_verify_chain("remote", valid_chain)` → no error |
| J6 | merge rejects invalid local | Tampered local genesis seal → `merge()` raises "local chain validation failed" |
| J7 | merge rejects invalid remote | Tampered remote genesis seal → `merge()` raises "remote chain validation failed" |
| J8 | Both invalid → local fires first | Both chains tampered → error says "local" not "remote" |
| J9 | Invalid remote + genesis mismatch → validation first | Day block seal tampered on different-genesis remote → "remote chain validation failed" fires, NOT genesis error |
| J10 | Invalid local + genesis mismatch → validation first | Tampered local genesis + different-genesis remote → "local chain validation failed" fires first |

---

## Implementation Notes

### Production code: `domain/ledger/merge.py`

- `LedgerMerge` is a class with `@staticmethod` methods (matches JS)
- `merge()` is `async` because `_verify_chain` needs `crypto.verify_seal()` which may be async; and decrypting `startTime_enc` for date grouping needs `crypto.decrypt()` which may be async
- Uses `YearMonthSummaryPolicy` from `domain/ledger/summary_policy.py` for rebuild (default if `summary_policy=None`)
- `_verify_block_data()` mirrors `LedgerChain._verify_block_data()` from JS but operates on raw dicts (no store dependency)
- `_verify_chain()` iterates blocks, checks prev_hash linkage + calls `_verify_block_data()` for each

### Wiring: `core/sync/orchestrator.py` `_sync_ledger_blocks()`

After `RemoteLedgerSync.pull_blocks()` detects divergence (returns `None`), call:
```python
result = await LedgerMerge.merge(local_chain, remote_chain, crypto, master_key)
# Replace local chain, force-push merged result
```

Needs new `pull_full_chain()` on `RemoteLedgerSync` to fetch ALL remote blocks (for merge).

### Test file: `tests/test_ledger_merge.py`

- Use `unittest.TestCase` pattern (matches existing ledger tests)
- One test method per test case above (e.g., `test_a1_fork_at_genesis`)
- Group methods into test classes: `TestLedgerMergeModule`, `TestForkDetection`, `TestSimpleMerge`, etc.
- Add `test_ledger_merge` timeout entry in `conftest.py` `timeout_map` (value: 30)
- Define all helpers inside the test file (self-contained, matching existing test style)

### Test run command
```bash
cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_ledger_merge.py -v
```
