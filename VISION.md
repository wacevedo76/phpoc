# Personal History Protocol — A Platform-Free Activity Ledger

> *"Know thyself."* — and let others know *only what you choose.*

---

## The Problem: You Are Not a Dataset

Every social platform you use builds a model of you. They know who you follow, what you click, how long you linger, who your friends are, what you search for, where you've been. They mix all of this into one opaque algorithm — and then sell access to your attention.

What you want from a platform is simple:
- See what your friends and family are doing
- Find people who share your real passions
- Gauge your own growth honestly

What the platform gives you instead is a blender of:
- Ads disguised as content
- Political outrage optimized for engagement
- Products you mentioned once, now haunting your feed
- Certifications from whoever paid for placement

**This mixing isn't a bug. It's the business model.** As long as the platform owns all your data, it will use all of it.

---

## The Idea: A Data Format, Not a Platform

Personal History Protocol (PHPOC) is an **open, encrypted, self-sovereign ledger format** for tracking what you actually do with your time. Not what you scroll. Not what you like. What you *do*.

It is:
- **Local-first.** Your ledger lives on your device. Encrypted. Signed. Chained.
- **Portable.** The same file works on laptop, phone, wearable. No server required.
- **Verifiable.** Every entry is content-hashed and linked into an immutable chain. You can prove you were there without revealing everything.
- **Shareable by design.** You control exactly which parts of your history a platform can see — a date range, a blind index summary, a single activity type.
- **Zero-dependency.** Pure cryptography. No blockchain required. No tokens. No gas fees. Just your sovereign key and your data.

### The Chain

```
Genesis (your identity, sealed)
  └── Year Summary
        └── Month Summary
              └── Day
                    └── Entries (timestamped, content-hashed)
```

Every block is signed. Every entry carries a content hash. The chain is self-validating.

### Blind Indexes

A privacy-preserving summary — durations per activity title — encrypted but queryable without decryption. You can prove consistency ("I've practiced flute 300+ hours this year") without revealing *when* or *what pieces*.

---

## What This Makes Possible

### 1. Friends & Family — Pure, No Ads

Share a read-only view of a specific section of your ledger. The platform sees *only that*. No cross-referencing your practice habits with your family relationships. No injecting ads based on your friends' activity. The feed becomes what it should have always been: **people you care about, sharing what they choose.**

### 2. Finding Your People — By Proof, Not Hashtags

Right now, finding someone who truly shares your passion means:
- Trusting self-declared "I love woodworking" profiles
- Following woodworking hashtags through a haze of sponsored content
- Hoping the algorithm surfaces the right person

With PHPOC: *"Show me people who have logged 500+ hours of woodworking practice over the past 2 years."* The answer is based on **verifiable ledger segments**, not claims. You find people who *actually do the thing* — at your level, above your level, or just starting out — without a platform deciding who you should meet.

### 3. Reputation Without Certification Gatekeepers

Certifications test once. A ledger tests every day.

- *"I have 3,000 hours of logged, dated, content-hashed practice across 4 years of consistent work."*
- A potential collaborator verifies a signed range (timestamps only, no private notes).
- **Before hiring, before collaborating, before mentoring** — you verify consistency, not claims.

This doesn't replace formal certification. It **accompanies** it: "I have the credential, and here's the proof that I live it daily."

### 4. Gauging Your Standing — Honest Comparisons

- *"People at 500–700 hours of consistent guitar practice average 4 sessions/week at 38min/session."*
- *"At my current pace, projected to reach 1000 hours in 14 months."*
- *"Your consistency score is in the top 15% for your skill range."*

All anonymized. All opt-in. No platform mines this data — you choose to contribute to aggregate metrics that help everyone grow.

---

## The Separation That Matters

```
Without PHPOC:

  Your data ──▶ Platform
                    │
                    ├──▶ Your friends' content
                    ├──▶ Algorithmic predictions
                    ├──▶ Ads based on your friends
                    ├──▶ Political outrage
                    └──▶ Products you mentioned once


With PHPOC:

  Your device ───▶ Practice ledger ──▶ Platform sees only your practice
                ▶ Family journal  ──▶ Platform sees only your family view
                ▶ Skill proof     ──▶ Potential employer sees only the range
                ▶ Everything else ──▶ Stays on your device
```

**The protocol enforces compartmentalization at the data format level.** A platform literally cannot mix your family feed with ads for products your practice habits suggest — because it doesn't have both datasets. It has only what you gave it, and you gave it only what was relevant.

---

## What This Is Not

- **Not a social network.** PHPOC is a data format. Social networks are one possible viewer.
- **Not a blockchain.** No distributed consensus. No mining. No tokens. The chain is a local cryptographic structure.
- **Not a replacement for platforms.** It's a replacement for *giving platforms everything*. Let them compete on UX, not on surveillance.

---

## Status

PHPOC currently exists as a **reference implementation** — a command-line tool that demonstrates the format, the chain, the encryption, the blind indexes, and the verification logic. It is pure Python, zero external dependencies, and MIT-licensed.

The **format specification** ([PHPSPEC.md](PHPSPEC.md)) is now complete — a standalone document defining the block structure, encryption scheme, key derivation, chain validation, content hashing, blind indexes, and staging area. Anyone can implement a reader, writer, or viewer — on mobile, on wearable, in a browser, or as part of a social platform that respects compartmentalization — by following the spec alone, without reference to the Python code.

---

## The Pitch

> **Your history shouldn't be an algorithm's inventory.**
>
> PHPOC gives you a portable, encrypted record of what you actually do. Share only what's relevant. Keep everything else. Let platforms compete on who serves you best — not on who knows you most.

---

*"Know thyself." — and share only what you choose.*
