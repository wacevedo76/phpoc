# C3 — Read-Only "Observe" Mode — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_STAGING_CONVERGENCE_PLAN.md` (C3, protocol change, CLI-first) + `docs/design/STAGING_CHANGE_DETECTION_DESIGN.md` (ADR-034, `staging_hash` canonical spec §4) + `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (binding state machine, invariants I1–I10)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ COMPLETE (all 4 phases) — Phase 4 (REFACTOR) code review done; two fixes in `domain/staging/service.py` + regression test `test_A9_local_write_preserves_last_seen_hash`; Group F spec docs closed (§12.3.1 OBSERVE branch, §12.4 OBSERVE rows, I7 re-worded, PHPSPEC §8.10, `CLI_READONLY_STAGING_SYNC.md` generalized)
> **Next Phase:** — (C3 done; C4 → ADR-034 `staging_hash` + `seq` + CAS cookie migration)

## Architecture Overview

**Problem (live E2E, 2026-09-05/06 + `CLI_READONLY_STAGING_SYNC.md`):** the staging device cookie gates
**both** read and write. `check_and_sync()` treats `REAUTH_NEEDED` (specifier mismatch / TTL expiry) as a
hard stop, so a read-only command (`ph view` / `ph list` / `ph tags`) on a device that does **not** own
the cookie is locked out — it shows nothing (or only local data) instead of converging to remote. Reads
must not require ownership; they only need to see the latest data.

**C3 — the OBSERVE branch.** Add an `OBSERVE` branch to the §12 state machine:

```
observe():
  1. No remote configured? → READY (local-only)                      [G1]
  2. NETWORK: pull remote cookie (~200 B, no decrypt)                 [ADR-034 §5 step 2]
       unreachable → READY (local-only, fail-open)                   [D6]
  3. HASH compare: remote.staging_hash vs local.last_seen_hash
       EQUAL     → no staging change → READY (skip blob pull)
       DIFFERENT → staging changed → continue
       MISSING   → legacy client / first run → treat as "changed"    [D9]
  4. PULL blob + mergeRows into local (NO push, NO cookie claim)     [ADR-034 §5 step 3/4]
  5. set local.last_seen_hash = remote.staging_hash → READY
```

Three binding properties separate OBSERVE from the existing claim path (`RECONCILE AND CLAIM`, §12.3):

1. **No push** — after `mergeRows`, the observer does **not** `push_blob_only` / `_pushStagingRowsToRemote`.
2. **No cookie claim** — the observer never creates, destroys, or pushes a device cookie; the remote
   `device_specifier` stays with whoever wrote it (I1: cookie remains the *sole* auth decision).
3. **No TTL refresh** — observation never bumps the local cookie `creation_time` (ADR-034 I4): a
   forever-reading client still re-authenticates after 30 min.

**Reconcile with I7** ("no network on read-only"): I7 currently means the **fast path** returns `READY`
with *zero* network calls when no writes are pending. OBSERVE deliberately *does* one network call — the
cookie GET — to answer "did remote change?", because the zero-network fast path is what leaves an idle
CLI stale. C3 narrows I7's intent to "read-only is *cheap*, not *network-free*": change detection uses
**`staging_hash`** (ADR-034 §4, canonical plaintext SHA-256) rather than the coarse
`staging/hash_index.json` (Tier-1, ADR-024), which misses content edits (title/tags/times) under an
unchanged `{activity_id, activity_status}`. 99% of reads stop at ~200 B + one round-trip; the 64 KB blob
pull + merge fires only on an actual change (ADR-034 §8).

**Shared pull+merge helper.** C3 requires extracting the pull+merge half of
`StagingService._reconcile_and_claim` (`domain/staging/service.py:897`) into a shared helper
(`_pull_and_merge`, no push / no claim side effects) reused by **both** the claim path (which then pushes
+ claims) and the new OBSERVE path (which stops after merging). This **extends** `CLI_READONLY_STAGING_SYNC.md`
— currently a CLI-only design — into a unified spec-level mode. Note: `_reconcile_and_claim` currently
merges via the legacy `_merge.merge` (entry_id LWW), while the canonical-row reconcile
`_merge_remote_into_local` (`service.py:999`, the CCS-2/CCS-3 port using `merge_rows` / activity_id LWW)
already exists separately. The shared helper converges on **canonical-row `merge_rows`** so observe and
claim share one merge (Resolution 3 — A-C3-2, decided; see B7/B6).

**CLI-first + config-selectable trigger (Resolution 1 — D-C3-1).** Observe is implemented in the CLI first
(`StagingService` + `CLIInterface._sync_before_command`), wiring `view`/`list`/`tags` to the observe path
while `start`/`end`/`log`/`modify`/`delete` stay on the `require_auth=True` claim path. Both trigger models
are supported, selected via a new **`staging.observe_mode`** config key (`ConfigManager.DEFAULTS`, next to
`blob_size_tier`, accessed via `config.get("staging.observe_mode")`):

- **`"auto"`** (default): read commands observe by default (hash-gated pull+merge, no push, no cookie claim).
- **`"manual"`**: read commands keep today's fast path (zero network when no pending writes) unless the user
  passes a new **`--observe`** flag.
- **`--observe`** flag: opt-in override that forces observe regardless of the config value.

Web (`_reconcileDifferentDevice`, `sync.js:924`) and Flutter (`_reconcileAndClaimRowLevel`,
`sync_service.dart:648`) parity ports come **later** — Group E blueprints their eventual test groups but
marks them **parity/future**. Their model is unchanged by the CLI config choice: always-on idle triggers
(focus/visibility/tick), hash-gated (Group E5).

**Injected hash seam (Resolution 2 — R-C3-1).** The change-detection hash is injected via a **seam** — a
`staging_hash_provider` callable (a `get_staging_hash` / `staging_hash_provider` passed into `observe()`),
**not** a hard dependency on ADR-034's canonical `compute_staging_hash`. Phase 3 ships observe with a
**full-pull provider** that always reports "changed" → full blob pull+merge every read (correct but
temporarily ~64 KB/read, forfeiting I7-cheapness until the hash lands). When ADR-034 P0 lands (Python
`compute_staging_hash` + the `comment ""→null` coercion in `dtoToCanonicalRow`), the canonical hash is
swapped in with **no observe-side change**. CLI-first only needs Python's own *self-consistent* hash — not
the ×3 V1–V4 byte-parity. Hash-gated assertions (A1/A7/D4) are written against the injected provider and
remain independent of P0.

## Test Groups

### Group A: OBSERVE state-machine semantics — 8 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | With an injected `staging_hash_provider` returning a hash equal to `local.last_seen_hash`, `observe()` pulls the remote cookie and returns `READY` without pulling the blob | Cheap change detection | ADR-034 §5 step 3 — the hash gates the expensive 64 KB blob pull; asserted against the injected seam, independent of the canonical hash (P0) |
| A2 | `observe()` with `remote.staging_hash != local.last_seen_hash` pulls the blob, `merge_rows` into local, returns `READY` | Converge on actual change | The hash is the change signal; only then is the blob pulled + merged |
| A3 | `observe()` with `staging_hash` absent/unknown (legacy cookie, or `last_seen_hash` unset) treats remote as "changed" → full pull+merge | Backward compat (D9) | An absent hash must never be mistaken for "unchanged" (full pull+merge per ADR-034 §11) |
| A4 | `observe()` never pushes the blob (no `push_blob_only` / no remote write of `staging/blob`) | Observer never claims | Core C3 contract — observe is strictly read-only, the writer keeps authority |
| A5 | `observe()` never creates, destroys, or pushes a device cookie (local specifier + remote cookie bytes unchanged) | No cookie claim | I1: the cookie is the sole auth decision; an observer must not disturb ownership |
| A6 | `observe()` returns `READY` on a specifier mismatch (never `REAUTH_NEEDED`) | Reads don't require ownership | The whole C3 point — `ph view` must not block on another device's cookie |
| A7 | `observe()` records the `staging_hash_provider` hash as `local.last_seen_hash` after a successful merge (and only then) | Baseline for the next compare | Without updating the baseline, every read re-pulls the blob (correctness + cost); asserted against the injected provider |
| A8 | `observe()` never refreshes the local cookie TTL (`creation_time` unchanged) | ADR-034 I4 | Reads never refresh TTL; a forever-observing client must still reauth after 30 min |

### Group B: shared pull+merge helper extraction — 7 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Extracting the pull+merge half of `_reconcile_and_claim` yields a helper `_pull_and_merge(mk, timeout_ms)` returning the merged, uncommitted DTO list | Single reusable reconcile | Observe and claim share one merge path; no duplicated pull/merge/filter logic |
| B2 | The helper aborts (returns a sentinel / `None`) on `BLOB_KEY_MISMATCH` without touching local state | Data-loss guard | I5 / R1 — must NOT overwrite remote on wrong-key decrypt; local stays untouched |
| B3 | The helper surfaces unreachable (returns `OFFLINE`-mappable / raises for the caller) on blob-pull failure | Fail-open plumbing | D6 offline-lenient; the caller maps to `READY` (observe) vs `OFFLINE` (claim) |
| B4 | The helper filters `committed:true` rows before persisting | D11 / R4 | Committed rows moved to the ledger must not re-enter staging (observe + claim both) |
| B5 | The helper has **no push and no cookie side effect** — it only reads remote + writes local | Merge/claim separation | Observe must not push; claim must push *separately* after the helper returns |
| B6 | `_reconcile_and_claim` refactored to call the shared helper still produces a canonical-consistent outcome — committed-exclusion preserved, no data loss on `BLOB_KEY_MISMATCH`, ADR-033 terminal-state preserved, activity_id LWW | Canonical-consistent refactor | Resolution 3: the claim path deliberately converges on the canonical merge (one merge semantics), NOT byte-identical to legacy `_merge.merge` |
| B7 | The shared helper routes through canonical-row `merge_rows` (generalizing `_merge_remote_into_local`), not the legacy `_merge.merge` | One canonical merge | Resolution 3 (decided): activity_id LWW + ADR-033 terminal-state + committed-exclusion + local-wins-on-tie is the one cross-client contract |

### Group C: CLI read-command wiring — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `ph view` on a specifier mismatch (another device owns the cookie) still displays remote rows (observe pulls + merges, no block) | Read commands stop blocking | The original `CLI_READONLY_STAGING_SYNC.md` symptom — locked-out read fixed |
| C2 | `ph list` routes through observe and shows remote-only rows merged into local | List convergence | Same fix, second read command |
| C3 | `ph tags` routes through observe and includes tags from remote rows | Tag convergence | Same fix, third read command |
| C4 | Write commands (`ph start`/`ph end`/`ph log`) still use `_sync_before_command(require_auth=True)` and still block + prompt re-auth on mismatch | Writes unchanged | Ownership stays single-device for writes (observe must not leak into the write path) |
| C5 | A read command on an **unchanged** hash shows local data instantly with no blob pull (1 cookie GET only) | Cheap reads | ADR-034 §8: reads stay fast; local-first render |
| C6 | The read path never prompts for a passphrase (no `ph login` fallback, no re-auth) even on mismatch | Non-interactive observer | Reads are fire-and-forget; consent stays reserved for the claim path |

### Group D: offline/fail-open + I7 no-network — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | A failed observe pull (network down / timeout) degrades to `READY` with local-only data — never an error, never `REAUTH_NEEDED` | D6 offline-lenient | Reads must never hang or hard-fail; stale local > blocked |
| D2 | Observe with an undecryptable remote blob (wrong MK) returns local-only and never overwrites remote | I5 data-loss guard | The observer must not clobber a blob it cannot read |
| D3 | Observe performs **zero** network calls when no remote is configured (`_remote is None`) | G1 local-only | No transport → instant `READY`, mirroring `check_and_sync` |
| D4 | Observe with an injected provider reporting "unchanged" performs exactly **1 cookie GET and 0 blob pulls** (network-call budget asserted) | I7 reconciliation | "No network on read-only" → "cheap read-only": the hash (seam), not the coarse index, gates the pull |
| D5 | After observe, local + remote cookie specifiers are byte-for-byte unchanged (remote cookie file contents unmodified) | No ownership claim | Proves observe is a pure observer — the writer's cookie is untouched |

### Group E: parity ports — Web / Flutter [future] — 5 tests
> **Marked parity/future.** CLI ships first (`service.py` + `interface.py`); these ports come later in the
> C3 sequence (spec → CLI → Web → Flutter → CCS vectors). Blueprinted now so the eventual test groups are
> scoped, but **not** part of the Phase 2 RED for the CLI-first slice.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Web `observe()` extracts the pull+merge half of `_reconcileDifferentDevice` (`sync.js:924`) into a shared `mergeRemoteBlob` with no push/cookie side effect | Web parity | Mirror the CLI helper extraction on the JS claim path |
| E2 | Flutter `observe()` extracts the pull+merge half of `_reconcileAndClaimRowLevel` (`sync_service.dart:648`) (pull → `mergeEntries` → `putRow`, no `_pushStagingRowsToRemote` / `_pushCookie`) | Flutter parity | Mirror the CLI helper extraction on the Dart claim path |
| E3 | All three clients produce identical merged rows for the same local + remote blob under observe (byte-shape parity) | I2/I3 cross-client | The spec-level mode must be byte-identical across CLI/Web/Flutter |
| E4 | All three clients return the same terminal result (`READY` on success / `READY`-local-only on offline) for identical observe inputs | §12.9 matrix | Cross-client outcome parity is the C3 definition of done |
| E5 | Web idle-session observe is wired to the C2 focus/visibility events; Flutter observe replaces/augments the 5 s tick | Idle-session trigger | D-C3-1 depends on how observe is triggered per client (Web event-driven vs Flutter tick) |

### Group F: PHPSPEC / §12 spec-doc coverage — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12.3 gains an OBSERVE branch (pull cookie → `staging_hash` gate → blob+merge → `READY`, no push, no claim) + a §12.4 OBSERVE decision-table row | Binding state machine | C3 is a protocol change; the abstract spec is the code-to contract |
| F2 | §12.8 I7 is re-worded to "read-only is cheap (hash-gated cookie GET), not network-free" — no contradiction with OBSERVE | I7 reconciliation | The current I7 wording ("no network on read-only") is the tension C3 resolves; the spec must record it |
| F3 | `CLI_READONLY_STAGING_SYNC.md` is generalized from "CLI-only read pull" to the spec-level observe mode (OBSERVE branch, `staging_hash` gate, parity-port notes) | Doc promotion | C3 extends this CLI-only plan into the protocol; the doc must reflect the new scope |
| F4 | PHPSPEC §8 documents the `staging_hash` cookie field + observe's no-claim/no-push/no-TTL-refresh semantics | Format spec | The cookie schema (`staging_hash`/`seq`, ADR-034 §3) is wire-format; PHPSPEC owns it |
| F5 | PHPSPEC §12 / §8 documents the observe→claim relationship: observe never authorizes, claim remains the sole ownership path (I1) | Auth invariant | Prevent observe from silently becoming a write/claim path in the spec |

### Group G: config surface — `staging.observe_mode` — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `ConfigManager.DEFAULTS["staging"]` carries `observe_mode: "auto"` (next to `blob_size_tier`) and `config.get("staging.observe_mode")` round-trips to `"auto"` | Default is observe-by-default | Resolution 1: `"auto"` is the default; the key must exist in DEFAULTS + dot-path accessor |
| G2 | With `staging.observe_mode="auto"`, `ph view` / `ph list` / `ph tags` route through observe (hash-gated pull+merge, no push, no claim) without any flag | Observe-by-default | Resolution 1: read commands observe automatically under `"auto"` |
| G3 | With `staging.observe_mode="manual"` and no `--observe`, read commands keep today's fast path (zero network when no pending writes) | Manual opt-out | Resolution 1: `"manual"` preserves the current zero-network fast path unless opted in |
| G4 | With `staging.observe_mode="manual"`, passing `--observe` forces observe (hash-gated pull+merge) regardless of the config value | Flag override | Resolution 1: `--observe` is the opt-in override that wins over `"manual"` |
| G5 | Write commands (`start`/`end`/`log`/`modify`/`delete`) ignore `staging.observe_mode` and `--observe` — always `require_auth=True` | Writes unaffected | Resolution 1: observe never leaks into the write path; ownership stays single-device |

## Summary

- **Total assertions:** 41 (A 8 · B 7 · C 6 · D 5 · E 5 · F 5 · G 5)
- **CLI-first slice (Phase 2 RED now):** Groups A, B, C, D, G (31 assertions) — Python
  `tests/test_staging_observe.py` (or a focused `test_staging_observe_mode.py`) against
  `StagingService.observe()` (with the injected `staging_hash_provider` seam) + the extracted
  `_pull_and_merge` helper + `CLIInterface` read-command dispatch + `ConfigManager`
  `staging.observe_mode` (auto/manual + `--observe`). Group F docs ride along in Phase 3/4.
- **Parity/future (deferred — no RED now):** Group E (5 assertions) — Web/Flutter observe ports,
  blueprinted but not implemented until the CLI reference lands (spec → CLI → parity → vectors).
- **Key coverage areas:** OBSERVE state-machine semantics (A), shared pull+merge helper extraction (B),
  CLI read-command wiring (C), offline/fail-open + I7 cheap-read reconciliation (D), Web/Flutter parity
  ports (E, future), PHPSPEC/§12 spec-doc coverage (F), config surface `staging.observe_mode` (G).

## Resolved Decisions

1. **D-C3-1 (trigger model) — RESOLVED:** support **both** modes via a new config key
   **`staging.observe_mode`** in `ConfigManager.DEFAULTS` (under the existing `staging` section, next to
   `blob_size_tier`), with values **`"auto"`** (default) and **`"manual"`**.
   - **`"auto"`** (default): `ph view` / `ph list` / `ph tags` observe by default (hash-gated pull+merge, no push, no cookie claim).
   - **`"manual"`**: read commands keep today's fast path (zero network when no pending writes) unless the user passes a new **`--observe`** flag.
   - **`--observe`** flag: opt-in override that forces observe regardless of the config value.
   - Write commands (`start`/`end`/`log`/`modify`/`delete`) are unaffected — still `require_auth=True`.
   - Web/Flutter (Group E, future): always-on idle triggers (focus/visibility/tick), hash-gated — the CLI config choice does not change their model.

2. **R-C3-1 (`staging_hash` P0 dependency) — RESOLVED (stepping-stone + injected seam):** observe's
   change-detection hash is injected via a **seam** (`staging_hash_provider` / `get_staging_hash`
   callable), not a hard dependency on the canonical `compute_staging_hash`. Phase 3 ships observe with a
   **full-pull provider** (always "changed" → full blob pull+merge every read; correct but temporarily
   ~64 KB/read, forfeiting I7-cheapness until the hash lands). When ADR-034 P0 lands (Python
   `compute_staging_hash` + the `comment ""→null` coercion in `dtoToCanonicalRow`), swap in the canonical
   hash with **no observe-side change**. CLI-first needs only Python's own *self-consistent* hash — not the
   ×3 V1–V4 byte-parity. Hash-gated assertions (A1/A7/D4) are written against the injected provider and
   remain independent of P0.

3. **A-C3-2 (merge convergence) — RESOLVED (converge on canonical-row merge):** the shared `_pull_and_merge`
   helper routes through canonical-row **`merge_rows`** (generalizing `_merge_remote_into_local`), not the
   legacy `_merge.merge`. `_reconcile_and_claim` is refactored to call the same helper so the codebase has
   exactly ONE merge semantics — the canonical cross-client contract (activity_id LWW, ADR-033
   terminal-state, committed-exclusion, local-wins-on-tie). This is a **deliberate** behavior change to the
   claim path, aligning it with Web/Flutter/§8.5. **B6 is re-scoped** to assert the canonical-consistent
   outcome (committed-exclusion preserved, no data loss on `BLOB_KEY_MISMATCH`, ADR-033 terminal-state
   preserved, activity_id LWW) — **not** byte-identical-to-legacy-`merge`.
