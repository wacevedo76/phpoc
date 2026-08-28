# phpoc-web — Full Vitest Suite Baseline Failure Inventory

> Generated 2026-08-27 from `npx vitest run --reporter=json` in `phpoc-web/`.
> This is an inventory of the **pre-existing** web test-suite baseline — failures present in
> the full `vitest run` that are **unrelated to the C-2 Seed Re-Key Web work** (which is
> 34/34 GREEN: 28/28 node + 6/6 vitest).

> ✅ **REMEDIATED 2026-08-28** — all remediation steps below are complete (see
> `WEB_VITEST_HARNESS_PHASE1.md`): second `include` glob removed, 3 load errors fixed, 8 node
> suites renamed `*.test.mjs`→`*_test.mjs`, and 2 `verifyLedgerChain` mock gaps patched.
> `npx vitest run` is now clean: **9 files / 119 passed / 1 skipped / 0 failed / 0 errors**.

## Executive Summary

| Category | Files | Real test failures? |
|----------|------:|---------------------|
| ✅ Pass cleanly | 8 | — |
| 🔴 Real assertion failures | 0 | **0** (all resolved 2026-08-27) |
| ⚠️ Load / execution errors | 26 | 0 assertions (suite aborted at load) |
| 🔕 Not vitest suites (node `--test` style) | 51 | 0 (wrong harness) |
| **Total discovered by vitest** | **85** | **0** |

**No** file currently has genuine failing assertions. The one prior real failure —
`settings_genesis_component.test.mjs` (25 failed / 1 passed) — was fixed 2026-08-27 by rewriting
`Settings.jsx` `handleSaveRemote` to call `GenesisGate.check` directly (the pre-existing code did a
`/health` fetch-ping first that the component test's mocked `fetch` couldn't satisfy). The other 77
non-green files are harness/config artifacts, not test failures — see root cause below.

## Root Cause

`phpoc-web/vite.config.js` `test.include` contains **two** globs:

```js
include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/*_test.?(c|m)[jt]s?(x)'],
```

The second glob (`**/*_test.?(c|m)[jt]s?(x)`) pulls the project's **node `--test`** files
(which use `node:test` / `node:assert` globals and call `process.exit()`) into the vitest run.
Those files are meant to be run via `node --test test/<name>.mjs` (see `package.json` `test` script),
and vitest cannot execute them — producing the two noise categories below.

---

## ✅ Category 1 — Real assertion failures (RESOLVED 2026-08-27, 0 remaining)

| File | Result |
|------|--------|
| `test/settings_genesis_component.test.mjs` | ~~25 failed / 1 passed~~ → **26 / 0 / 0** |

These 25 RED tests (GenesisGate component — groups B/E/F) exercised `Settings.jsx` `handleSaveRemote`,
which called `GenesisGate.check` only **after** a `/health` fetch-ping. The component test mocks `fetch`
with `{ ok: true, status: 200 }` (no `.json()`), so the ping threw before `GenesisGate.check` ever ran.

**Phase 3 GREEN fix (2026-08-27):** rewrote `handleSaveRemote` to go straight to `GenesisGate.check`
(dropped the ping — the check itself is the connectivity/auth validation), persist
`phpoc_worker_url`/`phpoc_api_key` synchronously (dedup + rapid-change correctness), and keep the
offline/incompatible/error status cards with `role="status"`/`aria-live="polite"`. **26/26 GREEN.**
Phase 4 (REFACTOR) done: extracted a `checkGenesis` helper + latest-request-wins guard, collapsed the
`saved` state to a boolean.

## ⚠️ Category 2 — Load / execution errors (26 files, 0 assertions each)

These suites abort at load/teardown before any assertion runs. Grouped by error:

### `process.exit unexpectedly called with "0"` (19)

- `test/cookie_monitor_reauth_test.mjs`
- `test/export_passphrase_validation_test.mjs`
- `test/i02_index_encryption_test.mjs`
- `test/i02_staging_keys_test.mjs`
- `test/import_orchestration_test.mjs`
- `test/index_manager_test.mjs`
- `test/ledger_chain_test.mjs`
- `test/ledger_export_full_test.mjs`
- `test/ledger_export_test.mjs`
- `test/ledger_import_chain_test.mjs`
- `test/ledger_import_test.mjs`
- `test/ledger_import_v2_test.mjs`
- `test/ledger_roundtrip_test.mjs`
- `test/ledger_seal_consistency_test.mjs`
- `test/passphrase_modal_test.mjs`
- `test/reauth_logic_test.mjs`
- `test/remote_settings_clear_test.mjs`
- `test/summary_policy_test.mjs`
- `test/utils_test.mjs`

### `process.exit unexpectedly called with "1"` (4)

- `test/i02a_field_token_wasm_test.mjs`
- `test/ledger_engine_test.mjs`
- `test/remote_import_test.mjs`
- `test/storage_plugin_test.mjs`

### `Cannot read properties of undefined (reading 'localEntries')` (1)

- `test/genesis_gate_test.mjs`

### `local chain validation failed: block 1 seal, signature, or entry hash is invalid` (1)

- `test/ledger_merge_test.mjs`

### `ENOENT: no such file or directory, open '/src/components/sync/SyncIndicator.jsx'` (1)

- `test/sync_indicator_test.mjs`

> The `process.exit unexpectedly called with "0"` / `"1"` files are node `--test` style suites
> that terminate the worker at the end — harmless under `node --test`, fatal under vitest.
> `sync_indicator_test.mjs` is a stale import path (`/src/components/sync/SyncIndicator.jsx` no longer exists).

## 🔕 Category 3 — Not vitest suites (51 files, "No test suite found")

node `--test` style `*_test.mjs` files discovered by the second `include` glob but containing no
vitest suite (they use `node:test` globals). These are **not** failures — they run under `node --test`:

- `test/auto_sync_hook_test.mjs`
- `test/ccs2_row_level_reconcile_test.mjs`
- `test/chain_seal_whitelist_test.mjs`
- `test/commit_push_integration_test.mjs`
- `test/committed_flag_integration_test.mjs`
- `test/cross_client_web_test.mjs`
- `test/device_uuid_test.mjs`
- `test/display_status_test.mjs`
- `test/encrypt_entry_fields_dto_test.mjs`
- `test/encrypt_entry_fields_export_test.mjs`
- `test/encrypt_entry_fields_index_test.mjs`
- `test/encrypt_entry_fields_staging_test.mjs`
- `test/encrypt_entry_fields_sync_test.mjs`
- `test/entry_dto_committed_test.mjs`
- `test/hash_index_test.mjs`
- `test/http_backend_test.mjs`
- `test/i01_key_rotation_web_test.mjs`
- `test/i09_device_attribution_test.mjs`
- `test/import_entries_test.mjs`
- `test/ledger_sync_test.mjs`
- `test/local_cache_test.mjs`
- `test/mock_data_seeder_test.mjs`
- `test/mock_remote_test.mjs`
- `test/naming_i04_test.mjs`
- `test/no_fallback_cookie_test.mjs`
- `test/onboarding_cloud_conflict_test.mjs`
- `test/pbkdf2_salt_test.mjs`
- `test/reauth_genesis_mismatch_test.mjs`
- `test/reauth_integration_test.mjs`
- `test/reauth_ttl_test.mjs`
- `test/rekey_service_web_test.mjs`
- `test/remote_config_test.mjs`
- `test/remote_push_committed_test.mjs`
- `test/remote_sync_test.mjs`
- `test/remote_transport_test.mjs`
- `test/row_integration_test.mjs`
- `test/row_staging_store_test.mjs`
- `test/row_sync_test.mjs`
- `test/serialization_unification_test.mjs`
- `test/settings_genesis_test.mjs`
- `test/staging_alignment_integration_test.mjs`
- `test/staging_encryption_test.mjs`
- `test/sync_service_test.mjs`
- `test/sync_test.mjs`
- `test/transport_test.mjs`
- `test/transport_wiring_test.mjs`
- `test/unlock_performance_regression_test.mjs`
- `test/web_ledger_auto_pull_test.mjs`
- `test/worker_connect_blocks_format_test.mjs`
- `test/worker_connect_fullchain_regression_test.mjs`
- `test/worker_connect_onboarding_test.mjs`

## ✅ Category 4 — Pass cleanly (8 files)

| File | pass / fail / skip |
|------|--------------------|
| `test/auth_screen_wipe.test.mjs` | 7 / 0 / 0 |
| `test/encrypt_entry_fields_display.test.mjs` | 9 / 0 / 1 |
| `test/encrypt_entry_fields_ui.test.mjs` | 7 / 0 / 0 |
| `test/import_screen_component.test.mjs` | 27 / 0 / 0 |
| `test/onboarding_import_component.test.mjs` | 21 / 0 / 0 |
| `test/reauth_overlay.test.mjs` | 14 / 0 / 0 |
| `test/rekey_settings_web.test.mjs` | 6 / 0 / 0 |
| `test/settings_genesis_component.test.mjs` | 26 / 0 / 0 |

*(includes the C-2 re-key Settings UI suite `test/rekey_settings_web.test.mjs` — 6/6)*
*(`encrypt_entry_fields_display.test.mjs`'s 1 skip is an intentional `it.skip` — E7 global toggle, not a failure)*

## Recommended Remediation

1. **Remove the second `include` glob** (`**/*_test.?(c|m)[jt]s?(x)`) from `vite.config.js` so vitest
   only runs true vitest suites — eliminates 51 "No test suite found" + ~23 `process.exit` noise files.
2. Fix or move the ~3 genuine load errors (`genesis_gate_test.mjs`, `ledger_merge_test.mjs`, `sync_indicator_test.mjs`).
3. ~~Triage `settings_genesis_component.test.mjs` (25 real failures) as its own 4-phase TDD workstream.~~ **DONE (2026-08-27):** Phase 3 GREEN — `handleSaveRemote` now calls `GenesisGate.check` directly; 26/26 GREEN. Phase 4 REFACTOR DONE (extracted `checkGenesis` helper + latest-request-wins guard; `saved`→boolean `justSaved`).
