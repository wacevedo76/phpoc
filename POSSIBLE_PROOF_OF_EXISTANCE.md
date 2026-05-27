# Proof of Existence — External Anchoring & Asymmetric Signatures for phpoc

> **Question:** Can a ledger be made resistant to AI fabrication of entries?
>
> **Short answer:** The existing phpoc chain integrity (prev_hash, seals, content_hash, entry hashes) prevents tampering *after* recording, but cannot distinguish real data from AI-fabricated data at creation time. Two additions close this gap:
> 1. **External anchoring** — proves data existed before a real-world time
> 2. **Asymmetric signatures** — proves authorship without sharing the private key

---

## Table of Contents

- [1. The Problem](#1-the-problem)
- [2. External Anchoring Methods](#2-external-anchoring-methods)
  - [Decentralized / Blockchain-based](#decentralized--blockchain-based)
  - [Centralized / TSA-based](#centralized--tsa-based)
  - [Hybrid / Emerging](#hybrid--emerging)
  - [Comparison Table](#comparison-table)
- [3. Asymmetric Signature Methods](#3-asymmetric-signature-methods)
  - [Ed25519](#ed25519-the-obvious-choice)
  - [Implementation Options](#implementation-options)
  - [Other Asymmetric Schemes](#other-asymmetric-schemes)
- [4. Putting It Together](#4-putting-it-together)
  - [Full Verification Architecture](#full-verification-architecture)
  - [Minimal Viable Upgrade](#minimal-viable-upgrade)
- [5. Legal Context (2025)](#5-legal-context-2025)

---

## 1. The Problem

phpoc's current cryptography guarantees:

| Property | Guaranteed? | Mechanism |
|----------|:-----------:|-----------|
| **Integrity** (data unchanged since recording) | ✅ Yes | prev_hash chain, HMAC seals, entry hashes, content_hash |
| **Non-repudiation** (only key holder could have signed) | ✅ Partial | HMAC-SHA256 identity signature (symmetric — same key signs and verifies) |
| **Authenticity** (data corresponds to real-world events) | ❌ No | No external witness, no timestamp authority, no consensus |
| **Timestamp truth** (entry was created when claimed) | ❌ No | Timestamps are encrypted and self-attested — an AI can set any value |

**Two additions fix this:**
1. **External anchoring** — anchor block hashes to a public, immutable source of time
2. **Asymmetric signatures** — replace HMAC with Ed25519 so the public key can be shared without exposing the signing key

---

## 2. External Anchoring Methods

These prove your ledger block existed at or before a specific real-world time.

### Decentralized / Blockchain-based

#### 1. OpenTimestamps (Bitcoin)

The gold standard for trust-minimized timestamping. Aggregates many hashes into a Merkle tree, submits the root to a Bitcoin OP_RETURN.

```
Your ledger block hash
        ↓
OTS calendar (aggregates many hashes into a Merkle tree)
        ↓
Merkle root submitted to Bitcoin OP_RETURN
        ↓
Confirmed in Bitcoin block N at time T
```

**Python library:** `pip install opentimestamps`

**Pros:**
- Trustless — the Bitcoin proof-of-work chain is the anchor
- Free to create timestamps (calendar services batch-submit)
- ~$0.0001 per timestamp (amortized across batch)
- Python library exists and is well-maintained

**Cons:**
- Verification requires a Bitcoin node (pruned node ~10 GB works)
- ~1–6 hour wait for confirmation (timestamps are "pending" until then)
- The `.ots` proof file must be stored alongside the ledger

**phpoc integration sketch:**
```python
from opentimestamps import Timestamp, ots

def anchor_last_block(ledger_path: Path) -> str:
    ledger = json.loads(ledger_path.read_text())
    last_block = ledger[-1]
    block_hash = last_block.get("day_hash") or last_block.get("month_hash")

    timestamp = Timestamp.from_bytes(block_hash.encode())
    timestamp = ots.stamp(timestamp)
    ots_path = ledger_path.with_suffix(".ledger.ots")
    ots_path.write_bytes(timestamp.serialize())
    return f"Anchored to OTS, proof at {ots_path}"
```

---

#### 2. Direct Bitcoin OP_RETURN

Submit a single Bitcoin transaction with the block hash in an OP_RETURN output.

```
Ledger day_hash → Bitcoin tx with OP_RETURN containing the hash
```

**Pros:**
- Permanent on the most secure blockchain
- Entirely self-sovereign (no calendar service dependency)
- Immediate on-chain proof once mined

**Cons:**
- ~$5–50 per transaction (depending on fee market)
- Requires running a Bitcoin node or using a wallet API
- 10–60 min confirmation time

**Best for:** Anchoring a full day/week/month block rather than each individual entry.

---

#### 3. Ethereum / L2 Anchoring

Submit the block hash as calldata in an Ethereum transaction (L1 or L2).

**Pros:**
- Faster than Bitcoin (~12 sec L1, ~1 sec L2)
- Cheaper on L2 ($0.01–0.10)
- Smart contract can maintain a registry of hashes

**Cons:**
- Less battle-tested than Bitcoin for pure timestamping
- L2 depends on L1 security (bridges can fail)
- Gas prices fluctuate

---

#### 4. Kaspa (kasTime)

A PoW blockchain with sub-second finality via blockDAG architecture.

**Pros:**
- Sub-second confirmation (fastest option)
- Pure PoW (no staking, no slashing)
- Batch aggregation via Merkle trees

**Cons:**
- Smaller ecosystem, less battle-tested
- Python integration is immature
- Token price volatility affects costs

---

### Centralized / TSA-based

These rely on a trusted third party. Simpler, but you trust their clock and signing key.

#### 5. RFC 3161 Timestamp Authority (TSA)

The internet standard for trusted timestamps. Send a hash, receive a signed PKCS#7/CMS token.

```
Ledger hash → TSA → Signed timestamp token (PKCS#7/CMS)
                ↑
          Trusted timestamping authority
```

**Free TSAs:**
- **freetsa.org** — free, accepts `.tsq` files, returns `.tsr` tokens
- **Stamper** (itconsult.co.uk) — free since 1995, RFC 3161 + PGP
- **sigstore/timestamp-authority** — open source, can self-host

**Paid TSAs:**
- **DigiStamp** — ~$20/yr, audited, commercially accepted
- **GlobalSign** — ~$200/yr, enterprise-grade

**Pros:**
- Instant (no blockchain confirmation delay)
- Legally recognized in many jurisdictions (eIDAS in EU)
- Tiny proof file (1–2 KB)
- Many free options exist

**Cons:**
- Must trust the central authority's clock and key
- TSA could go out of business → proof unverifiable unless you also anchor the TSA cert chain
- Some free TSAs have questionable reliability

---

#### 6. OriginStamp

Commercial service anchoring to both Bitcoin and Ethereum.

**Pros:**
- Simple REST API
- Dual-anchors to two chains
- Free tier available (limited timestamps/month)
- Files never leave your device (hash only)

**Cons:**
- Centralized service
- Free tier is rate-limited
- Verification depends on their platform or the underlying blockchains

---

### Hybrid / Emerging

#### 7. C2PA / Content Credentials

For anchoring *media* (photos, video, audio) that backs up ledger claims. Device hardware signs the media with timestamp + GPS.

```
Phone camera → C2PA manifest (device HW signs {photo, time, GPS})
                     ↓
Ledger entry includes C2PA manifest hash
```

**Python library:** `c2pa-python` (official spec implementation)

**Pros:**
- Cryptographic chain from hardware to media to ledger
- Being adopted by Adobe, Google, Apple, Leica, Nikon
- Legally relevant (EU AI Act references provenance)
- Verifiable without any blockchain

**Cons:**
- Only works for media files
- Trusts the device manufacturer's root CA
- Spec still evolving (v2.x as of 2025)

---

#### 8. IPFS + Filecoin

Store block data on IPFS, anchor the CID on Filecoin (proof-of-storage over time).

**Pros:**
- The actual block data is stored, not just a hash
- Proof-of-replication verifies storage over time
- Decentralized storage + timestamping in one

**Cons:**
- Expensive for small data ($ per GiB per month)
- Complex setup
- Overkill for just a hash

---

### Comparison Table

| Method | Trust Model | Cost | Confirmation Time | Verification Difficulty | PHPOC Integration Effort |
|--------|:-----------:|:----:|:-----------------:|:----------------------:|:------------------------:|
| **OpenTimestamps** | Trustless (BTC PoW) | ~$0 | 1–6 hours | Medium (needs BTC node or calendar) | ~20 lines |
| **Direct BTC OP_RETURN** | Trustless | $5–50 | 10–60 min | Easy (any BTC explorer) | ~30 lines + BTC wallet |
| **Ethereum/L2 calldata** | Trustless | $0.01–0.10 | 12 sec (L1) / 1 sec (L2) | Medium | ~30 lines + web3 lib |
| **Kaspa kasTime** | Trustless | ~$0.01 | ~100 ms | Hard (less mature tooling) | ~40 lines |
| **RFC 3161 TSA** | Centralized (TSA) | Free–$20/yr | Instant | Easy (TSA cert chain) | ~15 lines |
| **OriginStamp** | Centralized service | Free tier | ~24 hours | Easy (their API) | ~10 lines |
| **C2PA media** | Device hardware | Free | Instant | Medium (cert chain verification) | ~40 lines + c2pa-python |
| **IPFS + Filecoin** | Decentralized storage | Varies | Hours | Hard | ~50 lines |

---

## 3. Asymmetric Signature Methods

These prove *who* created the ledger entry without requiring the verifier to hold the signer's private key.

### Ed25519 (the obvious choice)

The current HMAC-SHA256 proxy is symmetric — the same key both signs and verifies. This means:
- To let a third party verify your signature, you must give them your secret key
- Once they have the secret key, they can forge signatures as you

Ed25519 separates these roles:

```python
# Current (HMAC — symmetric)
secret = b"..."  # 32 bytes
signature = hmac.new(secret, data, sha256).hexdigest()      # Uses secret
verified = hmac.compare_digest(signature, expected)          # Also uses secret  ← bad!

# Ed25519 (asymmetric)
private_key = ed25519.from_seed(seed)    # 32 bytes, keep secret
public_key  = private_key.get_verify_key()   # 32 bytes, publish anywhere

signature   = private_key.sign(data)           # Uses private key
verified    = public_key.verify(sig, data)      # Uses public key only  ← good!
```

**Key properties:**
- Private key: 32 bytes (same as existing identity secret)
- Public key: 32 bytes (publishable; derived from private key)
- Signature: 64 bytes per block
- Verification speed: ~70,000 sigs/sec on modern hardware

---

### Implementation Options

| Library | Type | Dependencies | Production-ready? | Notes |
|---------|:----:|:------------:|:-----------------:|-------|
| **`pynacl`** | C binding (libsodium) | libsodium.so | ✅ Yes | Fastest, most audited, well-maintained |
| **`cryptography`** | C binding (OpenSSL) | OpenSSL | ✅ Yes | The standard Python crypto library |
| **`python-pure25519`** | Pure Python | hashlib only | ❌ No (author says so) | Correct but slow + side-channels |
| **`ed25519_compact.py`** | Pure Python | hashlib only | ⚠️ Untested | Single-file, 0-dependency, Python 2 |
| **Roll your own from RFC 8032** | Pure Python | hashlib only | ❌ Hard to get right | Ed25519 has subtle edge cases |

**The phpoc dependency dilemma:** phpoc is currently zero-dependency (pure Python, no pip packages). `pynacl` and `cryptography` both add external C libraries.

**Pragmatic path:** Make it optional:

```toml
# pyproject.toml
[project.optional-dependencies]
ed25519 = ["pynacl"]
```

When `pynacl` is installed, use Ed25519. Fall back to HMAC if not. Add `"signature_scheme": "hmac-sha256" | "ed25519"` to the genesis block's `format_version` field.

---

### Code Change Sketch

The existing `AbstractCryptoManager` from `security/crypto.py` already has the right shape:

```python
class AbstractCryptoManager(ABC):
    @abstractmethod
    def sign(self, data_str: str, identity_secret: bytes) -> str: ...
    @abstractmethod
    def verify_signature(self, data_str: str, signature: str,
                         identity_secret: bytes) -> bool: ...
```

Ed25519 subclass:

```python
from nacl.signing import SigningKey, VerifyKey

class Ed25519CryptoManager(CryptoManager):
    """Extends CryptoManager with Ed25519 signatures."""

    def sign(self, data_str: str, identity_secret: bytes) -> str:
        signing_key = SigningKey(identity_secret)
        return signing_key.sign(data_str.encode()).signature.hex()

    def verify_signature(self, data_str: str, signature: str,
                         public_key_bytes: bytes) -> bool:
        """Uses public key, NOT the secret. Signature is the argument."""
        verify_key = VerifyKey(public_key_bytes)
        try:
            verify_key.verify(data_str.encode(), bytes.fromhex(signature))
            return True
        except nacl.exceptions.BadSignatureError:
            return False
```

The genesis block publishes the public key instead of an encrypted fallback:

```python
# Current genesis (HMAC — secret must be shared for verification)
genesis["identity"] = {
    "identity_pub_key": sha256(identity_secret).hexdigest(),   # not a real pubkey
    "identity_secret_enc_fallback": encrypted_secret,           # exposes secret!
}

# Ed25519 genesis
signing_key = SigningKey(identity_secret)
genesis["identity"] = {
    "identity_pub_key_ed25519": signing_key.verify_key.encode().hex(),  # safe to publish
    # No identity_secret_enc_fallback needed — the secret never leaves the device
}
```

The old `identity_secret_enc_fallback` existed because with HMAC, if you lost the identity file, you couldn't verify signatures. With Ed25519, the public key lives in the genesis block itself — verifiers don't need the secret. This is a **strict upgrade**.

---

### Other Asymmetric Schemes

| Scheme | Key Size (pub/priv) | Sig Size | phpoc fit | Why not |
|--------|:------------------:|:--------:|:---------:|---------|
| **Ed25519** | 32B / 32B | 64B | ✅ Best | — |
| **ECDSA P-256** | 65B / 32B | 64–72B | ⚠️ Possible | Larger keys, slower, more standard complexity |
| **RSA 2048** | 256B / ~1KB | 256B | ❌ No | Way too large, slow signing |
| **BLS12-381** | 48B / 32B | 96B | ❌ No | Requires pairing-friendly curve, niche libraries |
| **Sphincs+ (post-quantum)** | 32B / 64B | ~8KB | ❌ Overkill | Post-quantum not needed yet |

Ed25519 is the clear winner — minimal key size, fast verification, well-audited, widely implemented.

---

## 4. Putting It Together

### Full Verification Architecture

```
┌──────────────────────────────────────────────────────┐
│                   phpoc Ledger                        │
│                                                       │
│  Genesis: { pub_key_ed25519, ... }                    │
│      ↓                                                │
│  Summary blocks (sealed, Ed25519 signed)              │
│      ↓                                                │
│  Day blocks (sealed, Ed25519 signed, content-hashed)  │
│      ↓                                                │
│  Each entry: { content_hash, media[C2PA], ... }      │
└──────────────────────────────────────────────────────┘
         │                             │
         ▼                             ▼
  External Anchor               Asymmetric Proof
  ┌─────────────────┐         ┌───────────────────┐
  │ OpenTimestamps  │         │ Ed25519 pub key    │
  │   ↓              │         │   ↓                │
  │ Bitcoin block N │         │ Anyone can verify  │
  │   ↓              │         │ without knowing    │
  │ "Exists before  │         │ private key        │
  │  block N time"  │         │                    │
  └─────────────────┘         └───────────────────┘
         │                             │
         ▼                             ▼
  ╔════════════════════════════════════════════╗
  ║  Third-party verifier checks:              ║
  ║                                            ║
  ║  1. Ledger chain integrity (prev_hash,     ║
  ║     seals, entry hashes, content hashes)   ║
  ║  2. Ed25519 signatures (was it you?)       ║
  ║  3. OTS/BTC anchor (was it before date?)   ║
  ║  4. C2PA media (was your device there?)    ║
  ╚════════════════════════════════════════════╝
```

### Minimal Viable Upgrade

**Two changes, ordered by impact:**

| # | Change | Adds | Effort | Prevents AI from... |
|:-:|--------|------|:------:|---------------------|
| 1 | **Ed25519 signatures** | Asymmetric authorship proof | ~50 lines + optional pynacl dep | Forging your identity without your private key |
| 2 | **OpenTimestamps anchoring** | External time proof | ~20 lines + opentimestamps dep | Backdating entries to fake timestamps |

**Why these two:**
- Ed25519 turns "I know the secret so I trust it" into "anyone with the public key can verify it's me" — this is the *single most important* cryptographic upgrade for third-party verifiability.
- OpenTimestamps is the cheapest trustless anchoring option — free to create, Bitcoin-secured, well-documented Python library.

Together with the existing chain integrity (prev_hash, seals, content_hash, entry hashes), these make phpoc a genuine proof-of-existence system.

---

## 5. Legal Context (2025)

Several recent developments strengthen the case for blockchain-anchored timestamps:

- **March 2025 — Court of Marseille (France)** recognized blockchain anchoring as admissible evidence of prior creation in a copyright case (EUIPO noted).
- **Upcoming EU eIDAS 2.0 regulation** is expected to give blockchain timestamps more legal weight across the EU.
- **C2PA** is referenced in the EU AI Act as a provenance standard for AI-generated content.
- **RFC 3161** timestamps have been legally recognized in multiple jurisdictions for over a decade.

**Recommendation for maximum legal defensibility:** Anchor to **both** Bitcoin (OpenTimestamps or direct OP_RETURN) for trustless immutability **and** an RFC 3161 TSA for legally recognized timestamps. The TSA token provides immediate proof; the Bitcoin anchor provides permanent, trustless backup.

---

## References

- [OpenTimestamps](https://opentimestamps.org/) — Peter Todd, Bitcoin-anchored timestamping
- [OpenTimestamps Python library](https://github.com/opentimestamps/python-opentimestamps)
- [RFC 3161: Internet X.509 Public Key Infrastructure Time-Stamp Protocol](https://www.rfc-editor.org/rfc/rfc3161)
- [Free TSA (freetsa.org)](https://freetsa.org/)
- [C2PA Technical Specification v2.2](https://spec.c2pa.org/)
- [C2PA Python Library](https://github.com/contentauth/c2pa-python)
- [PyNaCl / libsodium](https://pynacl.readthedocs.io/) — Ed25519 bindings for Python
- [EUIPO — Marseille Court blockchain timestamping ruling (2025)](https://www.euipo.europa.eu/en/law/recent-case-law/he-court-of-marseille-recognised-blockchain-timestamping-as-legitimate-evidence-of-copyright-ownership)
- [Ed25519 — RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)
- [kasTime — Kaspa blockchain timestamping](https://github.com/3lemenoP/kasTime)
- [OriginStamp](https://originstamp.com/)
