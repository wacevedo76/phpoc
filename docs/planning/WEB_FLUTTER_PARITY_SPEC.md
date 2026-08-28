# Web ↔ Flutter Parity — Spec

> **Status:** 🔜 Planning (2026-08-28)
> **Scope:** Bring `phpoc-web` in line with `phpoc-flutter` for the tracked feature set.
> **Basis:** Cross-referenced the C-2 roadmap, `ROADMAP.md`, `WEB_ROADMAP.md`, `BACKLOG.md`,
> the ADRs (026/029/029a/030/031), and spot-checked the web source.

## Already In Line (out of scope)

Web already matches Flutter on these — no work required:

| Area | Evidence |
|------|----------|
| C-2 seed re-key | `RekeyService` 28/28 node + Settings "Security & Recovery" UI 6/6 |
| ADR-030 ledger auto-pull on ownership handoff | `web_ledger_auto_pull_test.mjs` 17/17 |
| Wipe ledger from unlock screen | `auth_screen_wipe_test.mjs` 7/7 |
| Staging sync (`staging/blob` + `staging/hash_index.json` + `activity_id` LWW) | CCS-2 "Option B" 41/41 + CCS-4 cross-client E2E |
| Per-field entry encryption | `ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md` (61 blueprint assertions) |
| ADR-029/029a seal whitelist (chain/engine/index/merge/summary) | `chain_seal_whitelist_test.mjs` 28/28 |

## Gaps (in scope)

### P1. Commonplace Book — entirely missing on Web 🟠

The one substantive feature gap. Flutter ships the full Commonplace Book (ADR-031): a separate
sealed `commonplace.json` chain + Book Switcher + screen/add-entry/topic-index + Settings + shared
seed-re-key. Web has **zero** Commonplace support (no refs in `src/` or `test/`). Build order is
Flutter → Web → CLI.

**Planning doc:** `COMMONPLACE_BOOK_WEB_ROADMAP.md`

### P2. C-2 cross-client verification (Phase D) 🟠

Web's re-key engine + UI are done, but the cross-client proof is open: a chain re-keyed on any
client must pull + verify under the new MK on the other two, and a device holding the old seed
must fail to decrypt (leak-nullification). Plus the spec/format pass and doc updates.

**Planning doc:** `C2_CROSS_CLIENT_VERIFY_PHASE1.md`

### P3. Web staging "Option A" (deferred refactor) 🟡

Web sync is functionally in line via CCS-2 "Option B" (reconcile layer over `LocalCache`), but the
migration to `RowStagingStore` as the authoritative CRUD store was explicitly deferred. Known
cleanup, not a behavior gap.

**Planning doc:** `WEB_STAGING_OPTION_A_PHASE1.md`

### P4. Web vitest harness hygiene ✅

`vite.config.js` `test.include` had a second glob pulling the `node --test` suites into vitest
(77 "non-green" files were harness noise, not failures) + 3 genuine load errors. **DONE 2026-08-28:**
single glob; 3 load errors fixed; 8 mis-named node suites renamed `*.test.mjs`→`*_test.mjs`; 2 mock
gaps patched. `npx vitest run` now clean: 9 files / 119 passed / 1 skip / 0 fail / 0 errors.

**Planning doc:** `WEB_VITEST_HARNESS_PHASE1.md`

## Related (not web — same roadmap family)

- **CLI C-2 Phase A** — `ph rekey-seed` / `--renew-seed` still missing (CLI only bumps `key_version`
  under the same seed). Tracked in `C2_SEED_REKEY_WEB_CLI_ROADMAP.md`; out of scope for this
  web-parity spec, but Phase D (P2) depends on it for full cross-client coverage.

## Ordering

1. **P1** — the substantive feature gap (longest). Slices ordered Flutter-mirrored (engine → switcher → UI → settings).
2. **P2** — verification + docs; can partially proceed now using Web as the re-keying client.
3. **P3 / P4** — independent cleanups, can run any time; P4 is a fast prerequisite for trusting the web suite.
