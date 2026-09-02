# Commonplace Book Settings — Web Port (Slice 4) — Test Exploration (Phase 1)

> **Plan:** `docs/planning/COMMONPLACE_BOOK_WEB_ROADMAP.md` (Slice 4 — Settings surface)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Mirror (Flutter reference):** `docs/planning/flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46 assertions, groups S/W/P/T/V/SP/R/B/C/X) — this blueprint ports those assertions to `phpoc-web` with web-appropriate deltas.
> **Status:** ✅ Phases 1–4 complete (2026-08-31) — 34 assertion IDs / 44 test cases GREEN across 4 files (`commonplace_settings_swap_web.test.mjs` S1–S6, `commonplace_settings_screen_web.test.mjs` W/P/V/B4/C/X/R8, `commonplace_settings_service_test.mjs` B1–B3, `commonplace_settings_rekey_test.mjs` R1–R7).
> **Phase 4 (REFACTOR):** extracted shared `useRekeyFlow` hook (`src/hooks/useRekeyFlow.js`) + `RekeyModal` presentational component (`src/components/modals/RekeyModal.jsx`) — deduped the re-key modal/state duplicated across ledger `Settings.jsx` and `CommonplaceSettingsScreen.jsx` — and unified `_rebuildBlocks`/`_rebuildCommonplaceBlocks` into one `_rebuildChain` engine in `rekey_service.js` (`chainKind` selects genesis shape + identity-seal algorithm).

## Scope Boundary

- **In scope:** a Commonplace-mode Settings surface reachable while the Commonplace book is active —
  shared Worker URL + API token, Verify Commonplace, Push Commonplace (stub), Commonplace
  backup/restore, Clear All Data (both books), and the re-key extension that re-encrypts
  `commonplace:blocks` in lockstep with the ledger. This is the web fix for the **over-swap bug**
  (Slice 3's `BookBody` replaces the *entire* ledger screen with `CommonplaceScreen` when the book is
  `commonplace`, so Settings — and every other tab — is unreachable in Commonplace mode).
- **Out of scope (web deltas / deferred):** per-book theme (web has **no theme system** at all),
  Change Passphrase / Export Recovery Seed / fingerprint (none of these exist on web yet), ledger
  Settings clear-all parity (web's ledger `Settings.jsx` has no Clear-All today). These are flagged
  in the Notes/Open Items section for explicit sign-off.

## Architecture Overview

### Flutter → Web concept mapping

| Flutter | Web (`phpoc-web`) |
|---------|-------------------|
| `AppScaffold` body swap by book | `App.jsx` `currentScreen` state + `BookBody` content-swap |
| go_router `/settings` route | `currentScreen === 'settings'` (state-based, not URL-based) |
| `AppPreferences.get/setWorkerUrl` | `localStorage['phpoc_worker_url']` |
| `SecurePreferences.get/setApiKey` | `localStorage['phpoc_api_key']` |
| `commonplaceServiceProvider` | `DevModeContext.services.commonplaceService` (prop-injected) |
| `RekeyService` (`rekey_service.dart`) | `services/rekey_service.js` (ledger-only today) |
| `OnboardingService.clearAllData()` | `DevModeContext.wipeLedger()` (already `storage.clear()` → both books) |
| `FilePicker` save/pick | browser Blob download + `<input type="file">` |
| `ThemeVariant` / `commonplaceThemeProvider` | **N/A — deferred** (no web theme system) |

### The over-swap bug (what Slice 4 fixes)

`App.jsx` renders `<BookBody ledgerScreen={renderScreen()} commonplaceService={…} />`. `BookBody`
returns `<CommonplaceScreen/>` whenever `book.key === 'commonplace'`, discarding `ledgerScreen` for
**every** `currentScreen` value (dashboard, history, tags, sync, profile, settings, import). The fix
scopes the swap: only `dashboard` → `CommonplaceScreen` (Slice 3 behavior preserved) and `settings`
→ a new `CommonplaceSettingsScreen`; all other screens pass through their ledger rendering
unchanged (they are ledger-specific surfaces).

### New / changed modules

- **`src/components/screens/CommonplaceSettingsScreen.jsx`** (NEW) — the Commonplace-mode Settings
  surface. Shares the Worker URL + API token (localStorage), and adds Verify Commonplace, Push
  Commonplace (stub), Backup/Restore Commonplace, Re-key, and Clear All Data.
- **`src/components/layout/BookBody.jsx`** (CHANGED) — receives `currentScreen` and routes
  `settings` → `CommonplaceSettingsScreen` (and `dashboard` → `CommonplaceScreen`) in Commonplace
  mode; other screens render the ledger node.
- **`src/commonplace/commonplace_service.js`** (CHANGED) — adds `exportForBackup()` /
  `restoreFromBackup(json)` (wrapping `CommonplaceStorage`).
- **`src/services/rekey_service.js`** (CHANGED) — `rekey()` re-encrypts `commonplace:blocks` in
  lockstep (additive second payload; ledger path byte-identical).

### Commonplace chain facts the re-key path must honor (CPS-R)

- Live chain lives under `commonplace:blocks` (same `StorageBackend`, same MK).
- Genesis is **flattened**: top-level `recovery_seed_enc`, `identity_secret_enc_fallback`,
  `identity_pub_key`, plaintext `username`/`email`. Hash key = `block_hash`; seal =
  `commonplace_genesis` whitelist.
- Day blocks: entries are `{hash, data}` where `data` holds `title_enc`/`entry_enc`/`tags_enc`/
  `ad_hoc_enc` + plaintext `type`/`timestamp_ms`/`date`/`content_hash`. Hash key = `day_hash`; seal
  = `commonplace` whitelist.
- `entry.hash` = `computeEntryHash(data)` (ciphertext-bound → recompute on re-encrypt).
  `content_hash` = `computeContentHash(data, crypto, mk)` (plaintext-bound → **preserved** across
  re-key; ADR-026 rotation-safe).
- Identity seal (`identity_seal`) is key-independent (device-scoped identity secret) → re-sign only.

## Test Groups

### Group S: Settings routing / book-scoped content swap — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-S1 | With `Book.ledger` active, `currentScreen='settings'` renders the ledger `Settings` | Ledger book reaches its own settings | Regression guard: the swap must be book-scoped, not route-scoped. |
| CPS-S2 | With `Book.commonplace` active, `currentScreen='settings'` renders `CommonplaceSettingsScreen` (not `CommonplaceScreen`) | Commonplace book reaches ITS settings page | The core fix: today `BookBody` swaps every screen to `CommonplaceScreen`, so Settings is unreachable in Commonplace mode. |
| CPS-S3 | With `Book.commonplace` active on settings, the bottom-nav Settings tab is highlighted (index 5 of 6) | Bottom-nav active-tab stays correct | Ensures the active-tab lookup still maps to the settings surface after the swap. |
| CPS-S4 | Switching book commonplace → ledger while on settings renders the ledger `Settings` | Book switch re-resolves the settings surface | Navigating on Settings re-renders correctly after a book change. |
| CPS-S5 | In Commonplace mode, `dashboard` still renders `CommonplaceScreen`; `history`/`tags`/`sync` still render their ledger screens | Only settings + dashboard swap | Prevents scope creep: only these two surfaces are book-scoped; ledger-only screens are untouched. |
| CPS-S6 | The ledger `Settings` is unchanged when the ledger book is active (no Commonplace content leaks in) | Isolation between the two settings surfaces | Guards against cross-contamination sharing state backs. |

### Group W: Worker config (shared localStorage) — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-W1 | `CommonplaceSettingsScreen` shows the Worker URL from `localStorage['phpoc_worker_url']` | Read path uses the SAME stored URL as the ledger | "R2 URL + API Token are shared with the Ledger" → no duplicate storage. |
| CPS-W2 | Saving the Worker URL in Commonplace settings writes `localStorage['phpoc_worker_url']` | Write path persists to the shared key | Change in one book must reflect in the other. |
| CPS-W3 | Saving the API Token in Commonplace settings writes `localStorage['phpoc_api_key']` | Shared API-token mutation | Same single-source behavior for the token. |
| CPS-W4 | After saving the Worker URL in Commonplace settings, the ledger `Settings` (same localStorage) shows the new URL | Cross-surface visibility of a shared change | Proves the two surfaces read one source of truth. |

*Web delta:* no `SecurePreferences` — localStorage is the single source. The ledger Settings'
genesis-check-on-save is its own concern; the Commonplace surface only needs to persist the shared
keys (validation still rejects an invalid URL).

### Group P: Push Commonplace to Cloud (stub) — 2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-P1 | The Commonplace settings shows a "Push Commonplace to Cloud" affordance | Feature is discoverable | User wants the item present while remote Commonplace storage is stubbed. |
| CPS-P2 | Tapping "Push Commonplace to Cloud" shows a "not implemented / coming soon" message and performs no network push | Stub is safe and honest | No backend path exists yet; must not claim success or attempt R2 writes. |

### Group T: Per-book theme — 0 tests (DEFERRED — web delta)
The web app has **no theme system** (no `theme` references anywhere in `phpoc-web/src`). Porting the
Flutter per-book theme (6 assertions) would require introducing a full theme layer — an orthogonal
change far beyond the Commonplace Settings surface. Deferred to a dedicated slice; see Notes.

### Group V: Verify Commonplace — 3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-V1 | The Commonplace settings shows "Verify Commonplace" (not "Verify Ledger") | Correct labeling | Mirrors ledger parity but for the Commonplace chain. |
| CPS-V2 | Tapping "Verify Commonplace" calls `commonplaceService.verify()` | Correct target | Verifies the Commonplace chain, not the ledger. |
| CPS-V3 | A valid chain shows a positive result; an invalid chain shows a failure; an empty chain shows an empty-state message | Result feedback | Integrity feedback mirrors the Flutter UX (valid/invalid/empty). |

### Group SP: Shared security features — 0 tests (DEFERRED — web delta)
Web has no Change Passphrase, Export Recovery Seed, or fingerprint/biometric features. The web
"shared security" surface is: re-key (Group R), Clear All Data (Group C), and Logout (app-wide in
`AppLayout`, unchanged). Deferred until those features exist on web.

### Group R: Re-key extends `RekeyService` to re-encrypt `commonplace:blocks` — 8 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-R1 | After a re-key, Commonplace entries decrypt under the NEW MK | Commonplace survives key rotation | Without this, re-key makes `commonplace:blocks` undecryptable (one seed → one MK → both books). |
| CPS-R2 | The Commonplace chain still verifies after re-key (seals re-derived under new MK) | Integrity preserved post-re-key | `block_hash`/`day_hash` recomputed via the ADR-029a whitelist, like the ledger's. |
| CPS-R3 | Re-key re-encrypts `*_enc` fields and recomputes the ciphertext-bound entry `hash`, while preserving plaintext fields and the plaintext-bound `content_hash` | Field-level preservation (Flutter R9 parity) | Mirrors the ledger `_rebuildBlocks`: only `_enc` fields re-encrypt; `content_hash` is rotation-safe and unchanged. |
| CPS-R4 | The ledger re-key path is unchanged (blocks + passphrase tokens + device cookie still re-keyed) | No regression to the ledger re-key | Re-key stays atomic for the ledger; Commonplace is an additive second payload. |
| CPS-R5 | Re-key re-encrypts the Commonplace genesis `recovery_seed_enc` + `identity_secret_enc_fallback` under the new key set | Genesis parity | Keeps the flattened Commonplace genesis consistent with the new root. |
| CPS-R6 | A failed Commonplace re-encrypt aborts before any write (no partial re-key across the two chains) | Atomicity | Build both chains in memory first, then write (D4). |
| CPS-R7 | The `RekeyResult` surfaces how many Commonplace blocks/entries were re-encrypted | User feedback | Extends the existing result to account for the second chain. |
| CPS-R8 | The re-key action is reachable from Commonplace settings with the same two-secret gate (old passphrase + new-seed confirm) | Shared re-key UX | Re-key is shared; the same gate applies from either book. |

### Group B: Backup / Restore Commonplace — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-B1 | `commonplaceService.exportForBackup()` returns the sealed `commonplace.json` content as a string | Export the Commonplace chain | Symmetric with ledger export but for the Commonplace book. |
| CPS-B2 | The exported Commonplace backup is a valid `{type:'commonplace_chain', genesis, blocks}` object that round-trips | Exported format integrity | The file must re-import cleanly (matches `CommonplaceStorage` shape). |
| CPS-B3 | `commonplaceService.restoreFromBackup(json)` replaces the Commonplace chain from a backup string | Import the Commonplace chain | Symmetric with ledger restore. |
| CPS-B4 | Restore Commonplace is guarded by a confirm dialog (destructive replacement) | Accidental-loss protection | Mirrors the ledger restore confirm UX. |

### Group C: Clear All Data (both books) — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-C1 | `wipeLedger()` clears both `ledger:blocks` and `commonplace:blocks` (plus worker creds) | Clear wipes BOTH books | Web's wipe already does `storage.clear()` on the shared backend — a regression guard, not new behavior. |
| CPS-C2 | The Commonplace settings shows "Clear All Data" with a confirm dialog + danger styling | Safety preserved | Destructive action must keep its guardrails. |
| CPS-C3 | Confirming Clear All Data wipes both books and returns to the landing phase; both surfaces show empty/initialized afterward | Post-clear consistency | No orphaned chain data in either book. |
| CPS-C4 | Clear All Data is idempotent/safe when no Commonplace chain exists | First-run robustness | Must not crash when `commonplace:blocks` is absent. |

### Group X: Exclusions — 3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-X1 | Commonplace settings does NOT render "Import Ledger", "Import entries from another ledger", or "Migrate Encryption" | Omitted features are absent | Ledger import/migration are ledger-only (and slated for removal). |
| CPS-X2 | Commonplace settings does NOT render a second/duplicate "Worker / API Key" registration section | No duplicate credential entry | The R2 URL + API token are configured once, shared. |
| CPS-X3 | No secrets/URLs are duplicated as hardcoded values in Commonplace settings (all sourced from localStorage/shared providers) | Single source of truth | Enforces the shared-state design and the "No secrets in repo" contract. |

## Summary

- **Total assertions:** 34
- **By group:** S=6, W=4, P=2, T=0 (deferred), V=3, SP=0 (deferred), R=8, B=4, C=4, X=3
- **Key coverage areas:** shell routing/redirect for the Commonplace settings surface (S); shared
  Worker URL/API-token state (W); Push stub (P); Verify Commonplace (V); **re-key extending
  `RekeyService` to re-encrypt `commonplace:blocks`** (R); Commonplace backup/restore (B);
  clear-all-both-books (C); exclusions (X).

## Notes / Open Items

- **Deferred (require sign-off before Phase 2):**
  - **Group T — per-book theme (6 Flutter assertions):** web has no theme system; deferred to a
    dedicated theme slice rather than bolting a theme layer onto this settings work.
  - **Group SP — shared security (4 Flutter assertions):** Change Passphrase / Export Recovery Seed /
    fingerprint don't exist on web yet; deferred. The web shared-security surface remains re-key (R),
    Clear All Data (C), and app-wide Logout.
- **Re-key scope is the largest cross-cutting change** — it touches `RekeyService` (re-encrypt the
  Commonplace chain + re-seal) and must remain atomic with the ledger re-key (build-then-write). Keep
  the ledger path byte-identical; add the Commonplace payload as an additive step. Note the
  flattened (non-nested) Commonplace genesis vs the ledger's nested `identity:{…}`.
- **Clear All Data** — web `wipeLedger()` already wipes both books via `storage.clear()`; Slice 4 only
  exposes it from the Commonplace Settings with a confirm dialog. The ledger Settings has no Clear-All
  today (out of scope).
- **Push Commonplace to Cloud** is a deliberate stub; remote Commonplace storage (Worker path) is
  future work (Slice 5, tracked in BACKLOG/ROADMAP).
- **Backup/restore** reuses `CommonplaceStorage`; `exportForBackup`/`restoreFromBackup` are new
  `CommonplaceService` methods (the Flutter Settings slice added the same four methods).
