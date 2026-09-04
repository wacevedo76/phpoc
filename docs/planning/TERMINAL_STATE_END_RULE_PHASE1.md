# Terminal-State Rule — "ended" Is Permanent (Cross-Client Parity)

**Task:** ADR-033 — port Flutter's terminal-state preference to Web + Python CLI, and document it in PHPSPEC §8.5.
**Status:** ✅ 4-Phase TDD Complete — Phases 1–4 done. Phase 4 (REFACTOR): named the terminal-state branch (`terminalEndWins` / `_terminal_end_winner`) + deduped merged-row construction into `buildMergedRow` (mirrors Python `_build`). All K/L/M/N + regression suites GREEN.
**Reference impl:** `phpoc-flutter/lib/data/sync/merge_engine.dart` `mergeEntries` / `_isEnded`.

## 1. What must change (and why)

Three implementations disagree on staging merge semantics, and the spec is ambiguous:

| Surface | File | Today | Target |
|---|---|---|---|
| Spec | `docs/spec/PHPSPEC.md` §8.5 | pure LWW only | + terminal-state rule |
| Flutter | `merge_engine.dart` | ✅ terminal-state rule | unchanged (reference) |
| Web | `phpoc-web/src/sync/row_sync.js` `mergeRows` | pure LWW | + terminal-state rule |
| Web | `phpoc-web/src/sync/sync.js` `_mergeRemoteIntoLocal` | `remoteWonIds` = `updated_at`-only | recognize terminal-state wins |
| Python | `domain/staging/merge_engine.py` `merge_rows` | pure LWW | + terminal-state rule |

**The rule (ADR-033):** when local and remote share an `activity_id` and exactly one side
is `ended` while the other is `active`/`paused`/unset, the `ended` row wins regardless of
`updated_at`. Every other case keeps LWW on `updated_at` (local wins on tie). The
`committed`-flag irreversibility rule is preserved in all branches.

**Ended detection (Flutter reference `_isEnded`):**
1. `activity_status === 'ended'` → ended.
2. else parse `activity` JSON; `is_active === false` → ended.
3. else (unknown status, no `is_active false`) → not ended.

Web canonical rows always carry `activity_status` (normalized to `'active'` default), so
the JSON fallback is a safety net only.

## 2. Test matrix (Phase 2 RED targets)

### Group K — Web `mergeRows` terminal-state (pure)  ·  `phpoc-web/test/terminal_state_merge_test.mjs`

Mirror of Flutter Group K + K-INT (with Web `mergeRows` signature `(local, remote)`):

- **K1** local `active` + remote `ended` (remote `updated_at` **older**) → `ended`.
- **K2** local `active` + remote `ended` (remote **newer**) → `ended` (LWW guard still ended).
- **K3** local `paused` + remote `ended` (local **newer**) → `ended`.
- **K4** local `ended` + remote `active` (remote **newer**) → `ended` (reverse direction).
- **K5** both `ended` → newest `updated_at` wins (LWW preserved).
- **K6** both `active` → newest `updated_at` wins (LWW preserved).
- **K7** ended winner carries its `end_epoch`/`duration`/blob intact (data survives).
- **K8** unset/empty `activity_status` → treated as not-ended → LWW applies.
- **K-INT1** mixed set: multiple activity_ids resolved independently; `committed:true` preserved; ended-vs-active preference independent per id.

### Group L — Web `_mergeRemoteIntoLocal` DTO-rebuild integration  ·  same file

Guards the `remoteWonIds` rebuild path (the subtle part — a terminal-state win must also
rebuild the DTO from the canonical row, else `is_active: true` leaks back):

- **L1** remote `ended` + local `active` (local **newer**) → merged DTO `is_active:false` / `is_paused:false`.
- **L2** remote `ended` + local `active` (remote **newer**) → `is_active:false` (existing LWW path still works).
- **L3** local `ended` + remote `active` (remote **newer**) → `is_active:false` (local ended survives rebuild).
- **L4** both `active`, remote newer → `is_active:true` (no terminal state; DTO rebuild path unchanged).

### Group M — Python `merge_rows` terminal-state  ·  `tests/test_merge_engine_terminal_state.py`

Mirror of K1–K7 + K-INT1 against `domain/staging/merge_engine.py` `merge_rows` (local,
remote as lists of canonical dicts; `updated_at`/`committed` semantics identical to Web).

- **M1–M7** mirror K1–K7.
- **M-INT1** mirror K-INT1 (multi-id independence + `committed` irreversibility).

### Group N — PHPSPEC §8.5 doc conformance  ·  `tests/test_phpspec_85_terminal_state.py`

Reads `docs/spec/PHPSPEC.md` and asserts the §8.5 wording:

- **N1** §8.5 states `ended` is terminal and wins over `active`/`paused` regardless of `updated_at`.
- **N2** §8.5 preserves LWW for non-terminal cases and local-wins-on-tie.
- **N3** §8.5 states `committed` irreversibility is preserved in all branches.
- **N4** §8.1 `activity_status` enum still lists exactly `active`/`paused`/`ended`.

## 3. Phase 3 (GREEN) implementation plan

1. `row_sync.js`: add `_isEnded(row)` helper + terminal-state branch in `mergeRows` (before
   the `updated_at` comparison; mirror Flutter's `mergeEntries` structure exactly).
2. `sync.js` `_mergeRemoteIntoLocal`: extend `remoteWonIds` so a row is rebuilt-from-canonical
   when either `remote.updated_at > local.updated_at` **or** the terminal-state rule made
   remote win (remote ended vs local non-ended). Add a shared predicate so `mergeRows` and
   the rebuild decision cannot drift.
3. `domain/staging/merge_engine.py` `merge_rows`: add the same `_is_ended` + terminal-state
   branch (pure stdlib, no new deps).
4. `PHPSPEC.md` §8.5: add the terminal-state rule + a short "ended is permanent" rationale.

## 4. Phase 4 (REFACTOR) checklist

- Modularity: one shared `_isEnded`/terminal-state predicate per client (not duplicated inline).
- Clarity: name the terminal-state branch explicitly (e.g. `terminalEndWins`).
- Security: no new crypto surface; no secrets; merge stays a pure function.
- Conciseness: no dead branches; keep the JSON-blob `is_active` fallback minimal.
- Tests stay GREEN (K/L/M/N + existing row_sync/cross_client/ccs2/sync_service suites).

## 5. Notes / out of scope

- `buildDiff` (`row_sync.js`) is dead production code (only `mergeRows` is wired into
  `SyncService`); it is NOT changed here, but should adopt the same rule if ever re-wired.
- No `format_version` or schema change (D9). The rule only changes merge *outcomes*.
- Flutter already implements the rule — no Flutter change (reference only).
