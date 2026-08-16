# Roadmap — Personal History Protocol (PHPOC)

PH Ledger (phpoc) — planned features organized by protocol layer.
See [VISION.md](../VISION.md) for the full protocol pitch, [../design/DESIGN_GOALS.md](../design/DESIGN_GOALS.md) for architectural mandates,
[../reference/CHANGELOG.md](../reference/CHANGELOG.md) for blocker resolution history, and [BACKLOG.md](BACKLOG.md) for paused issues.

## Legend
- ✅ = Completed
- 🔜 = Planned
- 🔮 = Future consideration

---

## 0. Protocol Layer — Platform-Free Personal Data

The top-level goal for PHPOC: establish it as an **open data format** for portable, encrypted, self-sovereign activity history — not just a CLI tool. Multiple implementations (laptop, mobile, wearable, web viewer) all interoperate through a shared format spec.

| Item | Status | Priority | Notes |
|---|---|---|---|
| **Commonplace Book** — A personal thematic library (title, `tags`, `entry`, optional ad-hoc k/v, **no `comment`**) stored as a **separate sealed `commonplace.json`** chain sharing the main ledger's seed→MK, with its own genesis block (ADR-031). All content encrypted; append-only day-grouped sealed commits; staging→commit workflow (D11). Flutter first, then Web, then CLI. | 🟡 In progress | Medium | Phase 1 blueprint: `docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md` (55 assertions, groups A–F). ADR-031 documents the decision. Phase 3 (GREEN): 55/55 tests pass for the Flutter chain/engine/storage engine (2026-08-21). Phase 4 (REFACTOR): done — shared `SealableChain` mixin deduped with the ledger layer; 349/349 ledger-lever tests GREEN (2026-08-21). Next: follow-on slices (UI, sync, rotation, blind index). |
| **VISION.md** — Protocol pitch written | ✅ | — | Captures the "why" and the social use cases |
| **Format Specification** (`PHPSPEC.md`) — Document the block structure, encryption scheme, chain validation, content hash algorithm, blind index, and staging area as a standalone spec | ✅ | — | Enables anyone to implement a reader/writer without reverse-engineering Python. Cross-refs: [DESIGN_GOALS §1](../design/DESIGN_GOALS.md#1-cryptographic-integrity--immutability), [BACKLOG P1](BACKLOG.md#p1-format-specification-phpspecmd). Includes `format_version` field in genesis (§4.1), explicit versioning policy (§9.3), and one-time migration script (`scripts/migrate_format_version.py`). |
| **Canonical Ledger Format** — Fix I-07 (format_version excluded from block seal, removed from blocks) and I-17 (genesis `day_hash` → `block_hash`). Add `ph migrate` command for full chain rewrite. 40 tests planned across PY + JS. Test plan at `docs/planning/CANONICAL_LEDGER_FORMAT_TESTS.md`. | ✅ Done | High | GREEN phase complete (2026-07-03). I-07: `format_version` excluded from seal, removed from blocks, excluded from import verification. I-17: genesis `block_hash` replaces `day_hash`. `ph migrate` command implemented in `phpoc_cli/migrate.py` (backup, strip, rename, reseal, rechain). Backward compat: old genesis with `day_hash` still verify (fallback). 26 new PY tests (`tests/test_migration.py`) + 10 new JS tests (`ledger_chain_test.mjs`) + 2 new JS tests (`ledger_import_chain_test.mjs`). All 1580 PY + 571 JS tests pass. See also `docs/design/flaws/ISSUES_TO_ADDRESS.md` (I-07, I-17). (2026-08) ADR-029/029a 6-field per-type seal whitelist converged across Python/Web/Flutter/Migrator; Ph-7 on-device validation: re-migrated 132-block ledger `chain.verify()=True` (Python) and on-device PHPSPEC-pull import `verify()=True` on emulator-5554 after the `original_hash` storage-fidelity fix; onboarding import-from-file also fixed to preserve the canonical genesis (`keepExistingGenesis: true` in `_importRawChain`/`_importV2`) so it verifies too. (2026-08-11) Phone e2e CONFIRMED on emulator-5554 (`integration_test/onboard_verify_test.dart`): BOTH Path A (`LedgerBackupService.importFromJson` PHPSPEC pull) AND Path B (`OnboardingService.importFromFile`) `verify()=True` with all 132 migrated blocks on-device. Plan: `docs/planning/CANONICAL_SEAL_FIELD_IMPLEMENTATION_PLAN.md`. |
| **Portable Export** — Two sub-commands: `--range` (block-level chain segment via chain splitting) + `--tag` (entry-level signed manifest for social sharing) | ⏸️ Deferred | **Highest** | File export unknowns (verification format, encrypted field treatment) need real-world context. Design session complete. See SESSION_HANDOFF §P2 Design Session. |
| **Remote Sync (git-based)** — `GitStagingTransport` implementation, `init --git-create`, blob obfuscation | 🔜 | **High** | Staging blob only (not ledger). Shell-out to git CLI. Config-driven. See SESSION_HANDOFF §P3 Design Session. Cross-refs: [DESIGN_GOALS §3](../design/DESIGN_GOALS.md#3-scalability--durability), [BACKLOG P3](BACKLOG.md#p3-remote-sync-git-based) |
| **Laptop reference implementation polish** — CLI kinks, UX improvements, reliability | 🔜 | **High** | The CLI is the first-class reference. Must be solid before downstream porting. Cross-refs: [BACKLOG P4](BACKLOG.md#p4-cli-kinks--ux-polish) |
| **E2E Cross-Client Sync Fix** — 4 bugs blocking CLI↔Web roundtrip via R2. Bug 1: genesis mismatch indiscriminate (typed error hierarchy). Bug 2: month summary blocks dropped on push (position counter). Bug 3a: same device UUID overwrite (client suffix + remove fast path). Bug 3b: entry format mismatch (canonicalize web on spec). Bug 4: genesis seal creation≠verification (strip signature). See `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md`. | ✅ Done | **High** | GREEN phase complete. All 4 bugs implemented. 12 source files + 8 test files changed. 0 failures across 38 JS suites + 1554 Python tests. |
| **LedgerMerge Python port** — `domain/ledger/merge.py` (~300 lines), 47 tests passing | ✅ Done | **High** | GREEN phase complete. Full implementation: `merge()`, `_verify_chain()`, `_verify_block_data()`. 47 tests across 11 groups (M, A–J) all pass. Wiring into orchestrator complete (Step 2): `SyncOrchestrator._sync_ledger_blocks()` detects same-genesis divergence, offers interactive merge prompt, calls `LedgerMerge.merge()`, replaces local chain + index, force-pushes merged result. 11 new orchestrator merge tests. See `docs/planning/LEDGER_MERGE_PYTHON_PORT.md`. |
| **Onboarding/ReAuth Speedup** — Hash-index based genesis check replacing full block pulls. 4-phase TDD plan at `docs/planning/ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md`. | ✅ Done | High | Cuts genesis check from ~21s to ~0.1s (210×). Phase 1: ✅ test identification. Phase 2: ✅ RED test creation (62 new tests). Phase 3: ✅ GREEN implementation (485 tests pass, 0 failures). Phase B: ✅ Login Perf gap closed (merged flag gate, cookie cache, genesis cache — 466 tests/0 fail). **CLI:** ✅ Hash index fast path added to `SyncOrchestrator` (Tier 1 SHA-256, Tier 2 fork detection). Both clients push + pull same index files. 1554 Python + 466 JS tests pass. ADR-024 documents the design. |
| **Mobile POC** (Swift/Kotlin) — Minimal ledger reader/ writer | 🔮 | Medium | Proves the format works cross-platform. Blind index writes (no full decryption) for wearable. |
| **Wearable POC** (watchOS/WearOS) — Blind index writes only | 🔮 | Medium | Minimal footprint: log duration + activity type, no full decryption needed |
| **Web reader** — Static HTML/JS page that renders an exported ledger segment | 🔮 | Medium | Shareable lens into your history, no app store required |
| **Cross-device trust** — Verify chain segments signed by another device's sovereign key | 🔮 | Medium | Prerequisite for multi-device identity |
| **Social primitive: verifiable claims** — Share a signed range as proof of consistency | 🔮 | Low | "I've practiced 300+ hours this year" — verifiable without revealing content |

### Blocked By

None. No new roadblocks identified. All historical blockers (R1–R4) resolved.

---

## 1. Cryptographic Integrity & Immutability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Hierarchical Lock Chain (Genesis → Year → Month → Day → Task) | ✅ | — | Implemented, tested |
| Block signing with Ed25519-proxy (HMAC-SHA256) | ✅ | — | Every block signed |
| Verify command | ✅ | — | Full chain + entry hash + content_hash verification |
| Tamper detection | ✅ | — | Any modification breaks downstream chain |
| Encrypt-then-MAC auth tag (HMAC-SHA256) | ✅ | — | Added per [R1 resolution](../reference/CHANGELOG.md) |
| Plaintext content hash per entry (content_hash) | ✅ | — | Added per [R4 resolution](../reference/CHANGELOG.md) |
| Identity fallback in genesis | ✅ | — | Added per [R2 resolution](../reference/CHANGELOG.md) |
| **Real Ed25519 signatures** (move beyond HMAC proxy) | 🔮 | Low | Requires cryptography package; current proxy is zero-dep. |
| **Hardware-backed identity (TPM/SE)** | 🔮 | Low | Future-proofing for mobile/embedded |

### Blocked By
None.

---

## 2. Scalability & Durability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Partitionable chain design | ✅ | — | Each block independently sealed |
| Year/Month summary blocks | ✅ | — | I/O optimization for partial traversals |
| PBKDF2 600K iterations (OWASP 2026) | ✅ | — | Per [R3 resolution](../reference/CHANGELOG.md) |
| **Remote Sync (git-based)** | 🔜 | **High** | Listed above in §0. ✅ All blockers resolved. Paused — see BACKLOG.md. |
| **Archival automation** (`phpoc archive --year X`) | 🔜 | Medium | Move old years to separate file. |
| **Reconciliation / Chain-Bridging** | 🔜 | Medium | Restore chain from orphaned blocks. ✅ All blockers resolved. |
| **Database backend** (SQLite, etc.) | 🔮 | Low | Via AbstractLedgerStore |
| **Multi-device sync** (CRDT-based) | 🔮 | Low | Conflict-free merging across devices |

### Blocked By
None — all historical blockers (R1, R2, R3, R4) resolved.

---

## 3. Privacy & Anti-Forensics

| Item | Status | Priority | Notes |
|---|---|---|---|
| Encrypted timestamps (AES-CTR + auth tag) | ✅ | — | startTime_enc, endTime_enc |
| Encrypted metadata | ✅ | — | metadata_enc in every entry |
| Blind duration index (index.json) | ✅ | — | Reputation queries without decryption |
| Recovery Seed with encryption (PDK) | ✅ | — | Seed encrypted with passphrase-derived key |
| **Media Witness linkage** | 🔜 | Medium | Content hashes linked to activities. |
| **Split-ledger prevention** — Warn before creating new ledger when remote already has blocks; remove destructive auto-clear on genesis mismatch | ✅ | — | Phases A+B implemented. `bootstrapServices()` no longer auto-clears remote on genesis mismatch. `createNewLedger()` checks remote before allowing creation. |
| **Plausible deniability mode** | 🔮 | Low | Decoy passphrase reveals fake history. |

### Blocked By
None.

---

## 4. User Experience & Accessibility (Reference Implementation)

| Item | Status | Priority | Notes |
|---|---|---|---|
| Lazy authentication (RAM cache) | ✅ | — | Once-per-boot passphrase |
| Staging area (plain-text NoAuth) | ✅ | — | Quick task entry without auth |
| Active task view (`phpoc view`) | ✅ | — | Shows running tasks with start time |
| List with source filtering (`all/synced/staged`) | ✅ | — | |
| Reputation with date range (`--from`/`--to`) | ✅ | — | Blind index filtered queries |
| Rich date filtering (`--date`, `--week`, `--month`, `--year`) | ✅ | — | Flexible formats, chaining via intersection |
| **Day-boundary spanning (display marker + filter peek)** | ✅ | Medium | Fix A+B implemented. ADR-020. Commit `47ea8fd` on branch `P11-Day-Boundary-Span` |
| **Ledger auto-pull on ownership-handoff reauth (ADR-030)** | ✅ | High | After reauth on a device switch, the device sees BOTH last ledger and last staging state automatically. Implemented in Flutter (4-phase TDD, 2026-08-11). Ledger pulled only on cookie-specifier mismatch / fresh claim (block-count freshness); NOT on valid-cookie fast path or same-device TTL expiry. Commit is a D11 move: seals → auto-pushes ledger → wipes committed staging rows. `ledger_auto_pull_on_reauth_test.dart` 12/12. **Web parity (4-phase TDD, 2026-08-11):** `phpoc-web` `_pullLedgerOnHandoff` (block-count-gated, fail-safe) + Scenario-5/6 drop in `_mergeRemoteIntoLocal` via `SyncService._dropSealedUncommitted`; `web_ledger_auto_pull_test.mjs` 17/17, full suite no regressions. See `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md` + `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md`. Protocol rule §12 of CROSS_CLIENT_STAGE_SYNCING_REFERENCE. |
| **Tab-completion / auto-suggest** | 🔮 | Low | Shell completions for titles |
| **Export to CSV/JSON (decrypted)** | 🔮 | Low | For interoperability |

### Blocked By
None.

---

## 5. Recovery & Identity

| Item | Status | Priority | Notes |
|---|---|---|---|
| Recovery Seed generation (256-bit) | ✅ | — | 32 bytes urandom → base64 |
| Seed → Master Key derivation | ✅ | — | Direct SHA-256 of seed bytes |
| Passphrase-based seed unlock | ✅ | — | PBKDF2(passphrase) → AES decrypt seed |
| `phpoc recover` command | ✅ | — | Seed → new passphrase → re-seal Genesis |
| Identity file (identity.json) | ✅ | — | Encrypted secret + pub key |
| Identity fallback in genesis block | ✅ | — | Per [R2 resolution](../reference/CHANGELOG.md) |
| **Single-file export** (`phpoc export --combined`) | 🔮 | Low | Merge identity into Genesis for portability |
| **Multi-identity support** (aliases/permissions) | 🔮 | Low | Multiple signing keys per ledger |
| **AI-agent verifiable reports** | 🔮 | Low | Signed third-party verification of habits |

### Blocked By
None.

---

## Priority Summary

| Priority | Item | Dependencies |
|---|---|---|
| ✅ Done | Format Spec ([PHPSPEC.md](../spec/PHPSPEC.md)) | — |
| ⏸️ Deferred | Portable Export (`--range` + `--tag`) | Deferred — file export unknowns need real-world dev context. Design captured in SESSION_HANDOFF §P2. |
| 🥇 High | Remote Sync (git-based) | Infrastructure exists, GitStagingTransport implemented. Remaining items paused — see BACKLOG.md. |
| 🥇 High | CLI kinks & UX polish | Paused — CLI in maintenance mode while browser client is active. See BACKLOG.md. |
| 🥈 Medium | Mobile POC reader/writer | Format Spec, Portable Export |
| 🥈 Medium | Wearable POC (blind index writes) | Format Spec |
| 🥈 Medium | Web viewer (static HTML) | Portable Export |
| 🥈 Medium | Archival Automation | None — can start now |
| 🥈 Medium | Reconciliation / Chain-Bridging | None — all blockers resolved |
| 🥈 Medium | Media Witness linkage | None — can start now |
| 🥉 Low | Real Ed25519 signatures | External dep evaluation |
| 🥉 Low | Shareable / Single-file Export | None |
| 🥉 Low | Multi-device sync (CRDT) | Remote Sync first |
| 🥉 Low | Plausible deniability, Tab completion, etc. | None |

---

## Dev Notes

### Compatibility Policy
- **No breaking changes to existing ledgers** (v0.x → v1.0)
- New fields are always optional in existing block types
- Archive/export operations are opt-in
- File format versions tracked internally for migration tooling

### Zero-Dependency Commitment
- Core engine: 100% Python standard library
- Optional features (e.g., `git sync`) may require system git
- Web/mobile interfaces are separate packages (no constraint)

### Testing Philosophy
- RAM-backed disk tests for speed
- Test against real file I/O (no mocking storage layer)
- Verify chain integrity after every modification
- Test recovery flow with known seeds for determinism
