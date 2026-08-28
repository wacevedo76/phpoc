# C-2 Cross-Client Verification — Phase D (Phase 1 blueprint)

> **Roadmap:** `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` §Phase D
> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P2
> **Status:** 🔜 Not started. Web re-key (Phases B/C) and Flutter re-key are done; CLI Phase A + this cross-client proof remain.

## Purpose

Prove the C-2 seed-replacement property **across clients**: a chain re-keyed on any client must pull +
verify under the new Master Key (MK) on the other two, and a device holding the **old** seed must fail
to decrypt — the leak-nullification guarantee. This is verification + docs, not new re-key mechanics.

## Scope

### D1 — Cross-client re-key verification

- **Web as re-keyer (doable now):** re-key on Web (`RekeyService`), then on **Flutter** pull + verify
  the rewritten chain under the new MK; a Flutter device seeded with the **old** seed must fail to decrypt.
- **Flutter as re-keyer:** re-key on Flutter, then on **Web** pull + verify under the new MK; old-seed Web fails.
- **CLI as re-keyer:** blocked on CLI Phase A (`ph rekey-seed`). Once Phase A lands, run the same
  pull+verify + old-seed-fail matrix with CLI as the re-keyer and the other two as verifiers.

**Assertions (per re-keyer/verifier pair):**
1. Re-keyed chain pulls to the verifier with no error.
2. Verifier `verify()` is VALID under the new MK (seals + content hashes + `key_version`).
3. `hash_index.json` / `index.json` / genesis parity is intact after the pull.
4. A device holding the **old** seed cannot decrypt blocks (leak-nullification).
5. Staging + device-cookie rotation result in `reauthNeeded` on the stale device (P-group parity).

### D2 — Spec/format pass

- Confirm `PHPSPEC.md` `key_version` + ADR-029/029a seal whitelist cover a **seed-mint** re-key
  (vs. ADR-026 same-seed rotation). Document the seed-replacement semantic distinctly.

### D3 — Docs

- Update `ROADMAP.md` (mark C-2 cross-client), `WEB_ROADMAP.md` (build entries), `MAP.md` (new files),
  `CHANGELOG.md` on release, `SESSION_HANDOFF.md`.

## Test environments

- Flutter ↔ Web pairs against the live R2 Worker (creds in `TEST_CREDENTIALS.md`), mirroring the
  CCS-4 cross-client E2E harness; plus a hermetic fixture-based variant where possible.

## Dependencies & assumptions

- Re-key presumes a valid canonical 0.4.0+ chain (see `LEDGER_VALIDITY_WORKFLOW_PHASE1.md`).
- D1 (Web/Flutter pairs) unblocks now; D1 (CLI) unblocks on CLI Phase A.

## Acceptance criteria

1. At least Web↔Flutter both directions verified: pull+verify under new MK, old-seed decrypt fails.
2. Spec/format pass (D2) complete.
3. All docs (D3) updated; `C2_SEED_REKEY_WEB_CLI_ROADMAP.md` marked cross-client-complete.
