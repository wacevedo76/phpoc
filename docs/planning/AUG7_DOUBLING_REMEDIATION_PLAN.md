# Aug 7 Doubling — Residual Double-Seal Remediation Plan (Option a)

## Purpose
Remove the 12 baked-in historical double-seals that remain in the **personal remote
ledger** (the residual from the "activities through Aug 7 doubled" investigation —
`SESSION_HISTORY_2026-08-22.md`). This is **option (a)** from that investigation:
a one-time data repair, not a commit-path change.

## Background
- Root cause (already documented): the commit path appended a fresh sealed entry every
  time a long-running task was committed while active — same `start` ms, growing `end`,
  no dedup by `start`. The 12 oldest entries (Apr 23 → Jul) carry no
  `activity_id`, so they survive restores as part of the canonical chain.
- The full-ledger re-seed doubling is already fixed (`2d05aff`, `StagingSeedDeduper`).
  Only these 12 historical seals remain.
- Remote chain (read-only scan): **140 blocks / 287 entries** (was 134/275 at the
  Aug-22 archive). The extra blocks are later normal commits.

## Decision — Option (a): one-time data repair
Group every day entry **globally** by `decrypted startTime` (exact ms) **alone** and
keep the seal with the **latest `end`**; drop the superseded copies, then re-seal the
chain from the first affected block to the tip (prev_hash linkage cascades).

**Dedup criterion = same EXACT start-ms.** It is virtually impossible for a human to
start two tasks in the same millisecond, so entries sharing a start ms are the same
activity — even if the title was edited (case drift) between duplicate commits. Title
is therefore **not** part of the key.

### Key structural facts (drive the implementation)
1. **Duplicates span multiple day blocks, not one.** The same `start` appears in
   several day blocks (e.g. start `1779475456931` "Working on Phpoc" is sealed in
   blocks 48, 49, 55, 57). Dedup must therefore be **global across the whole chain**.
2. **Migrated hash alias invariant.** Every block stores a uniform `block_hash` **and**
   a type-specific alias (`day_hash`/`month_hash`/`year_hash`), all equal. Python
   `get_block_hash` reads `block_hash` first; Flutter `getBlockHash` reads the
   type-specific key. A re-seal must write **both** to the same new seal, or the chain
   verifies under Python but silently fails under Flutter.
3. **`original_hash` is provenance, not re-computed.** It holds the pre-migration seal
   and is itself part of the ADR-029a seal whitelist; preserve it verbatim.
4. **Identity secret is not recoverable from R2.** Flutter strips all identity metadata
   (`identity_secret_enc_fallback`, etc.) from the genesis before push; the remote
   genesis carries only `original_hash`. Re-signing identity seals requires the
   device's secret. Without it, `identity_seal` is dropped on re-sealed blocks (safe —
   both clients skip the check when the field is absent).

### Dedup result (dry-run verified against live R2, read-only)
5 groups, 12 copies → keep 5, remove 7 superseded seals:

| title | start (ms) | copies | keep (block) | remove (blocks) |
|---|---|---|---|---|
| Working on phpoc | 1779099621610 | 2 | 46 | 39 |
| Working on phpoc | 1779103660530 | 2 | 46 | 39 |
| Working on Phpoc | 1779443857168 | 2 | 55 | 57 |
| Working on Phpoc | 1779475456931 | 4 | 55 | 48, 49, 57 |
| Working on Phpoc | 1779884325111 | 2 | 59 | 61 |

- First affected block **39** (May 18) → re-seal **101 blocks (39…139)**.
- Blocks **49, 57, 61** become empty (all their entries were superseded). They are
  **kept** as empty day blocks — "remove seals, not blocks" — preserving `day_index`
  and block structure (the chain already contains empty day blocks 64–68).

## Tool
`scripts/repair_ledger_same_start_dedup.py` — dry-run by default, **never** writes to
`~/.local/share/phpoc/`, **never** pushes to remote.

```
# dry-run against live R2 (read-only)
python3 scripts/repair_ledger_same_start_dedup.py

# materialize the repaired chain for review (still no remote write)
python3 scripts/repair_ledger_same_start_dedup.py --output /tmp/repaired.json

# re-sign identity seals too (only if you can supply the device secret)
python3 scripts/repair_ledger_same_start_dedup.py --output /tmp/repaired.json \
    --identity-secret <64-hex>
```

Both the source and the repaired chain are re-verified (`verify_ledger.Verifier`) —
`VALID: chain verifies (140 blocks)` confirmed for both.

## Apply + push (separate, user-initiated — NOT automated)
The repair script only produces the repaired chain. Applying it to R2 is a separate,
deliberate step via `scripts/apply_ledger_repair_r2.py`, which is **dry-run by default**
and writes only with an explicit `--apply` (plus interactive confirmation):

```
# dry-run against live R2 (read-only): lists exact block/index plan
python3 scripts/apply_ledger_repair_r2.py --input /tmp/repaired.json

# apply (user-initiated): overwrite re-sealed blocks + rebuild hash_index/index
python3 scripts/apply_ledger_repair_r2.py --input /tmp/repaired.json --apply
```

The apply script compares by seal against the ACTUAL remote blocks, overwrites only the
re-sealed span, and regenerates + pushes `hash_index.json` (+ `.sha256`) and `index.json`
(the remote `.sha256` sidecar is currently missing). After apply, each client must do a
**full restore-from-cloud** (not incremental sync, which would detect a divergence at
block 39).

## Open decisions / risks
- **Identity seal re-sign**: if the device secret is available, re-sign; otherwise the
  re-sealed blocks carry no `identity_seal`. No client fails verification either way,
  but the re-sealed span would be identity-unsigned.
- **Empty blocks 49/57/61**: kept (minimal change). Alternative is full block removal,
  which also changes block structure — rejected as more invasive.
- **Archive-table correction**: `SESSION_HISTORY_2026-08-22.md`'s May-22 group was
  listed ×3; it is actually **×4** (missing hash `4bdbf4f2…`). Corrected.

## Doc impact
- This plan (new).
- `docs/planning/archive/SESSION_HISTORY_2026-08-22.md` — May-22 ×3 → ×4 (corrected).
