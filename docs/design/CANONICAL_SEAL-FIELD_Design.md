# Canonical Block-Seal Field Design (Cross-Client Convergence)

> **Type:** Design document (ADR-029 adopted)
> **Status:** ✅ Adopted — Choice 3 (closed 6-field whitelist incl. `original_hash`)
> **Owners:** Python CLI reference, phpoc-web, phpoc-flutter, format-migration tool
> **Scope:** Define the ONE canonical set of fields sealed by an HMAC-SHA256 block seal
> across all four implementations, resolving the cross-client divergence that broke
> on-device verification of a migrated 0.4.0 ledger.

---

## 1. TL;DR

The migrated 0.4.0 ledger (`2303-2026-08-08-Ledger-after-4-migration.json`, 129 blocks,
270 entries) **verifies under Python** (`chain.verify()` → True) but **fails to verify
on the phone's phpoc-flutter build** (0/129 block seals). Root cause: the four
implementations seal over **different field sets**, and the Phase 4 refactor narrowed
Flutter's seal verification to a fixed 5-field whitelist that excludes the migration's
`original_hash` provenance field.

The single differing field is **`original_hash`** (provenance written by migration).
Resolution requires converging all four implementations onto one canonical contract.
This document enumerates the measured divergence and the four candidate canonical sets.

---

## 2. Context & Motivating Incident

### 2.1 What happened
1. `ph migrate-format` re-hashed an already-0.4.0 ledger into canonical `jsonSort()`
   form (270/270 content hashes) and re-sealed all 129 blocks.
2. Python's `chain.verify()` confirmed the migrated file is fully valid.
3. Flutter onboarded the file, but `LedgerChain.verify()` returned `false`.
4. Diagnosis isolated the failure to **block seals** — content hashes and entry hashes
   both verify (270/270), but block seals verify **0/129** under Flutter's Phase-4
   `_sealFields` convention.

### 2.2 The Phase-4 regression
Pre-refactor Flutter (`12a988b`) sealed over **all fields except `{hashKey, identity_seal}`**
— matching Python/Web. Phase 4 (`a5b124e`, "Improvement #3: Conciseness — class-level
`_sealFields` constant") narrowed verification to a closed 5-field whitelist:

```dart
static const _sealFields = ['type', 'day_index', 'date', 'prev_hash', 'entries'];
```

The refactor's docstring called this the "Canonical PHPSPEC seal fields shared across
all block types." However, **PHPSPEC does not define a 5-field whitelist** — it defines a
seal as *"an HMAC-SHA256 over a block's content (excluding the seal field itself)"* —
i.e., the **open-set** (all fields minus exclusions) convention. The only `{type, day_index,
date, ...}` literal in the docs is a **genesis construction** example in an init workflow,
not a seal-definition list. The Phase-4 premise was therefore unsupported.

`original_hash` is excluded from the whitelist **by omission** (it did not exist pre-migration;
any not-listed field is dropped). No verifier treats `original_hash` as a *required* field —
it only matters because, when present, it is a **seal input** under the open-set convention.

---

## 3. Measured Divergence (129-block migrated ledger)

### 3.1 Per-client seal conventions (from source)

| # | Client | Seal includes | Excludes | Effective fields on migrated ledger |
|---|--------|---------------|----------|-------------------------------------|
| A | **Python** `chain.py:450` | all fields | `{hash_key, identity_seal, signature, format_version, key_version}` | 6 — incl. `original_hash` |
| B | **Web** `chain.js:528` | all fields | `{hash_key, signature, identity_seal}` only | 6 — incl. `original_hash` **and** `format_version`, `key_version` |
| C | **Flutter** Phase 4 `_sealFields` | fixed 5-field whitelist | everything else | 5 — excl. `original_hash` |
| D | **Migration tool** `_seal_block` | all fields | same exclusions as Python | follows A → 6 — incl. `original_hash` |

### 3.2 Verification outcome by convention (real data)

| Block type | Count | Open-set w/ `original_hash` (Python/migration) | 5-field whitelist (Flutter Phase-4) |
|-----------|-------|-----------------------------------------------|--------------------------------------|
| genesis    | 1   | ✅ 1/1 | ❌ 0/1 |
| day        | 120 | ✅ 120/120 | ❌ 0/120 |
| month_summary | 5 | ✅ 5/5 | ❌ 0/5 |
| year_summary  | 3 | ✅ 3/3 | ❌ 0/3 |
| **Total**  | **129** | ✅ **129/129** | ❌ **0/129** |

### 3.3 The only differing field is `original_hash`
Both conventions include `{type, day_index, date, prev_hash, entries}`. The Python
convention adds exactly one field — `original_hash` (the provenance hash the migration
writes on every block before re-sealing). Flutter's whitelist excludes it. No other field
differs across the 129 blocks (each block type has a single uniform field-set variant).

> **Note on serialization:** Dart `jsonSort` and Python `json.dumps(sort_keys=True)` both
> produce space-separated (`": "`, `", "`) JSON, so they are byte-identical for content
> hashes. Serialization is **not** the divergence here — the field-set is.

### 3.4 Web's separate bug
Web does **not** exclude `format_version`/`key_version` (unlike Python). Web-created blocks
lack these fields so it's latent today, but it becomes an active breakage on any key rotation
or format bump. Convergence must fix it.

---

## 4. Required Fields for Validation (context)

For reference — the fields verifiers **require** regardless of seal convention:

- **Every block:** resolvable `type`; its `{type}_hash` seal present & non-empty; `prev_hash`
  (except block 0); `entries` on day blocks.
- **Every entry (day block):** `data` (map); `hash` (string).
- **Every entry at `format_version ≥ 0.4.0`:** `data.content_hash` present & non-empty
  (enforced by all three clients via `requireContentHash`).

`original_hash`, `date`, `day_index`, `format_version`, `key_version`, `identity`,
`identity_seal`, `signature` are **not** presence-required — they matter only if sealed.

> **Nuance — `original_hash` is *optional-presence*, sealed-*when-present*.** `original_hash`
> only exists on migrated blocks; new/pre-0.4.0 blocks commonly lack it. No verifier requires
> it to *exist*. It is in the seal whitelist so that **when present, every client seals over it**
> (that is what fixes the cross-client divergence). The whitelist selects fields **wherever they
> appear**; absent whitelist fields are simply skipped. So the 6-field set is really
> *5 always-present mandatory fields + `original_hash` (sealed when present)*. This is a
> whitelist of candidate seal inputs, NOT a list of must-exist fields.

### 4.1 Seal vs Content-Hash: two distinct hashing layers

A common confusion — the two hashes in a ledger are different mechanisms with different
inclusion policies:

| | Input scope | Inclusion policy | Purpose |
|---|-------------|------------------|---------|
| **Block seal** (`{type}_hash`, `block_hash`, `day_hash`, …) | a controlled **subset** of the block's top-level fields | **closed whitelist** (ADR-029) | Authenticate block structure + linkage; keep rotation/migration-sensitive fields (`format_version`, `key_version`) OUT so they can change without breaking trust |
| **Entry content_hash** (`data.content_hash`) | the entry's **plaintext data** | **open set — all keys** (ADR-005) | Prove entry content authentic & unchanged across re-encryption |

Key clarifications:

- **Storage vs hashing are unrelated.** The full block is always stored — all keys present.
  The seal field-set only controls *which keys are fed into the HMAC*, not which are kept.
- **The seal does NOT hash every block field.** `format_version`, `key_version`, `identity`,
  `identity_seal`, `signature`, and future metadata are stored but excluded from the seal
  (by the whitelist) so they can be mutated during rotation/migration without breaking it.
- **The content hash DOES cover all entry plaintext.** It iterates all keys in `data`,
  decrypting `*_enc` fields to plaintext first (surviving re-encryption). The only in-band
  exclusions are the `content_hash` field itself (the product) and encrypted values are
  re-measured as their plaintext.
- **Asymmetry is intentional:** entries are open-set (you want all content covered); block
  seals are closed-set (you don't want metadata/rotation fields to break the seal).

---

## 5. The Decision: Which canonical seal-field set?

Four candidates. They differ on two axes: **(1)** inclusion policy — *open set*
(everything-minis-exclusions) vs *closed whitelist*; **(2)** whether **`original_hash`**
(provenance) is sealed.

### Choice 1 — Open set: "all fields except overhead" (restores pre-refactor; incl. `original_hash`)
```
allow = all block fields − { hash_key, identity_seal, signature, format_version, key_version }
```
- **Ledger outcome:** 6 fields incl. `original_hash` — **matches the migration's current
  output. No re-migration needed.**
- ✅ True to PHPSPEC's literal wording; provenance tamper-covered; same as `_derive` today.
- ❌ Any future or client-specific block field silently enters the seal → cross-client
  breakage on every schema addition (the failure class this incident came from).

### Choice 2 — Open set, Web-style: "exclude hash + identity only"
```
allow = all block fields − { hash_key, signature, identity_seal }
```
- **Ledger outcome:** 6 fields incl. `original_hash`, `format_version`, `key_version`.
- ❌ `format_version` and `key_version` are mutated by rotation/migration — sealing them
  breaks seals on every key rotation / format bump. **Not recommended.**

### Choice 3 — Closed whitelist incl. `original_hash` (recommended)
```dart
sealFields = ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash']
```
- **Ledger outcome:** 6 fields; `original_hash` sealed; `format_version`/`key_version`/others not.
- ✅ Explicit & rotation-safe (closed set — new fields don't silently affect seals); keeps
  provenance tamper-covered; deterministic across all four implementations.
- ❌ Requires **re-migrating** the ledger (restamp all 129 block seals to the 6-field form)
  and updating Python + Web + migration-tool verifiers/sealers to the whitelist.

### Choice 4 — Closed whitelist excl. `original_hash` (current Flutter Phase-4)
```dart
sealFields = ['type', 'day_index', 'date', 'prev_hash', 'entries']
```
- **Ledger outcome:** 5 fields; `original_hash` stays a non-sealed metadata field.
- ✅ Tightest, most stable, rotation-safe; the Phase-4 refactor's original intent.
- ❌ `original_hash` not covered by the seal (proof that provenance is authentic still comes
  from content_hash + entry hashes); requires **re-migrating** all 129 blocks and updating
  Python + Web + migration tool.

### 5.1 Comparison summary

| | Choice 1 | Choice 2 | Choice 3 | Choice 4 |
|---|---|---|---|---|
| Policy | open | open | **closed** | **closed** |
| Includes `original_hash` | ✅ | ✅ | ✅ | ❌ |
| Seals `format_version`/`key_version` | ❌ | ✅ | ❌ | ❌ |
| Re-migrate required | **No** | No | Yes | Yes |
| Future schema-addition safe | ❌ | ❌ | ✅ | ✅ |
| Rotation/format-bump safe | ✅ | ❌ | ✅ | ✅ |
| Provenance tamper-covered | ✅ | ✅ | ✅ | ❌(via hashes) |
| Matches PHPSPEC wording | ✅ | ❌ | ❌(whitelist) | ❌(whitelist) |
| Consistency w/ ADR-005 (all-keys) | ✅ | ✅ | ⚠️ | ⚠️ |

---

## 6. Recommendation

**Adopt Choice 3 — a closed whitelist that includes `original_hash`:**
`{type, day_index, date, prev_hash, entries, original_hash}`.

### Rationale
1. **Predicability (D4 stable trust):** A closed set means adding a future field never
   silently invalidates cross-client seals — the exact failure mode that caused this incident.
2. **Provenance integrity:** keeps `original_hash` within the seal, so the migration's
   proof that a block is unchanged from its source chain is itself tamper-covered.
3. **Rotation/format safe:** `format_version` and `key_version` stay out of the seal, avoiding
   the web bug (Choice 2) and key-rotation breakage.
4. **Minimal deterministic contract:** six fixed fields, identical by name in all four
   implementations and in PHPSPEC — ideal for a formal ADR + canonical test vectors.
5. **Pattern consistency:** mirrors `_sealFields` design (closed, explicit) while fixing its
   one omission (`original_hash`).

> **Alternative if minimizing immediate work:** Choice 1 avoids re-migration but keeps an open
> set that reproduces this incident's failure class. Only prefer it if the migration chain
> must not be re-touched this cycle.

---

## 7. Impact Assessment (D1–D11)

### Directly relevant directives
| Directive | Assessment |
|---|---|
| **D4 — Chain of Trust** | ✅ Choice 3 keeps every block's seal recomputable; seals stay mandatory; tamper detection intact and *more* robust (closed contract). |
| **D9 — Backward Compatibility** | ⚠️ Requires a one-time, backed-up, validated **re-migration** (new chain, original preserved) — consistent with D5/D9 migration rules. Existing pre-0.4.0 ledgers unaffected (whitelist fields all present). |
| **D5 — Append-Only** | ✅ Re-migration produces a *new* chain; the source is backed up, never destroyed in place. |
| **D10 — Testing Integrity** | ✅ Requires NEW cross-client canonical seal vectors + regression tests in all three clients before landing. |
| **D1/D2/D3/D6/D7/D8/D11** | No impact (open format, no new deps, offline, compartmentalized, recoverable, staging unaffected). |

### Files to change (if Choice 3 lands)
- `docs/spec/PHPSPEC.md` — define the canonical seal-field contract (`_seal_fields`).
- `domain/ledger/chain.py` — verifier + sealer → whitelist w/ `original_hash`.
- `phpoc-web/src/ledger/chain.js` — verifier/sealer → whitelist w/ `original_hash` (fix its
  exclusion bug too).
- `phpoc-flutter/lib/data/ledger/chain.dart` — `_sealFields` → add `original_hash`.
- `phpoc_cli/migrate_format.py` (+ standalone `migrate-format.py`) — `_seal_block` → whitelist.
- `docs/design/ARCHITECTURAL_DECISIONS.md` — new ADR (next number: **ADR-029**).
- `testdata/canonical_test_vectors.json` + per-client test suites — new seal vectors.
- `docs/reference/MAP.md`, `SESSION_HANDOFF.md`, `docs/planning/ROADMAP.md` — status/notes.

### Re-migration steps (if Choice 3 or 4 lands)
1. Back up current `after-4-migration.json`.
2. Apply whitelist to all four implementations + PHPSPEC.
3. Add cross-client seal test vectors (Python/Web/Flutter all verify same 129-block sample).
4. Re-run `ph migrate-format` (or `--force`) to restamp seals (`original_hash` retained in
   `original_hash`, excluded from whitelist where applicable).
5. Verify migrated output with Python `chain.verify()` AND Flutter `verify()`.
6. Push updated build to phone; re-onboard; confirm verify passes.

---

## 8. Open Questions / Next Actions

- ✅ **Decision:** **Choice 3 adopted** — closed whitelist `{type, day_index, date, prev_hash,
  entries, original_hash}` (ADR-029 → ✅ Adopted).
- [x] Python `chain.py` implemented (Ph 1/7) — `SEAL_FIELDS`/`select_seal_fields`/`compute_seal`; Type-aware summaries seal `month`/`year`.
- [x] Web `chain.js` + `merge.js` + `summary_policy.js` implemented (Ph 2/7) — `seal_fields.js` `SEAL_FIELDS`/`selectSealFields`/`computeSeal`; fixes §3.4 latent `format_version`/`key_version` sealing and conforms Web genesis seal to exclude `identity`. P4 deduped `sync.js`/`genesis_gate.js` diagnostic builders through the shared whitelist.
- [ ] Flutter `chain.dart` — `_sealFields` → add `original_hash` (Ph 3/7).
- [ ] Migration tool `phpoc_cli/migrate_format.py` + standalone `migrate-format.py` (Ph 4/7).
- [ ] Update `docs/spec/PHPSPEC.md` (seal whitelist) (Ph 5/7).
- [ ] Add cross-client canonical seal test vectors shared by Python/Web/Flutter (Ph 6/7).
- [ ] Re-migrate the current 0.4.0 ledger to restamp all 129 block seals to the 6-field form
      (original backed up; consistent with D5/D9).
- [ ] Verify migrated output with Python `chain.verify()` AND Flutter `verify()`; push build to
      phone and confirm on-device verification.
- [ ] Register canonical seal-field set in PHPSPEC schema docs.

---

## 9. References
- Incident analysis: `SESSION_HANDOFF.md` (migrate-format work, verification failure).
- Migration tool: `phpoc_cli/migrate_format.py`, standalone `migrate-format.py`.
- Verifiers: `domain/ledger/chain.py`, `phpoc-web/src/ledger/chain.js`,
  `phpoc-flutter/lib/data/ledger/chain.dart`.
- Related ADR: ADR-005 (content-hash extensible all-keys iterator); ADR-007 (chain of trust);
  ADR-011 (backward compatibility).
