# PHPSPEC Design Flaws — Brutally Honest Assessment

> **Source document:** `docs/spec/PHPSPEC.md` v0.3.0
> **Assessment date:** 2026-07-01
> **Reassessment date:** 2026-07-01 (after reading DESIGN_GOALS.md, ARCHITECTURAL_DECISIONS.md, CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md)

This document catalogs conflicts, weaknesses, and negative aspects of the PHPSPEC
as currently specified. No softening. No "on the other hand." Just the problems.

The §14 addendum below reassesses every flaw against the three companion design
documents. The companion docs are more honest about several of these weaknesses —
but honesty about a flaw doesn't make it stop being a flaw.

---

## 1. HMAC Is Called a "Signature" — It's Not

**§2.7:** *"The current identity system uses HMAC-SHA256 as a proxy for Ed25519
to remain zero-dependency."*

This is cryptographic dishonesty. An HMAC is a symmetric MAC. Anyone who holds the
`identity_secret` can both "sign" and "verify." There is no asymmetric property.
You cannot hand a block to a third party and prove authorship without also handing
them the power to forge new blocks in your name.

The spec uses the word "signature" 40+ times and names the field `signature`.
Calling a MAC a "signature" is not a simplification — it's a lie dressed in jargon.
The "zero-dependency" excuse is weak: Ed25519 is implementable in ~50 lines of
Python using nothing but `hashlib` (SHA-512). The choice is defensible. Calling it
a "signature" is not.

**Impact:** Any implementer who reads this spec and later encounters real Ed25519
will have been trained on false terminology. Any third-party verifier who receives
a block with a "signature" will be misled about what security properties they
actually have.

**Fix:** Call it a `seal` or `tag`. Rename the field. Stop pretending HMAC is a
signature.

---

## 2. Fixed PBKDF2 Salt `b"session-salt"` Is a Real Anti-Pattern

**§2.4:** *"The salt is fixed (not per-user) because the PDK only protects the
Seed, which is itself encrypted and stored inside the ledger. A per-user salt
would add no security here — the KDF work factor (600K iterations) is the
protection."*

This justification is wrong. The Seed has 256 bits of entropy — agree. But the
**passphrase does not**. If two users choose `"correct horse battery staple"`,
they produce identical PDKs from `b"session-salt"`. An attacker who builds a
rainbow table for common passphrases against this fixed salt breaks all users
simultaneously.

Per-user salt costs nothing. You already store a genesis block — derive the salt
from the `identity_pub_key` or a random nonce stored alongside the encrypted seed.
The claim that "the KDF work factor is the protection" ignores that salts exist
precisely because KDF work factors are a speed bump, not a wall.

**Impact:** Cross-user precomputation attacks are enabled. Low in practice for
high-entropy passphrases, but the reasoning in the spec is actively incorrect and
would teach bad practice to any implementer.

**Fix:** Make the salt per-user. Derive it from the identity public key, or store
a random salt value in the genesis block alongside `recovery_seed_enc`.

---

## 3. `content_hash` Is Optional — Two-Tier Integrity

**§5.5:** *"The content hash is an optional integrity check that survives
re-encryption."*

Being optional means entries without `content_hash` have zero integrity protection
that survives re-encryption. If you rotate keys or re-encrypt entries (the exact
scenario `content_hash` was designed for), entries without it have their
`entry.hash` changed (because ciphertext changed) with no fallback integrity check.
You're building a two-tier system: some entries are verifiably unaltered, others
are just... assumed correct.

**§5.5:** *"If content_hash is absent, skip this check (legacy entries)."* That's
not a feature — it's a gap papered over with a field name.

**Impact:** Any tooling or migration that removes or skips `content_hash` silently
degrades the integrity model. An attacker who compromises a key and re-encrypts
entries without `content_hash` leaves no detectable trace.

**Fix:** Make `content_hash` required for all new entries. Phase out the
"optional" status. If backward compatibility is needed, enforce it via
`format_version` — v0.4.0+ ledgers must have content hashes on every entry.

---

## 4. `format_version` in the Block Seal Makes Every Migration a Chain Rewrite

**§9.3:** `format_version` is included in the HMAC seal computation. This means
adding or changing the version field invalidates the genesis block's seal, which
changes its `day_hash`, which changes the next block's `prev_hash`, which changes
*its* seal… a full cascade rewrite of every block in the chain.

The v0.3→v0.4 migration literally rehashes the entire ledger. For what? A version
string that could have been excluded from the seal. You made a metadata field
cryptographically binding, turning every format evolution into a chain-level event
where the resulting ledger is a completely different artifact (different hashes)
even though no user data changed.

**Impact:** Every migration requires a full-chain rewrite. This makes migrations
expensive, risky, and audit-hostile — the post-migration chain has completely
different hashes from the pre-migration chain, making it impossible for a
verifier to confirm that "this migrated chain corresponds to that original chain."

**Fix:** Exclude `format_version` from the seal computation. It's metadata, not
content.

---

## 5. No Forward Secrecy. No Key Rotation. One Key Forever.

The Master Key protects every block, past and future, for all time. If the MK is
compromised tomorrow, every entry ever written (and every entry yet to be written)
is exposed. There is:

- No re-key operation
- No key version field in blocks
- No mechanism to rotate the MK and re-encrypt history under a new key
- No way to read old data under an old key while encrypting new data under a new
  key

The spec mentions content hashes "surviving re-encryption" as a feature, but
provides zero machinery to actually *perform* re-encryption. It's a property with
no use case because the protocol has no re-encryption workflow.

**Impact:** A single key compromise is catastrophic and permanent. There is no
remediation path.

**Fix:** Add a `key_version` field to blocks. Define a key rotation protocol.
Allow blocks encrypted under different key versions to coexist in the same chain.

---

## 6. The Blind Index Is a Privacy Disaster

**§7.1:** The index stores `{date: {activity_title: total_duration_ms}}` in plain
JSON.

**§7.3:** *"The blind index supports queries without decryption."* Yes, because
it's **not encrypted**. Your ledger encrypts timestamps and metadata with
AES-CTR + HMAC. Then you exfiltrate the activity titles and daily durations into a
separate file with zero protection and name it "blind." It's not blind — it's
naked.

**§7.4** includes code to rebuild the index from the chain by decrypting entries.
**§7, Privacy note:** *"This is the trade-off for fast, no-decryption queries."*
The trade-off is that anyone who touches the file system can see exactly what you
do and for how long. That's not a trade-off — it's a surrender of the ledger's
entire privacy model at the point where it's most likely to be accessed by a
casual observer.

**Impact:** The index file sitting on disk next to the encrypted ledger completely
undermines the encryption. Any local attacker, backup system, or sync tool that
touches `index.json` gets a complete activity log in plain text.

**Fix:** Encrypt the index. Use searchable encryption if "queries without full
decryption" is a hard requirement. At minimum, encrypt the index with the same
Master Key.

---

## 7. `plain:` Prefix in Staging — On-Disk Data Is Not Encrypted

**§8.2:** Staging entries use `"plain:1714000000000"` instead of real ciphertext
so they can be "viewed without authentication."

**§8.4:** Confirms staging is *"Encrypted? No. Authenticated? No (anyone can
read)."*

The spec's opening line promises *"encrypted, self-sovereign ledger format."* The
staging file sitting on disk (`staging.json`) is neither encrypted nor
authenticated. The implementation runs `NoAuthCryptoManager` as a named feature.
The remote blob is encrypted in transit (§8.5), but the local staging file is a
plaintext dump.

This directly contradicts the protocol's first design principle. The most recent,
most sensitive data — your current active tasks, what you're doing right now — is
the least protected.

**Impact:** Anyone with filesystem access can read what tasks are currently
active, paused, or recently completed without any key material.

**Fix:** Encrypt staging entries at rest. The `plain:` prefix is a development
convenience that escaped into the protocol. If you need "view without full
authentication," use a derived viewing key with limited scope.

---

## 8. Device Attribution Is Theater

**§2.8:** Device IDs and device secrets are both derived from the Master Key via
HMAC. Any device that holds the MK can produce any device ID and forge any device
proof.

**§2.8:** *"The same device (same MK) always produces the same device ID."* But
"same MK" is the entire security model, not "same physical device." The identity
is tied to the key, not to the hardware.

**§8.5:** *"Device A auths → derives device ID from MK → compares with remote
blob's device_id_enc. Mismatch? Re-auth."* Since all devices share the same MK
(or else they can't read the same ledger), every device computes the same device
ID. The mismatch condition can never fire. This is circular logic.

**§2.8:** The abstract interface allows "TPM-backed, biometric, hardware-specific"
implementations. This is aspirational text in a spec — there's no concrete
contract, no implementation, and no requirement that real hardware binding be
used.

**Impact:** If two physical devices share a Master Key (the expected multi-device
scenario), they are cryptographically indistinguishable. A stolen Master Key lets
an attacker impersonate any device the user has ever used.

**Fix:** Derive per-device keys from MK + a device-specific secret stored locally
(not derivable from MK alone). Or drop the pretense and admit that device identity
is purely informational until hardware binding is implemented.

---

## 9. AES-128 Justification Is Cryptographically Sloppy

**§2.6:** *"The effective security level is 256 bits (the Master Key entropy),
with per-operation key diversification. The 16-byte AES key is sufficient."*

This conflates key derivation entropy with block cipher security margin. The
per-operation encryption key is **truncated to 128 bits** via `digest()[:16]`.
HMAC derivation does not imbue the truncated output with the input's 256-bit
entropy — the bottleneck is 128 bits, period. AES-128 is probably fine in
practice, but the reasoning as written is wrong. Wrong reasoning in a crypto spec
is a red flag, even when the conclusion happens to be acceptable.

**Impact:** An implementer reading this justification might apply the same (wrong)
reasoning to truncate other derived values, such as the integrity key or the
identity secret, below their required security margins.

**Fix:** Either use AES-256 (full 32-byte key) for consistency with the 256-bit
Master Key, or correct the justification: "We use AES-128 because it provides
adequate security against known attacks and the Master Key's 256-bit entropy
ensures the HMAC-derived key material is uniformly distributed."

---

## 10. Duplicate Paragraph in §9.3 — Editorial Error

The paragraph:

> *"Ledgers created before this spec (implicit v0.2.0) can be upgraded by adding
> format_version to genesis. Because format_version is included in the block seal,
> adding it changes day_hash, which cascades through the entire chain:"*

Appears **verbatim twice**, back-to-back, before the migration pseudocode block.
This is a copy-paste error visible on a casual read. If the spec has an editorial
error this obvious, what subtler errors are hiding in the cryptographic
pseudocode?

**Fix:** Delete the duplicate.

---

## 11. This Is a Design Diary, Not a Specification

The document is labeled v0.3.0 but:

- Extensively documents v0.4.0 features (extensible content hash, migration
  scripts) in present tense
- The migration from v0.2→v0.3 and v0.3→v0.4 are both documented inline
- Future behavior is described as if it already exists

Real specifications describe what IS, not what WILL BE. This reads like working
notes that got promoted to "specification" prematurely. An implementer reading
this document must constantly ask "does this feature exist in the version I'm
targeting, or is it aspirational?"

**Fix:** Remove all forward-looking content from the spec. Put migration plans,
roadmap items, and future features in separate planning documents. The spec should
describe exactly one version.

---

## 12. `day_hash` on a Genesis Block

**§4.1:** *"The day_hash field name on a genesis block is a historical
convention."*

The spec is v0.3.0. How much "history" is there? You're in the position to name
things correctly and chose to document around a bad name instead of fixing it.

The workaround: *"Implementations should treat day_hash, year_hash, and month_hash
uniformly."* If they're treated uniformly, they should be named uniformly. Call
them all `seal` or `block_hash`.

**Impact:** Every implementation must carry a mapping of `type → hash_field_name`.
A block that is both the genesis block and a "day" block (structurally) has a hash
field named `day_hash`, which is confusing for no reason.

**Fix:** Rename to a single `seal` or `block_hash` field across all block types.
Or at minimum rename genesis to use `genesis_hash`.

---

## 13. Remote Staging Transport Described but Zero-Dependency Claimed

**§1.1:** *"Zero external dependencies. The reference implementation uses only
standard library cryptography."*

**§8.5:** Describes a full remote staging transport with Git, HTTP, and local
network implementations. An `AbstractStagingTransport` interface. Encrypted blobs.
Push/pull semantics.

The *crypto* is zero-dependency. The *system* as described is not. The protocol
specification shouldn't claim "zero external dependencies" when the system it
describes requires network transports, remote storage, and multi-device
coordination infrastructure.

**Fix:** Clarify the claim: "Zero external cryptographic dependencies." The
transport layer is outside the protocol's scope and implementations may use any
transport they choose.

---

## Summary

The core cryptographic primitives (AES-CTR + HMAC encrypt-then-MAC, PBKDF2, chain
hashing) are individually sound. The problems are architectural and presentational:

| # | Category | Severity |
|---|----------|----------|
| 1 | HMAC called "signature" | **High** — misleads implementers and users about security properties |
| 2 | Fixed PBKDF2 salt | **Medium** — enables cross-user precomputation, incorrect justification |
| 3 | Optional content_hash | **Medium** — degrades integrity model, two-tier verification |
| 4 | format_version in seal | **Medium** — makes migrations into full chain rewrites |
| 5 | No key rotation | **High** — single point of permanent, irrecoverable failure |
| 6 | Unencrypted blind index | **High** — undermines the entire privacy model at the most exposed point |
| 7 | Unencrypted staging | **High** — contradicts the protocol's first design principle |
| 8 | Device attribution theater | **Low** — doesn't break anything, but doesn't work as described either |
| 9 | Sloppy AES-128 reasoning | **Low** — conclusion is fine, but reasoning is wrong |
| 10 | Duplicate paragraph | **Trivial** — editorial fix |
| 11 | Spec vs. design diary | **Medium** — undermines the document's authority |
| 12 | day_hash naming | **Low** — cosmetic, but unnecessary confusion |
| 13 | Zero-dependency claim scope | **Low** — misleading but easily clarified |

Most of these are fixable without changing the protocol's core value proposition.
Items 5 and 6 require the most architectural rework.

---

## 14. Reassessment After Reading Companion Design Documents

After reading `DESIGN_GOALS.md`, `ARCHITECTURAL_DECISIONS.md`, and
`CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md`, each flaw is reassessed below.
The companion docs change some assessments — but in several cases they make
things **worse**, not better.

### Per-Flaw Reassessment

| # | Flaw | Companion Docs Say… | Verdict |
|---|------|---------------------|---------|
| 1 | HMAC called "signature" | **Partially mitigated.** DESIGN_GOALS §1 and ADR-003 both explicitly acknowledge: *"This is not real asymmetric cryptography"* and *"Real Ed25519 should replace this when the dep constraint is relaxed."* The design docs are honest about it. **But the PHPSPEC still calls it a 'signature' 40+ times.** An implementer who reads only the spec (the document they're supposed to trust) gets the lie. The honesty is in a different building. | **Severity unchanged.** The ADR's honesty doesn't fix the spec's dishonesty. |
| 2 | Fixed PBKDF2 salt | **Not addressed anywhere.** ADR-004 only covers iteration count (100K→600K). DESIGN_GOALS doesn't mention salt design. The fixed-salt justification in PHPSPEC §2.4 stands unrebutted and unacknowledged. | **No change.** |
| 3 | Optional content_hash | **Not addressed.** ADR-005 describes the algorithm change (hardcoded→extensible) but says nothing about whether the field should be required. DESIGN_GOALS §1 lists content hashes as a feature but doesn't address the two-tier integrity gap. | **No change.** |
| 4 | format_version in seal | **Partially mitigated.** ADR-011 explicitly describes this as a deliberate decision — the cascade rewrite is a known cost of making `format_version` cryptographically binding. The migration scripts handle it. The architects chose this. **But the cost is real:** every format bump rewrites the entire chain. Post-migration and pre-migration chains have different hashes for identical content — audit-hostile by design. | **Severity unchanged.** Deliberate doesn't mean good. |
| 5 | No key rotation | **Not addressed.** ADR-001 describes the sovereign key model in detail. No ADR discusses rotating keys, forward secrecy, or re-encrypting the chain. The content hash was designed to "survive re-encryption" but the spec provides no actual re-encryption mechanism. | **No change.** This is the biggest architectural gap in the entire protocol and nobody has written an ADR for it. |
| 6 | Unencrypted blind index | **Partially mitigated — but the honesty makes it worse.** ADR-008 explicitly says: *"The index leaks activity titles and daily totals. Acceptable — this is what the user sees in the CLI anyway."* The ADR is upfront that this is a privacy leak. DESIGN_GOALS §2 says *"Blind Indexing is used to allow reputation queries without exposing exact timing."* The claim that it doesn't expose "exact timing" is true — but it exposes everything else. The PHPSPEC buries this as a one-line privacy note. The ADR calls it out. **The fundamental problem hasn't changed — the index file is plaintext and undermines the ledger's encryption.** The ADR just admits it more clearly. | **Severity unchanged.** |
| 7 | Unencrypted staging | **Partially mitigated — known trade-off with planned fix.** ADR-009 explicitly frames this as a UX decision: *"Quick capture without auth is the primary UX requirement."* ADR-015 (D2 design direction) plans encrypted multi-device staging with session cookies and sequence numbers. The architects know this is temporary and have a plan. **But the plan is not implemented.** Today, `staging.json` on disk is plaintext. Tomorrow, it will still be plaintext until D2 ships. The PHPSPEC buries this detail; the ADRs don't. | **Severity unchanged** until D2 is implemented. But the honesty of the ADRs reduces the "gotcha" factor. |
| 8 | Device attribution theater | **Not addressed — and CROSS_PLATFORM makes it worse.** ADR-022 improves the device cookie mechanism (deterministic HMAC fast-path) but doesn't change the underlying model: device identity is derived from MK, not hardware. CROSS_PLATFORM §5 plans a Rust crypto library where device identity will be a compiled binary — still purely key-derived, still not hardware-bound. The "theater" characterization holds. | **No change.** |
| 9 | Sloppy AES-128 reasoning | **Not addressed.** The Rust crypto library (CROSS_PLATFORM §6) will use `ring` (BoringSSL), which handles AES correctly — but this dodges rather than fixes the flawed justification in the spec. The spec's wrong reasoning about "256-bit effective security from a 128-bit key" is still there, waiting to mislead a future implementer. | **No change.** |
| 10 | Duplicate paragraph | **Still there.** | **No change — trivial editorial fix.** |
| 11 | Spec vs. design diary | **The companion docs make this WORSE.** The ADR documents and DESIGN_GOALS.md prove that proper architectural documentation exists elsewhere. The PHPSPEC.md duplicates forward-looking content (v0.4.0 features, migration plans) that should live in ADRs and roadmaps. The spec should be a crisp, version-locked format reference. Instead it's a dumping ground. **The existence of better docs elsewhere makes the spec's disorganization more obvious, not less.** | **Severity unchanged.** |
| 12 | day_hash naming | **Not addressed.** | **No change.** |
| 13 | Zero-dependency claim | **CROSS_PLATFORM makes this WORSE — significantly.** The cross-platform strategy explicitly plans a Rust crypto library (`phpoc-crypto-core`) using `ring` (audit-grade BoringSSL bindings). The CLI stays pure-Python, but the broader system will NOT be zero-dependency. The PHPSPEC §1.1 claim *"The reference implementation uses only standard library cryptography"* is already misleading (the transport layer requires Git, SSH, or HTTP). With the cross-platform plan, it becomes outright false for web/mobile. **The spec should say: 'The CLI reference implementation uses only Python stdlib crypto. Cross-platform implementations use a shared Rust crypto core.'** | **Severity raised from Low to Medium.** The claim is now provably wrong for the multi-platform system the project is building. |

### New Observations (Not in Original Assessment)

These emerged only after reading all four documents together:

**14. The honesty gap between spec and ADRs is a documentation quality failure.**

ADR-003 calls HMAC "not real asymmetric cryptography." ADR-008 says the blind
index "leaks activity titles and daily totals." ADR-009 calls staging a
"plaintext scratchpad." These are honest assessments. The PHPSPEC.md uses
euphemisms: "proxy for Ed25519," "trade-off for fast queries," "viewed without
authentication." An implementer who reads only the spec gets a sanitized version
of the truth. The honest version exists — but not in the document labeled
"Format Specification." The spec should be the most honest document in the
project, not the least.

**15. Blob obfuscation is flagged as the highest-risk primitive — but the spec
doesn't warn about it.**

CROSS_PLATFORM §3 explicitly calls blob obfuscation *"High — custom algorithm
defined in PHPSPEC.md, no standard library implementation"* as a risk for
cross-platform compatibility. The PHPSPEC.md describes the obfuscation scheme
(§8.5) but never flags it as a portability hazard. The spec is missing a warning
that the companion docs consider critical.

**16. The PHPSPEC is underspecified for the system the design docs describe.**

DESIGN_GOALS.md describes exporting verifiable chain segments, team dashboards,
social proofs, SaaS features, and a notification system. CROSS_PLATFORM describes
a multi-platform ecosystem with a shared Rust crypto core. ARCHITECTURAL_DECISIONS
has 23 ADRs spanning key management, sync, transport, and configuration. The
PHPSPEC.md covers: block structure, encryption, chain validation, blind index,
and staging format. The gap between what the spec defines and what the system
aspires to be is enormous. The spec is the narrowest document in the project but
claims to be the authoritative one.

**17. Architecture Invariants in MAP.md contain contradictions.**

The MAP.md lists "Zero external dependencies — pure Python stdlib only" as
Architecture Invariant #1. CROSS_PLATFORM explicitly contradicts this for the
web/mobile targets. The invariant should be scoped to the CLI reference
implementation only, or the invariant needs to change.

### Bottom Line After Reassessment

The companion documents do not change the severity of any flaw. They:

- **Mitigate** flaws #1, #4, #6, #7 by being honest about the trade-offs
  (while the PHPSPEC.md is not)
- **Worsen** flaw #13 by proving the zero-dependency claim is false for the
  system being built
- **Reveal** three new concerns (#14–#16) about documentation quality and scope
- **Leave** flaws #2, #3, #5, #8, #9, #10, #11, #12 completely unaddressed

The design docs are better documents than the spec is. That's the real problem.
