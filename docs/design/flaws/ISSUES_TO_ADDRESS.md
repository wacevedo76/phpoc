# Issues to Address — Personal History Protocol (PHPOC)

> **Purpose:** Identify, outline, summarize, and organize by severity all known
> design flaws in the PHPOC system. This document guides planning for
> elimination or mitigation of each issue.
>
> **Last updated:** 2026-07-01
> **Sources:** `docs/spec/PHPSPEC.md` v0.3.0, `docs/design/DESIGN_GOALS.md`,
> `docs/design/ARCHITECTURAL_DECISIONS.md`,
> `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md`,
> `docs/reference/MAP.md` (Architecture Invariants),
> `docs/design/flaws/PHPSPEC-Design_Flaws.md`

---

## Severity Tiers

| Tier | Label | Criteria |
|------|-------|----------|
| **Critical** | 🔴 | Breaks core protocol promises, leads to data loss, makes the system fundamentally insecure, or contradicts a first-order design principle |
| **High** | 🟠 | Significant architectural weakness, misleads implementers, undermines key design goals, or creates an integrity gap |
| **Medium** | 🟡 | Real problem with limited blast radius, acknowledged trade-off, or documentation quality failure |
| **Low** | 🟢 | Cosmetic, editorial, naming, or justification issues — no security impact |

---

## Issue Inventory

### Critical

#### I-01: No Key Rotation — One Key Forever (Flaw #5)

**Summary:** The Master Key protects every block, past and future, for all time.
If compromised, every entry ever written and every entry yet to be written is
exposed. There is no re-key operation, no key version field, no mechanism to
rotate the MK, and no way to read old data under an old key while encrypting new
data under a new key. The content hash was designed to "survive re-encryption"
but the protocol provides zero machinery to actually perform re-encryption.

**What breaks:** A single key compromise is catastrophic and permanent with no
remediation path. This is the single biggest architectural gap in the protocol.

**Where documented:** PHPSPEC §2.6, ADR-001 (describes key model but not
rotation), DESIGN_GOALS §1 (mentions content hash surviving re-encryption but
no mechanism)

**Required to fix:**
- Add `key_version` field to blocks
- Define a key rotation protocol (derive new MK, re-encrypt blocks, update
  version)
- Allow blocks encrypted under different key versions to coexist in the chain
- Implement actual re-encryption workflow, not just the content hash property
- Migrate existing ledgers forward

**Estimated effort:** High — touches crypto, chain, verification, and migration.

---

#### I-02: Blind Index Is Plaintext (Flaw #6)

**Summary:** `index.json` stores `{date: {activity_title: total_duration_ms}}` in
plain JSON with zero encryption. The ledger encrypts timestamps and metadata with
AES-CTR + HMAC. The index file sitting next to the encrypted ledger leaks activity
titles and daily durations to anyone with filesystem access. ADR-008 acknowledges
this as an explicit trade-off. The PHPSPEC buries it as a one-line privacy note.

**What breaks:** The protocol's first design principle — "encrypted,
self-sovereign ledger" — is undermined at the file that is most likely to be
accessed by a casual observer (backup system, sync tool, directory listing). The
index reveals exactly what activities a user does and for how long.

**Where documented:** PHPSPEC §7, ADR-008

**Required to fix:**
- Encrypt the index at rest with the Master Key
- If "queries without full decryption" is a hard requirement, use searchable
  encryption or a derived viewing key
- At minimum, encrypt with the same MK — decryption on `phpoc rep` is ~3s (same
  as auth), which is acceptable for a query command

**Estimated effort:** Medium — crypto is straightforward, but API changes
(touches CLI, domain/ledger/index, and all callers of the index)

---

#### I-03: Staging On-Disk Data Is Not Encrypted (Flaw #7)

**Summary:** `staging.json` stores entries with a `plain:` prefix instead of real
ciphertext. The staging file on the local filesystem is neither encrypted nor
authenticated. The spec's opening line promises "encrypted, self-sovereign ledger
format." The staging file contradicts this. ADR-009 frames this as a UX trade-off
for quick capture without passphrase. ADR-015 (D2) plans encrypted multi-device
staging — but D2 is not implemented.

**What breaks:** The most recent, most sensitive data (current active tasks) is
the least protected. Anyone with filesystem access reads what the user is doing
right now without any key material.

**Where documented:** PHPSPEC §8.2, ADR-009, ADR-015

**Required to fix:**
- Encrypt staging entries at rest with a derived key
- If "view without full authentication" is needed, use a limited-scope viewing
  key cached in `/dev/shm` with short TTL
- Remove the `plain:` prefix as anything other than an internal implementation
  detail of the sync pipeline

**Estimated effort:** Medium — touches staging service, crypto manager, CLI
display, and all staging read/write paths. ADR-015 already has design direction.

---

### High

#### I-04: HMAC Called "Signature" Throughout the Spec (Flaw #1)

**Summary:** The PHPSPEC uses the word "signature" 40+ times and names the field
`signature` for what is actually an HMAC-SHA256 MAC. An HMAC is symmetric — anyone
with the `identity_secret` can both "sign" and "verify." There is no asymmetric
property. Third-party verifiability (a stated goal in DESIGN_GOALS §1) is
impossible with HMAC. The companion ADR-003 is honest about this; the spec is not.

**What breaks:** Implementers are trained on false terminology. Third-party
verifiers are misled about security properties. DESIGN_GOALS §1 lists "Real
Ed25519 Signatures" as a planned feature — the spec shouldn't use the word until
the feature exists.

**Where documented:** PHPSPEC §2.7, §5.3, ADR-003, DESIGN_GOALS §1 and §5

**Required to fix:**
- Rename the field to `seal` or `tag` in the spec (use `identity_seal` to
  distinguish from block seal)
- Rename `sign()` / `verify_signature()` to `mac()` / `verify_mac()`
- Reserve the word "signature" for when real Ed25519 is implemented
- The spec should use terminology that matches the actual cryptographic
  properties

**Estimated effort:** Low — rename only. But must cascade through the spec,
  CLI code, and all tests.

---

#### I-05: Fixed PBKDF2 Salt Enables Cross-User Precomputation (Flaw #2)

**Summary:** The PBKDF2 salt is hardcoded to `b"session-salt"` for all users.
The spec justifies this with: *"The Seed has 256 bits of entropy — a per-user salt
would add no security here."* This justification is wrong. The passphrase does not
have 256 bits of entropy. If two users choose the same passphrase, they produce
identical PDKs. An attacker can build a rainbow table for common passphrases
against this fixed salt and break all users simultaneously.

**What breaks:** Cross-user precomputation attacks are enabled. The reasoning in
the spec teaches bad cryptographic practice to implementers. ADR-004 only
addresses iteration count, not salt design.

**Where documented:** PHPSPEC §2.4, ADR-004

**Required to fix:**
- Derive salt from the `identity_pub_key` (already a unique per-user value in
  the genesis block)
- Or store a random 16-byte salt generated at `phpoc init` time alongside
  `recovery_seed_enc`
- Update the justification in the spec

**Estimated effort:** Low — changes one constant to a derivation. Requires
  migration for existing ledgers (re-encrypt recovery seed with new salt).

---

#### I-06: `content_hash` Is Optional — Two-Tier Integrity Model (Flaw #3)

**Summary:** The content hash is described as "optional." Entries without
`content_hash` have zero integrity protection that survives re-encryption. If
keys are rotated (which the protocol doesn't support yet — see I-01), entries
without content hashes become unverifiable. The spec says verification "should
skip if absent" — this is a gap, not a feature.

**What breaks:** Any tooling or migration that omits `content_hash` silently
degrades integrity. An attacker who compromises a key and re-encrypts entries
without content hashes leaves no detectable trace (the entry hash changes, but
there's no cross-check). Implementers have no clear requirement — "optional"
means "you can skip it and still claim compliance."

**Where documented:** PHPSPEC §5.5, ADR-005, DESIGN_GOALS §1

**Required to fix:**
- Make `content_hash` required for all entries created at `format_version >=
  0.4.0`
- Enforcement in verification: entries missing content_hash at v0.4.0+ should
  fail verification
- Phase out the "skip if absent" behavior — it's legacy-only

**Estimated effort:** Low — change a boolean check in verification code. Requires
  format version gating.

---

#### I-07: `format_version` in Block Seal — Every Migration Is a Chain Rewrite (Flaw #4)

**Summary:** `format_version` is included in the HMAC seal computation. Changing
it invalidates the genesis block's seal, which cascades through every block in the
chain. The v0.3→v0.4 migration rewrites the entire ledger — every seal, every
prev_hash, every entry hash — even though no user data changed. ADR-011 describes
this as deliberate to make the version "cryptographically binding."

**What breaks:** Post-migration and pre-migration chains have completely different
hashes for identical content — audit-hostile by design. A verifier cannot confirm
that "this migrated chain corresponds to that original chain" without running the
same migration. Every format bump is a chain-level event with full rewrite cost.

**Where documented:** PHPSPEC §9.3, ADR-011

**Required to fix:**
- Exclude `format_version` from the seal computation — it's metadata
- Keep format version as a plain field in genesis for detection
- If cryptographic binding is desired, include version in the identity seal
  instead of the block seal (identity seal is already optional)

**Estimated effort:** Medium — changes block sealing logic. Existing ledgers keep
  their current seals (format_version was already included, so removing it from
  new seals would mean old blocks still have the old seal — this is fine, each
  block verifies with its own sealing rules).

---

#### I-08: The Spec Is Less Honest Than the ADRs (New Finding #14)

**Summary:** The companion design documents are straightforward about weaknesses.
ADR-003: *"This is not real asymmetric cryptography."* ADR-008: the blind index
*"leaks activity titles and daily totals."* ADR-009: staging is a *"plaintext
scratchpad."* The PHPSPEC uses euphemisms: *"proxy for Ed25519,"* *"trade-off for
fast queries,"* *"viewed without authentication."* A standards-track format
specification should be the most honest document in the project — not the least.

**What breaks:** The document labeled "Format Specification" is the one
implementers will read first (and maybe only). They get a sanitized version of the
truth. The real assessment is scattered across ADRs and design goals — documents
an implementer has no reason to consult.

**Where documented:** Throughout PHPSPEC.md vs. ADR-003, ADR-008, ADR-009

**Required to fix:**
- Audit the PHPSPEC for euphemisms and replace with technical honesty
- Add a "Known Limitations" section at the top of the spec linking to this
  document
- Where a trade-off is documented in an ADR, the spec should at minimum include
  a cross-reference

**Estimated effort:** Low — editorial pass on the spec.

---

### Medium

#### I-09: Device Attribution Is Key-Derived, Not Hardware-Bound (Flaw #8)

**Summary:** Device IDs and device secrets are both derived from the Master Key
via HMAC. Any device holding the MK can produce any device ID and forge any device
proof. The "mismatch → re-auth" dance in §8.5 is circular — all devices sharing
the MK compute the same device ID. The abstract interface for TPM/biometric/hardware
providers is aspirational text with no implementation.

**What breaks:** In a multi-device scenario, devices are cryptographically
indistinguishable. A stolen MK lets an attacker impersonate any device. The
security model assumes something the crypto doesn't provide. ADR-022 improves
the cookie mechanism but doesn't change the underlying identity model.

**Where documented:** PHPSPEC §2.8, §8.5, ADR-022

**Required to fix:**
- Derive per-device keys from MK + a device-local secret (UUID4 stored in
  device config, not derivable from MK alone)
- Or drop the pretense: document that device identity is informational until
  hardware binding is implemented per the pluggable interface
- The `AbstractDeviceIdentityProvider` interface exists — use it as the
  mechanism, not an aspiration

**Estimated effort:** Medium — requires device-local secret generation and
  storage, changes to device ID derivation, and migration for existing
  device IDs.

---

#### I-10: Zero-Dependency Claim Is Now False (Flaw #13)

**Summary:** The PHPSPEC §1.1 claims *"The reference implementation uses only
standard library cryptography."* CROSS_PLATFORM explicitly plans a
`phpoc-crypto-core` Rust library using `ring` (BoringSSL) compiled to WASM for
the web app. The CLI stays pure-Python, but the broader system will not be
zero-dependency. The MAP.md Architecture Invariant #1 also asserts "Zero external
dependencies — pure Python stdlib only" which directly contradicts the
cross-platform plan.

**What breaks:** An implementer reading the spec and MAP.md gets a promise the
project is no longer keeping. The invariant needs scoping.

**Where documented:** PHPSPEC §1.1, CROSS_PLATFORM §6, MAP.md Invariant #1

**Required to fix:**
- Update PHPSPEC §1.1: "The CLI reference implementation uses only Python stdlib
  crypto. Cross-platform implementations use a shared Rust crypto core (`ring` /
  BoringSSL)."
- Update MAP.md Architecture Invariant #1: scope to "CLI reference
  implementation"
- Clarify that the *protocol format* has zero external dependencies (you can
  implement it with any crypto library) — but specific implementations may use
  external libraries

**Estimated effort:** Low — documentation fix.

---

#### I-11: Blob Obfuscation Is a Portability Hazard — Spec Doesn't Warn (New Finding #15)

**Summary:** CROSS_PLATFORM §3 rates blob obfuscation as the highest-risk
primitive for cross-platform compatibility: *"Custom algorithm defined in
PHPSPEC.md, no standard library implementation."* The PHPSPEC §8.5 describes the
obfuscation scheme but never flags it as a portability hazard. An implementer
porting the spec to a new platform has no warning that this is the component most
likely to cause interop failures.

**What breaks:** Silent interop bugs when different platforms implement the
obfuscation scheme slightly differently (padding byte values, tier ceiling
rounding, HMAC sub-key derivation order).

**Where documented:** PHPSPEC §8.5, CROSS_PLATFORM §3

**Required to fix:**
- Add a portability warning in PHPSPEC §8.5: "This is the highest-risk primitive
  for cross-platform compatibility. Implementers must use the crypto test vector
  suite to verify correctness."
- Expand `crypto_test_vectors.json` to include blob obfuscation edge cases
  (empty blob, exactly-at-tier-ceiling, class transition)

**Estimated effort:** Low — documentation + test vector expansion.

---

#### I-12: Spec Is Underspecified for the System Being Built (New Finding #16)

**Summary:** DESIGN_GOALS describes exporting verifiable chain segments, team
dashboards, social proofs, SaaS features, and notification systems.
CROSS_PLATFORM describes a multi-platform ecosystem. ARCHITECTURAL_DECISIONS
has 23 ADRs. The PHPSPEC covers block structure, encryption, chain validation,
blind index, and staging format. The spec is the narrowest document but claims to
be authoritative. The format it defines supports none of the features the design
docs describe.

**What breaks:** There is no single document that describes the full system. The
spec is too narrow. The design docs are too broad. An implementer needs to read
four documents to understand what they're building.

**Where documented:** Gap between PHPSPEC.md scope and DESIGN_GOALS.md /
  CROSS_PLATFORM scope

**Required to fix:**
- The PHPSPEC should remain scoped to the *format* and stay version-locked
- Create a separate SYSTEM_ARCHITECTURE.md that describes the full system at the
  DESIGN_GOALS level
- Cross-reference clearly: "For system-level architecture, see SYSTEM_ARCHITECTURE.md"

**Estimated effort:** Medium — new document creation + cross-reference updates.

---

#### I-13: Architecture Invariant #1 Contradicts Cross-Platform Strategy (New Finding #17)

**Summary:** MAP.md lists "Zero external dependencies — pure Python stdlib only"
as Architecture Invariant #1. CROSS_PLATFORM §6 describes `phpoc-crypto-core` as
a Rust library depending on `ring` (BoringSSL). The invariant is not scoped to
the CLI and is now incorrect for the project as a whole.

**What breaks:** Confusion about what "the project" guarantees. CI/CD might
enforce stdlib-only constraints that reject the WASM builds. New contributors see
conflicting instructions.

**Where documented:** MAP.md Architecture Invariants §1,
  CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md §6

**Required to fix:**
- Rewrite Invariant #1: "CLI reference implementation uses only Python stdlib.
  Web/mobile use a shared Rust crypto core compiled via WASM / native libraries."
- Or split into two invariants: "CLI: zero external deps" and "Web/Mobile:
  single shared Rust crypto core"

**Estimated effort:** Low — one line change in MAP.md.

---

#### I-14: Spec Contains Forward-Looking Content (Flaw #11)

**Summary:** The PHPSPEC at v0.3.0 documents v0.4.0 features in present tense
(extensible content hash, migration scripts). It describes migrations that don't
exist in the current version. Implementers must constantly ask "does this feature
exist in the version I'm targeting?"

**What breaks:** Specification authority. A spec that describes future behavior
as present is a design diary, not a spec. The existence of proper ADRs and
ROADMAP.md elsewhere makes this duplication worse — the forward-looking content
should live there, not in the spec.

**Where documented:** PHPSPEC §5.5, §6.1, §9.3

**Required to fix:**
- Remove all forward-looking content from the spec
- Move migration plans to ROADMAP.md or dedicated migration docs
- The spec should describe exactly one version (current)
- Add a prominent "Current Version: v0.3.0. See CHANGELOG.md for upcoming
  changes." header

**Estimated effort:** Low — editorial pass.

---

### Low

#### I-15: AES-128 Justification Is Cryptographically Wrong (Flaw #9)

**Summary:** PHPSPEC §2.6: *"The effective security level is 256 bits (the Master
Key entropy), with per-operation key diversification."* This conflates key
derivation entropy with block cipher security margin. The per-operation key is
truncated to 128 bits — HMAC derivation doesn't imbue the truncated output with
256-bit security. AES-128 is fine in practice, but wrong reasoning in a crypto
spec is a red flag.

**What breaks:** An implementer might apply the same wrong reasoning to truncate
other derived values (integrity key, identity secret) below their required
security margins.

**Where documented:** PHPSPEC §2.6

**Required to fix:**
- Either switch to AES-256 (derive full 32-byte key) for consistency
- Or correct the justification: "We use AES-128 because it provides adequate
  security against known attacks. The per-operation HMAC derivation ensures
  uniformly distributed key material from the 256-bit Master Key."

**Estimated effort:** Trivial — text fix.

---

#### I-16: Duplicate Paragraph in §9.3 (Flaw #10)

**Summary:** The paragraph about upgrading ledgers from v0.2.0 appears verbatim
twice, back-to-back. Editorial error.

**What breaks:** Nothing functionally. But a spec with a copy-paste error visible
on a casual read undermines confidence in the cryptographic pseudocode accuracy.

**Where documented:** PHPSPEC §9.3 (two identical paragraphs before migration
  pseudocode)

**Required to fix:** Delete the duplicate.

**Estimated effort:** Trivial.

---

#### I-17: `day_hash` on Genesis Block Is Misnamed (Flaw #12)

**Summary:** The genesis block's seal field is named `day_hash` — a "historical
convention" in a v0.3.0 spec. Every implementation must carry a mapping of
`type → hash_field_name`. The spec itself says *"implementations should treat
day_hash, year_hash, and month_hash uniformly"* — if they're uniform, they should
be named uniformly.

**What breaks:** Unnecessary implementation complexity. Confusing for new
implementers. A genesis block is structurally not a "day" block — its hash field
name shouldn't imply it is.

**Where documented:** PHPSPEC §4.1, §5.1

**Required to fix:**
- Rename to a uniform field: `seal` or `block_hash` across all block types
- Or at minimum rename genesis to use `genesis_hash`
- This is technically a format change — requires version bump if the field name
  is part of the seal computation (it is)

**Estimated effort:** Low — rename in spec, code, and tests. Minor format version
  bump if field name is sealed.

---

## Summary by Severity

| ID | Severity | Title | Effort |
|----|----------|-------|--------|
| I-01 | 🔴 Critical | No key rotation — one key forever | High |
| I-02 | 🔴 Critical | Blind index is plaintext | Medium |
| I-03 | 🔴 Critical | Staging on-disk data is not encrypted | Medium |
| I-04 | 🟠 High | HMAC called "signature" | Low |
| I-05 | 🟠 High | Fixed PBKDF2 salt | Low |
| I-06 | 🟠 High | content_hash is optional | Low |
| I-07 | 🟠 High | format_version in block seal | Medium |
| I-08 | 🟠 High | Spec less honest than ADRs | Low |
| I-09 | 🟡 Medium | Device attribution is key-derived | Medium |
| I-10 | 🟡 Medium | Zero-dependency claim is false | Low |
| I-11 | 🟡 Medium | Blob obfuscation portability hazard | Low |
| I-12 | 🟡 Medium | Spec underspecified for system scope | Medium |
| I-13 | 🟡 Medium | Architecture invariant #1 contradiction | Low |
| I-14 | 🟡 Medium | Spec contains forward-looking content | Low |
| I-15 | 🟢 Low | AES-128 justification is wrong | Trivial |
| I-16 | 🟢 Low | Duplicate paragraph in §9.3 | Trivial |
| I-17 | 🟢 Low | day_hash misnamed on genesis | Low |

**Total: 17 issues** — 3 Critical, 5 High, 6 Medium, 3 Low

---

## Dependency Graph

Some issues block or depend on others:

```
I-01 (key rotation) ◀── I-06 (content_hash optional) — content_hash was designed
     │                    for re-encryption survival but has no use case until
     │                    key rotation exists
     │
     └── I-03 (staging encryption) — if staging is encrypted with MK today,
          rotating MK requires re-encrypting staging too

I-04 (HMAC→signature rename) ◀── DESIGN_GOALS §1 (Ed25519 planned)
     │                              — the rename should happen before Ed25519 is
     │                                implemented, not after
     │
     └── I-07 (format_version in seal) — if the seal field is renamed as part
          of fixing I-04, exclude format_version at the same time

I-10 (zero-dependency false) ──▶ I-13 (invariant #1 contradiction)
                                  — fix both together

I-14 (forward-looking content in spec) ──▶ I-12 (underspecified spec)
                                            — removing forward-looking content
                                              reveals how narrow the spec is
```

---

## Recommended Attack Order

If resources are limited, address issues in this order for maximum impact per
unit of effort:

1. **Documentation triage (Low effort, high clarity):** I-15, I-16, I-08,
   I-10, I-13, I-14 — fix the spec's honesty, remove the duplicate, correct
   the zero-dependency claim and architecture invariant, remove forward-looking
   content. ~3 hours total. Makes the spec trustworthy.

2. **Naming fixes (Low effort, cascading):** I-04 (rename signature→seal),
   I-17 (rename day_hash→seal or genesis_hash). ~2 hours plus test updates.
   Fix terminology before anyone else implements against the misleading names.

3. **Salt fix (Low effort, real security):** I-05 (per-user PBKDF2 salt).
   ~1 hour plus migration for existing ledgers.

4. **Integrity fixes (Low effort, medium impact):** I-06 (make content_hash
   required). ~1 hour plus verification logic change.

5. **Platform warnings (Low effort, prevents future bugs):** I-11 (blob
   obfuscation warning + test vectors). ~2 hours.

6. **Encryption gaps (Medium effort, closes real holes):** I-02 (encrypt blind
   index) and I-03 (encrypt staging at rest). ~1 week each.

7. **Architectural fixes (High effort, long-term):** I-01 (key rotation),
   I-07 (format_version in seal), I-09 (device attribution), I-12 (system
   architecture doc). These require design work before implementation.

---

## Tracking

Each issue should eventually get its own ADR or planning document. When an issue
graduates from discovery to planning, update this table:

| Issue | Status | ADR / Plan | Target Version |
|-------|--------|------------|----------------|
| I-01 | 🔴 Open | — | — |
| I-02 | 🔴 Open | — | — |
| I-03 | 🔴 Open | — (see ADR-015 for related D2 direction) | — |
| I-04 | 🟠 Open | — | — |
| I-05 | 🟠 Open | — | — |
| I-06 | 🟠 Open | — | — |
| I-07 | ✅ Fixed | ROADMAP (Canonical Ledger Format) | v0.4.0 (2026-07-03) |
| I-08 | 🟠 Open | — | — |
| I-09 | 🟡 Open | — | — |
| I-10 | 🟡 Open | — | — |
| I-11 | 🟡 Open | — | — |
| I-12 | 🟡 Open | — | — |
| I-13 | 🟡 Open | — | — |
| I-14 | 🟡 Open | — | — |
| I-15 | 🟢 Open | — | — |
| I-16 | 🟢 Open | — | — |
| I-17 | ✅ Fixed | ROADMAP (Canonical Ledger Format) | v0.4.0 (2026-07-03) |
