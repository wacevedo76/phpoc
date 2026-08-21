# Ledger Validity Testing Workflow — Phase 1 Blueprint

**Status:** Testing-workflow blueprint (matches 4-phase TDD Phase 1: test exploration)
**Date:** 2026-08-20
**Owner:** Flutter / data-layer verification

## Problem

"Verify Ledger" (Settings → _verifyLedger → `engine.verify()`) reports INVALID for
the emulator ledger, even though prior commits (**08235f8** "emit sealed day_index in
blockToMap") were supposed to make pulled chains verifiable. Need a reproducible
offline workflow that mirrors `chain.verify()` so the failure is pinpointed without
relying on the app's UI.

## Deliverable

`scripts/verify_ledger.py` — a Python port of `phpoc-flutter/lib/data/ledger/chain.dart
verify()` plus the crypto used by `sealable_chain.dart`. Feeds ledger JSON in, reports
the first failing check or VALID.

## Checks (in order, mirroring chain.verify())

| # | Check | Key needed? | Emulator result |
|---|-------|-------------|-----------------|
| 1 | prev_hash linkage across blocks | no | ✅ 0 breaks |
| 2 | per-block seal (HMAC-SHA256 over ADR-029a seal-field whitelist) | MK | ❌ genesis has NO stored `block_hash` |
| 3 | identity_seal (HMAC-SHA256 signature) | identity secret | n/a (genesis has none) |
| 4 | entry hash (3-way serialization fallback) | no | ✅ 267/267 pass |
| 5 | content_hash (decrypt `_enc` fields, canonical jsonSort) | MK | pending — needs MK |
| 6 | key_version invariant (day ≤ genesis) | no | ✅ |

## Crypto scheme (PHPSPEC §3 / §5.2) — implemented

- `jsonSort(data)` = Python `json.dumps(sort_keys=True, ensure_ascii=False)`
  (keys sorted at every level, `, ` / `: ` separators, array order preserved).
- `seal_key = HMAC-SHA256(MK, "integrity-key-salt")`
- `seal = HMAC-SHA256(seal_key, jsonSort(seal_fields))`
  (backward-compat fallback: `HMAC-SHA256(raw MK, jsonSort(seal_fields))`)
- identity_seal = `HMAC-SHA256(identity_secret, block_hash)`
- Entry hash validated against 3 candidate serializations.

**Seal logic verified** against `testdata/canonical_seal_vectors.json`
(MK `deadbeef…`, V-genesis / V-day / V-month / V-year expected seals all match).

## Emulator diagnosis (root cause) — CONFIRMED with personal MK (2026-08-20)

The emulator ledger (emulator-5554, `com.phpoc.phpoc_flutter`, 126 blocks) is a
**legacy storage-format chain (Block C)**, NOT current 0.4.0 format. Verified with the
personal recovery seed / MK (passed only via CLI, never written to the repo):

- **Block seals: not stored at all.** 0/126 blocks carry a seal key (`block_hash`/`day_hash`/
  `month_hash`/`year_hash`) in `data_enc`; blocks 1–125 store `data_enc` as a raw JSON
  **entries array** (no map). Genesis `data_enc` holds only `{"seed": "<200-char base64 → 150 bytes>"}`
  (opaque, non-32-byte seed). → `verify()` fails immediately: `INVALID [missing seal key block_hash]`.
- **Content hashes: 0/267 verify** even after AES-128-CTR decrypting `_enc` fields with the real MK.
  Decryption is correct (e.g. `startTime_enc → "1776932008889"`, `metadata_enc → "{}"`), but stored
  `content_hash` values were computed with the **pre-0.4.0 algorithm**, not current
  `jsonSort(canonical)` — legacy chain never run through `migrateChainEncryption()`.

Structural checks (prev_hash linkage, entry hashes) all PASS (0 breaks, 267/267) — the chain
is not corrupted. The INVALID is format/algorithm **drift**: legacy chain was never re-sealed /
re-hashed to the 0.4.0 canonical scheme.

## 🔴 Pre-existing credential leak found (not introduced by this work)

`phpoc-flutter/lib/features/onboarding/onboarding_screen.dart:205-206` and
`phpoc-flutter/tool/diag_verify.dart:19` hardcode the **personal recovery seed and passphrase**
(added in commits `a5b124e` and `08235f8`, committed on current tip `cb22154`). This violates the
root AGENTS.md "No secrets in repo" rule. `scripts/verify_ledger.py` and this blueprint contain **no**
credentials (MK passed only via CLI / heredoc). Recommend neutralizing these now (see Next steps).

## Acceptance criteria

- `verify_ledger.py` accepts `--mk-hex` or `--seed`; reports check + block index on failure;
  exits 0 when VALID (mirrors app).
- Verified against canonical seal vectors (done: all 4 match).
- content_hash (decrypt) check implemented and run against the emulator ledger (done: 0/267,
  proves algorithm drift), and against a known-good chain (pending a current-format sample).
- Reproduces emulator INVALID via the offline tool (done: missing seal key).

## Next steps

1. **Neutralize the pre-existing credential leak**: replace the hardcoded seed/passphrase in
   `onboarding_screen.dart` and `diag_verify.dart` with test-ledger values or runtime refs;
   rotate the recovery seed/passphrase (they are in git history). Await user instruction.
2. Decide: migrate the emulator ledger via `migrateChainEncryption()`, or regenerate the
   remote/R2 ledger so local + remote share the 0.4.0 canonical format. Migration will not
   help local verify unless block seals are also regenerated (current storage lacks them).
