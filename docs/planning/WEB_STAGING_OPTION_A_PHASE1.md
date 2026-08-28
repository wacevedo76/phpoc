# Web Staging "Option A" — Authoritative RowStagingStore (Phase 1 blueprint)

> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P3
> **Predecessor:** `CCS2_PHASE1.md` (Option B adopted; Option A explicitly deferred)
> **Status:** 🔜 Deferred. Not a behavior gap — a known cleanup.

## Purpose

Migrate `phpoc-web` `SyncService` runtime storage from the `LocalCache`-centric model (Option B) to
`RowStagingStore` as the **authoritative** CRUD/store, retiring the `LocalCache` `entries` array as the
source of truth. CCS-2 Option B already threads canonical-row (`activity_id` LWW) semantics through the
sync gate via a reconcile layer; Option A moves the storage itself.

## Why now (vs. why deferred)

- Deferred in CCS-2 because `sync.js` calls 11 CRUD paths through `LocalCache` (`capture/end/pause/modify/
  remove/readEntries` + DTO boundary) — a large, high-risk refactor for no immediate behavior change.
- Motivations: remove the double bookkeeping (reconcile output written back through the `LocalCache` DTO
  boundary), and make `RowStagingStore` / `mergeRows` / `buildDiff` — already GREEN but unreferenced by any
  source module — the actual runtime store.

## Scope

1. Re-route `capture/end/pause/modify/remove` CRUD through `RowStagingStore`.
2. Deprecate the `LocalCache` monolithic `entries` array as authoritative; keep the DTO API shape stable
   (`readEntries()` boundary preserved for the sync/display layers).
3. Wire `mergeRows` / `buildDiff` into the sync gate as the runtime merge/diff, dropping the
   `LocalCache`-centric reconcile output path.
4. Preserve the committed-exclusion, canonical-row LWW local-wins-on-tie, and Scenario-5/6 drop semantics
   already proven in CCS-2 / ADR-030.

## Risks & invariants

- Must not regress the 41/41 CCS-2 suite, the 17/17 ADR-030 suite, or the import/export DTO round-trips.
- `RowStagingStore`/`migrateBlobToRows` must remain compatible with the existing canonical `staging/blob`
  + `staging/hash_index.json` wire format (no format change).

## Acceptance criteria

1. All CRUD reads/writes resolve against `RowStagingStore`; `LocalCache` `entries` array is no longer the
   source of truth.
2. Full web suite GREEN (CCS-2 41/41, ADR-030 17/17, import/export round-trips, staging encryption) with no
   behavior change.
3. 4-phase TDD: Phase 1 blueprint (this doc) → RED tests → GREEN implementation → REFACTOR.

## Out of scope

- Changing the wire format or Worker contract (no format change).
- Commonplace staging (tracked in `COMMONPLACE_BOOK_WEB_ROADMAP.md`).
