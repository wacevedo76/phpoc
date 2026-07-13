# Session History — 2026-07-13

## Completed Milestones (archived from SESSION_HANDOFF.md)

- **Phase 1–3 complete** — Staging activity_id + hash index. 527/527 staging tests pass.
- **Sync logic design complete** — ADR-025 + ROW_LEVEL_STAGING_SYNC_PLAN.md.
- **Worker protocol redesign — Phases 1–4** — Test exploration → RED → GREEN → REFACTOR. 104/104 tests pass.
- **Web: Row-level staging — Phase 3 (GREEN)** — RowStagingStore, buildDiff, RowSyncWorker, migrateBlobToRows. 254/254 tests pass.
- **CLI: SQLite staging store — Phases 2–4** — 104 tests RED → GREEN → REFACTOR (6 improvements).
- **Verify CLI onboarding from R2/Worker** — R2 cleared, fresh chain pushed with E2ETest/e2e@test.com. Full pipeline works.
- **Verify CLI onboarding (ph init)** — init → login → add start/end → sync → verify. Full cycle passes.
- **Verify web onboarding** — Full flow: new ledger, logout/login, wrong-passphrase, onboarding re-entry, import (File/Cloud), Worker Connect from R2. Zero console errors.
- **Cross-client sync (CLI ↔ Web via R2)** — CLI starts task → R2 → Web sees + stops → commits → CLI pulls stopped task. Chain divergence handled via merge.

## R2 Test Ledger
| Field | Value |
|---|---|
| Username | `E2ETest` |
| Email | `e2e@test.com` |
| Passphrase | `E2EPass123!` |
| Recovery Seed | `fK0kCIjLAzFTmHmE6XaD/Y+YfRyBVQ07dG8DaVRtS+4=` |
| Worker URL | `https://phpoc-staging-testing.wacevedo.workers.dev` |
| API Token | See `TEST_CREDENTIALS.md` (gitignored) |

## Bug Found
- **SyncOrchestrator deduplication**: `"<=" not supported between instances of 'int' and 'NoneType'` on cross-client sync pull. Non-blocking — merge succeeds.
