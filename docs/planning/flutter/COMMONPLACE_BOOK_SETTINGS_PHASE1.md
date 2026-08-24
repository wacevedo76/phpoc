# Commonplace Book Settings — Test Exploration (Phase 1)
> **Plan:** follow-on to the Commonplace Book UI wiring slice (`COMMONPLACE_BOOK_UI_PHASE1.md`) and ADR-031.
> **Purpose:** The PH Commonplace Book needs its own Settings surface reachable from the Settings tab while the Commonplace book is active, replicating almost all ledger-settings features — **except** that the R2 URL + API Token are shared with the Ledger (stored once, edited from either book), the Commonplace book holds its **own** theme, "Verify Ledger" becomes "Verify Commonplace", Push becomes "Push Commonplace" (stub), re-key re-encrypts **both** books, and "Clear All Data" clears **both** books.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

The Ledger Settings (`lib/features/settings/settings_screen.dart`) is a large `ConsumerStatefulWidget` offering: Remote Sync (Worker URL + API Key + Push Ledger to Cloud), Appearance (theme), Security (Verify Ledger, biometric, change passphrase, export seed, re-key, backup/restore, clear all), Data/Storage (import entries, migrate encryption), Session (lock), and About.

The Commonplace settings surface will be a **new screen** (`lib/features/commonplace/commonplace_settings_screen.dart`) that the shell routes the Settings tab to **when `Book.commonplace` is active** — mirroring how `AppScaffold` swaps the dashboard body for `CommonplaceScreen` (currently it over-swaps: it replaces the body for **every** route including `/settings`, so the Settings page is unreachable in Commonplace mode — the bug this slice fixes).

Feature mapping (per user decision):
- **Remote Sync → Worker** — present but **shared state**: reads/writes the same `AppPreferences.getWorkerUrl()`/`setWorkerUrl()` and `SecurePreferences.getApiKey()`/`setApiKey()` as the Ledger. Editing in one updates the other.
- **Remote Sync → Push Commonplace to Cloud** — present as **a stub**: the UI affordance exists but is not yet wired to real remote storage (the Worker path for the Commonplace book does not exist yet). Show a clear "not implemented" message/snackbar.
- **Appearance → Theme** — present, **holds its own value**: a second persisted key `commonplace_theme_mode` alongside `theme_mode`. While the Commonplace book is active, the app renders the Commonplace theme.
- **Security → Verify Commonplace** — verifies the Commonplace chain (`commonplaceService.verify()`) instead of the Ledger.
- **Security → Unlock with fingerprint** — present; app-wide (unchanged).
- **Security → Change Passphrase** — present; shared MK (unchanged behavior).
- **Security → Export Recovery Seed** — present; shared seed.
- **Security → Re-key to new Recovery Seed** — present; **extends `RekeyService` to re-encrypt `commonplace.json`** under the new MK so the Commonplace chain stays decryptable after re-key.
- **Security → Backup/Restore** — present for `commonplace.json`.
- **Session → Lock/Log Out** — present; app-wide.
- **Data/Storage → Clear All Data** — present in BOTH settings pages; extends `OnboardingService.clearAllData()` to also reset the Commonplace chain (the Ledger version currently only clears the Ledger DB — `index_entries`, `entries`, `blocks` — and leaves `commonplace.json` intact).
- **Omitted** — Import entries / Migrate Encryption (legacy ledger-migration feature slated for removal).

## Test Groups

### Group S: Settings routing / redirect in the shell — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-S1 | With `Book.ledger` active, the `/settings` route renders the Ledger `SettingsScreen` | Ledger book reaches its own settings | Regression guard: the swap must be book-scoped, not route-scoped. |
| CPS-S2 | With `Book.commonplace` active, the `/settings` route renders the Commonplace settings screen | Commonplace book reaches ITS settings page | The core redirect fix: currently the body is swapped to `CommonplaceScreen` on every route, so Settings is unreachable in Commonplace mode. |
| CPS-S3 | With `Book.commonplace` active, the Settings tab in the bottom nav is selected (index 3) | Bottom-nav tab highlight stays correct in Commonplace mode | Ensures the active-tab lookup still maps to the Settings route. |
| CPS-S4 | Switching book from commonplace → ledger on the `/settings` route swaps to the Ledger `SettingsScreen` | Book switch re-resolves the settings page | Ensures navigating while on Settings re-renders the correct surface after a book change. |
| CPS-S5 | The non-Settings routes in Commonplace mode still render `CommonplaceScreen` (Dashboard/History/Sync behavior preserved) | Only the Settings route redirects differently | Prevents scope creep: Dashboard/History/Sync keep the existing content-swap behavior; only Settings gets its own page. |
| CPS-S6 | The Ledger `SettingsScreen` is unchanged when the Ledger book is active (no Commonplace content leaks in) | Isolation between the two settings surfaces | Guards against cross-contamination when both settings pages share state backs. |

### Group W: Worker config (shared state) — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-W1 | The Commonplace settings shows the Worker URL from the shared store | Read path uses the SAME stored URL as the Ledger | "R2 URL + API Token are shared with the Ledger" → no duplicate storage. |
| CPS-W2 | Editing + saving the Worker URL in Commonplace settings updates the shared store | Write path persists to the shared key | Change in one book must reflect in the other. |
| CPS-W3 | After saving Worker URL in Commonplace settings, the Ledger `SettingsScreen` (same prefs) shows the new URL | Cross-book visibility of a shared change | Proves the two surfaces read one source of truth. |
| CPS-W4 | Editing + saving the API Token in Commonplace settings updates the shared `SecurePreferences` | Shared API token mutation | Same single-source behavior for the token. |
| CPS-W5 | The connected/worker status indicator reflects `SyncService.isRemoteAvailable` in Commonplace settings | Shared connect state | Uses the same transport/connection wiring as the Ledger. |

### Group P: Push Commonplace to Cloud (stub) — ~2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-P1 | The Commonplace settings shows a "Push Commonplace to Cloud" affordance | Feature is discoverable | User wants the item present while remote Commonplace storage is stubbed. |
| CPS-P2 | Tapping "Push Commonplace to Cloud" shows a "not implemented / coming soon" message and performs no network push | Stub is safe and honest | No backend path exists yet; must not claim success or attempt R2 writes. |

### Group T: Per-book theme — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-T1 | `AppPreferences` persists a separate `commonplace_theme_mode` from `theme_mode` | Independent storage keys | "holds its own setting (theme)". |
| CPS-T2 | Selecting a theme in Commonplace settings persists to `commonplace_theme_mode` (not `theme_mode`) | Correct write target | Must not clobber the Ledger theme. |
| CPS-T3 | The Ledger `theme_mode` is unaffected when the Commonplace theme changes | Non-interference | One book's theme does not change the other's stored value. |
| CPS-T4 | While `Book.commonplace` is active, the app renders the Commonplace theme | Theme switches with the book | The rendered `ThemeData` reflects the active book. |
| CPS-T5 | While `Book.ledger` is active, the app renders the Ledger theme | Theme switches back on book change | Symmetric behavior when switching books. |
| CPS-T6 | A default exists for the Commonplace theme when none is set (falls back to the Ledger theme or a sane default) | First-run robustness | Avoids a broken/blank theme before first selection. |

### Group V: Verify Commonplace — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-V1 | The Commonplace settings shows "Verify Commonplace" (not "Verify Ledger") | Correct labeling | Mirrors the Ledger parity but for the Commonplace chain. |
| CPS-V2 | Tapping "Verify Commonplace" calls `commonplaceService.verify()` | Correct target | Verifies the Commonplace chain, not the Ledger. |
| CPS-V3 | A valid Commonplace chain shows a "verified"/positive result; an invalid one shows a failure | Result feedback | Confirms integrity feedback mirrors the Ledger UX. |

### Group SP: Shared security features present — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-SP1 | Change Passphrase, Export Recovery Seed, fingerprint toggle, and Lock/Log Out all render in Commonplace settings | Parity of shared app-wide/security features | These are shared-root features that must be reachable from both books. |
| CPS-SP2 | Change Passphrase delegates to `AuthService.changePassphrase` | Shared MK mutation | Same passphrase protects both books. |
| CPS-SP3 | Export Recovery Seed delegates to `AuthService.exportSeed` and gates on passphrase | Shared seed export | Same recovery root for both books. |
| CPS-SP4 | Lock/Log Out returns the app to the auth/unlock phase app-wide | Shared session lifecycle | One session, locked from either book. |

### Group R: Re-key extends RekeyService to re-encrypt `commonplace.json` — ~8 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-R1 | After a re-key, the Commonplace chain's entries decrypt under the NEW MK | Commonplace survives key rotation | Without this, re-key makes `commonplace.json` undecryptable (one seed → one MK → both books). |
| CPS-R2 | The Commonplace chain still verifies after re-key (seals re-derived under new MK) | Integrity preserved post-re-key | Commonplace seal digests recomputed like the Ledger's. |
| CPS-R3 | Non-encrypted (already-decoded) fields on Commonplace entries are untouched by re-key | Field-level preservation (R9 parity) | Mirrors `_reencryptEntryMap`: only `_enc` fields re-encrypt, content hashes preserved. |
| CPS-R4 | The ledger re-key path is unchanged in behavior (blocks + vault + device cookie still re-keyed) | No regression to the ledger re-key | Re-key remains atomic for the Ledger; Commonplace is an additive second payload. |
| CPS-R5 | Re-key re-encrypts the Commonplace genesis `recovery_seed_enc` (if populated) under the new key set | Genesis parity | Keeps the Commonplace genesis consistent with the new root. |
| CPS-R6 | A failed Commonplace re-encrypt aborts before any write (no partial re-key across the two chains) | Atomicity | Mirrors B2: build everything in memory first, then write. |
| CPS-R7 | The RekeyResult surfaces how many Commonplace blocks/entries were re-encrypted | User feedback | Extends the existing result to account for the second chain. |
| CPS-R8 | The Re-key dialog is reachable from Commonplace settings with the same two-secret gate | Shared re-key UX | Re-key is shared; the same confirm/gate flows apply from either book. |

### Group B: Backup / Restore Commonplace — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-B1 | "Backup Commonplace" exports the sealed `commonplace.json` content to a file | Export the Commonplace chain | Symmetric with Ledger backup but for the Commonplace book. |
| CPS-B2 | The exported Commonplace backup is a valid `commonplace.json` object with `type` + `blocks` | Exported format integrity | The file must re-import cleanly (matches `CommonplaceStorage.save()` shape). |
| CPS-B3 | "Restore Commonplace" replaces the Commonplace chain from a backup file | Import the Commonplace chain | Symmetric with Ledger restore. |
| CPS-B4 | Restore Commonplace is guarded by a confirm dialog (destructive replacement) | Accidental-loss protection | Mirrors the Ledger restore confirm UX. |

### Group C: Clear All Data (both books, reachable from both) — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-C1 | `OnboardingService.clearAllData()` also resets the Commonplace chain (not just the Ledger DB) | Clear wipes BOTH books | User decision: "will clear all data, commonplace and ledger". |
| CPS-C2 | The Ledger `SettingsScreen` "Clear All Data" now also clears `commonplace.json` (replicated change) | Parity on the Ledger side | The ledger's clear feature must invoke the same widened logic. |
| CPS-C3 | The Commonplace settings "Clear All Data" also clears the Ledger DB | Symmetry both directions | Whichever book's settings you use, everything is cleared. |
| CPS-C4 | Clear All Data keeps the confirm dialog + danger styling | Safety preserved | Destructive action must not lose its guardrails. |
| CPS-C5 | After Clear All Data, both the Ledger and Commonplace surfaces show an empty/initialized state | Post-clear consistency | No orphaned chain data in either book. |

### Group X: Exclusions — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPS-X1 | Commonplace settings does NOT render "Import entries" or "Migrate Encryption" | Omitted features are absent | Legacy ledger-migration features slated for removal. |
| CPS-X2 | Commonplace settings does NOT render a second/duplicate "Worker/API Key" registration section (shares, not duplicates) | No duplicate credential entry | The R2 URL + API token must be configured once, shared. |
| CPS-X3 | No secrets/URLs are duplicated as hardcoded values in Commonplace settings (all sourced from shared providers) | Single source of truth | Enforces the shared-state design and the "No secrets in repo" contract. |

## Summary

- **Total assertions:** 46
- **By group:** S=6, W=5, P=2, T=6, V=3, SP=4, R=8, B=4, C=5, X=3
- **Key coverage areas:** shell routing/redirect for the Commonplace settings surface (S); shared Worker URL/API-token state (W); Push stub (P); per-book theme storage + switching (T); Verify Commonplace (V); shared security parity (SP); **re-key extending `RekeyService` to re-encrypt `commonplace.json`** (R); Commonplace backup/restore (B); clear-all-both-books (C); exclusions (X).

## Notes / Open Items
- **Re-key scope is the largest cross-cutting change** — it touches `RekeyService` (re-encrypt Commonplace chain + re-seal) and must remain atomic with the Ledger re-key (build-then-write). Keep the Ledger path byte-identical; add the Commonplace payload as an additive step.
- **Clear All Data** touches `OnboardingService.clearAllData()` — the widened wipe must be idempotent (safe if `commonplace.json` is absent).
- **Push Commonplace to Cloud** is a deliberate stub; remote Commonplace storage (Worker path) is future work tracked in BACKLOG/ROADMAP.
- **Theme switching** requires `themeProvider`/`ThemeNotifier` (or a resolver) to be book-aware — reading `commonplace_theme_mode` when `Book.commonplace` is active.
