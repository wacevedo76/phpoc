# Staging Seed Dedup Fix — Test Exploration (Phase 1)
> **Plan:** Root-cause fix for cross-device ledger duplication (live-verified 2026-08-19)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ 4-Phase TDD complete (2026-08-21)
> **Next Phase:** (none — complete)

## Architecture Overview

**Affected modules** (both have the identical latent dedup bug):
- `lib/services/ledger_pull_service.dart` — `_seedStagingFromBlocks(List<Map<String,dynamic>> blocks)` (§ cloud pull path)
- `lib/services/onboarding_service.dart` — `_seedStagingFromImportedBlocks()` (§ file-import / raw-chain / v2-import path)

**The bug (root cause):** When the app restores from cloud or imports a ledger, it re-seeds the
history display (`staging` table) from the **sealed ledger day-blocks**. The dedup that should
prevent re-seeding already-present activities keys exclusively on the block-entry's **`entry_id`**
or **`hash`**. But `LedgerEngine._prepareEntries` (engine.dart:414) **strips `entry_id` and `hash`
before sealing** while **retaining `activity_id`**. So:

1. A device-created activity gets a real `activity_id` (e.g. `GXmRySa0EE`) and sits in `staging`
   with **no `entry_id`**.
2. It is committed → sealed into a day-block whose `data` **keeps `activity_id`** but **drops `entry_id`**.
3. On the next re-seed, the seed loop reads the block entry, sees `eid == null`, **skips the dedup
   check** (`if (eid != null && eid.isNotEmpty && existingHashes.contains(eid))`), and calls
   `generateActivityId()` to mint a **fresh random 10-char id** → inserts a **second copy** of the
   same activity under a different `activity_id`, with `end_device_uuid = None`.

**Observable damage (phone, debug-mode DB):** staging held **287 rows, all `committed=true`** (→ no
orange border), with **8 exact `(title,start_epoch,duration)` duplicate pairs** — each pair one real
row (`end_device_uuid` set) + one re-seeded copy (`end_device_uuid=None`, `generateActivityId()`-style
id like `tuttsrrqpp`). The re-seeds landed in two batches (`updated_at` 14:28:03 ×6 and 18:19:38 ×2).
The phone's local ledger grew to **135 blocks** vs the clean shared 132 → 3 extra local-only day blocks.

**The fix (both functions):**
- **P1 Dedup by `activity_id`:** add each existing staging row's `activity_id` to the dedup set, and
  skip a block entry whose `data['activity_id']` is already present.
- **P2 Reuse original `activity_id`:** when `entry_id` is missing but `data['activity_id']` is a valid
  10-char id, retain it (instead of `generateActivityId()`).

Together these make a re-seed idempotent: the committed activity is either skipped (P1) or re-inserted
with its original id (P2), never duplicated.

## Test Groups

### Group S: `_seedStagingFromBlocks` dedup (LedgerPullService) — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | Block entry whose `data['activity_id']` already exists in staging is **not** re-seeded (no duplicate row) | Fix P1 dedup-by-id at pull time | Existing row was unit-tested to survive a pull re-seed; entry_id is stripped so id is the only stable key |
| S2 | A newly-committed block entry **with** `activity_id` in `data` re-seeds using that **same** id (not `generateActivityId()`) | Fix P2 id reuse | Prevents a same-activity second row with a different id |
| S3 | Block entry with **no** `activity_id` and **no** `entry_id` still seeds (falls back to `generateActivityId()`) | Backward compatibility | Legacy/foreign blocks may carry neither identifier; must still surface in History |
| S4 | When both `entry_id` and `activity_id` present, dedup honors either identifier (skip if either matches) | Fix P1 completeness | Guard against mixed-identifier duplicates across seed sources |
| S5 | Re-seeding the *same* block set twice yields **no** extra rows (idempotence) | Fix P1/P2 behavior | `pullAll()` runs on every restore/poll; must be safe to repeat |
| S6 | Re-seed copies preserve `committed:true` and `updated_at` re-stamped | Fix P2 row shape | Seeded rows must remain committed display rows (no orange border) |

### Group I: `_seedStagingFromImportedBlocks` dedup (OnboardingService) — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Import re-seed skips a block activity already present by `activity_id` (no duplicate) | Fix P1 on import path | Mirrors S1; import is the second seed entry point |
| I2 | `activity_id` present in block `data` is reused (not re-generated) on import | Fix P2 on import path | Mirrors S2 |
| I3 | `_seedStagingFromImportedBlocks` is idempotent when run twice | Fix P1/P2 | `importFromFile` can run after an earlier seed |
| I4 | Mixed `entry_id`-vs-`activity_id` dedup across seed runs → single row | Fix P1 completeness | Different seed runs may key differently |
| I5 | Seeded row with original `activity_id` still carries `committed:true` and `end_epoch` | Fix P2 integrity | History shows committed entries with correct time span |

### Group U: Regression (existing blueprints) — 3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| U1 | Existing U1 case still seeds completed entries into staging after the dedup change | No regression | onboarding_staging_seed_test.dart U1 must stay GREEN |
| U2 | Existing C3 pull case still seeds the two entries after the change | No regression | ledger_pull_service_test.dart C3 must stay GREEN |
| U3 | Full `test/data/ledger` + seed suites remain GREEN (no new failures) | No regression | Change touches only the two seed functions |

## Summary Report
- **Total assertions:** 14 (S:6, I:5, U:3)
- **Modules covered:** `ledger_pull_service.dart`, `onboarding_service.dart`
- **Key coverage:** dedup-by-`activity_id` across both seed paths; id-reuse; idempotence; backward
  compatibility for identifier-less legacy blocks; committed-row shape preservation.
- **Root-cause regression tests:** S1/S2/I1/I2 reproduce the exact live phone duplication.
