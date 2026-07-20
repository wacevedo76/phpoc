# Flutter App Development Axioms

> **Date:** 2026-07-17
> **Branch:** `feature/flutter-mobile-riverpod`
> **Context:** Guiding principles for Flutter mobile app development. Derived from the 11 binding
> directives (D1–D11), the comparative architecture analysis, 25 ADRs, and existing web/CLI patterns.
> These do not replace D1–D11 — they build on them with mobile-specific, Flutter-specific, and
> development-practice guidance. When an axiom conflicts with a directive, the directive wins.

---

## A. Protocol Axioms

_What we're building. Non-negotiable. Derived from D1–D11, DESIGN_GOALS.md, PHPSPEC.md._

### A1 — The User Owns Everything
The ledger is the user's property, not ours. The app is a tool for reading and writing a format
the user controls. No telemetry, no analytics, no "phone home" behavior. No account required.
No server-held secrets. The app works fully offline.

### A2 — Zero Knowledge
We cannot read the user's data. We cannot recover the user's passphrase. We cannot decrypt
anything. If the user loses their passphrase AND their recovery seed, the data is gone — and
that's by design. Never build a "forgot password" flow. Never log plaintext secrets (passphrases,
seeds, keys). The `debugPrint` override must strip or mask sensitive data.

### A3 — Cryptographic Integrity
Every block is signed. Every entry has a content hash. The chain is verifiable end-to-end.
If verification fails, the app must surface it — not silence it. Tamper evidence is a feature.

### A4 — Append-Only Ledger
The ledger is immutable. Entries move from staging → committed → sealed. They never move
backward. Never edit, delete, or rewrite historical data. The app must never offer "edit entry
from last month" — once committed, an entry is permanent. The UI should make this boundary
visually clear.

### A5 — Staging is Sacred
Staging is a mutable scratchpad. The ledger is immutable history. The only path from staging
to ledger is explicit user action (review, decide, commit). Never auto-commit. Never leak
staging entries into ledger views. Never show "plain:" fields in committed screens. The
StagingService is the single entry point for all staging operations.

### A6 — Offline-First
All core operations work without a network. Local writes complete instantly. Sync is
opportunistic, never blocking. `checkAndSync()` returns `OFFLINE` gracefully, not with
an error. The UI must show sync state clearly (synced, pending, offline, error).

### A7 — Recoverable from Seed Alone
A user with only their recovery seed can reconstruct everything. The genesis block is
the cryptographic root. No external file is irreplaceable. The recovery flow must work
without identity.json, without staging, without anything except the seed and the ledger.

### A8 — Backward Compatible
Existing ledgers (any format version from v0.3.0+) must open without error. New fields
are optional. Migration is explicit, optional, and non-destructive. The app must handle
mixed-version ledgers.

---

## B. Architecture Axioms

_How we structure the code. Derived from the comparative analysis (FLUTTER_ARCHITECTURE.md)._

### B1 — Dependency Direction is Sacred
```
Presentation (features/) → Application (services/) → Data (data/) → Domain (core/)
```
Core has no Flutter imports. Data has no Widget imports. Services orchestrate but don't own
domain logic. Features consume services. Never invert these arrows. If something in `core/`
imports `package:flutter`, it's in the wrong layer.

### B2 — One Implementation, One Source of Truth
Crypto is written once (Rust `phpoc-crypto-core`), compiled everywhere. Do not re-implement
PBKDF2, AES-CTR, HMAC, or blob obfuscation in Dart — import the Rust `.so`. If the Rust
library doesn't expose something, add it there, not in Dart.

### B3 — No God Objects
The web's `DevModeContext.jsx` (1400+ lines) is the canonical anti-pattern. Split into
focused providers. No single file should own auth, sync, onboarding, preferences, and
error handling. If a provider file exceeds 200 lines, it's probably doing too much.

### B4 — Screen ≠ Service
Feature screens (in `features/`) are presentation only. They read state from providers
and delegate actions to services. A screen should never contain crypto logic, sync logic,
or database queries — it calls a service method and renders the result.

### B5 — Port, Don't Rewrite
The sync algorithm (`checkAndSync`, merge engine, genesis gate, device cookie) is already
correct in the web and CLI codebases. Port the logic to Dart — same flow, same edge cases,
same error handling. Do not "improve" the algorithm during porting. Validate against the
same test vector suite.

### B6 — Test Each Layer Independently
Core (pure Dart) → unit tests. Data (SQLite) → integration tests with real I/O (temp dirs,
not mocks). Services → tests with overridden providers. Screens → widget tests with pump.
Follow D10: new features require new tests; bug fixes require regression tests.

---

## C. State Management Axioms

_Riverpod-specific rules. Derived from the state management analysis._

### C1 — Providers Are Granular
One provider per concern. `appLifecycleProvider` for boot phase. `syncServiceProvider` for
the sync service. `activeTaskProvider` for the current active task. `entryListProvider` for
filtered entry lists. Never create a "global state" provider that holds everything.

### C2 — What Stays Out of Riverpod
- **Navigation state** — owned by `go_router` (URL-based, deep-linkable)
- **Form state** — local `StatefulWidget` state (passphrase input, settings fields, tag entry)
- **Animation state** — local `AnimationController`
- **Focus state** — `FocusNode`
- **Ephemeral UI state** — dropdown open/close, snackbar visibility, tooltip state

### C3 — Async Operations Use AsyncNotifier
Any provider that performs I/O (network, file, crypto) must use `AsyncNotifier` or
`FutureProvider`. Wrap in `AsyncValue` so the UI can render loading/error/data states
without manual flag management.

### C4 — Providers Are Overridable by Design
Every service provider must accept its dependencies as constructor parameters so tests
can inject test doubles. Don't hardcode `HttpTransport()` inside `SyncService` — pass it
in via the provider's `ref.watch()`.

### C5 — Granular Rebuilds via `select()`
When a screen only needs `entry.title` from a list, use `ref.watch(entryListProvider.select((list) => list.map((e) => e.title)))` — not `ref.watch(entryListProvider)`. Avoid
rebuilding the entire screen when one field changes.

---

## D. Data Axioms

_Storage, sync, and encryption boundaries. Derived from the data layer analysis._

### D1 — SQLite is the Source of Truth
Local SQLite (via `drift`) is the authoritative data store. It holds staging entries, ledger
blocks, the blind index, and preferences. Remote storage (Worker via HTTP) is a mirror, never
the primary. The app never blocks on network I/O for data reads.

### D2 — Encrypted at Rest, Always
All entry data (timestamps, metadata, durations, comments, media hashes) is encrypted with
AES-256-GCM before persisting to SQLite. The `title` field is intentionally plaintext for
blind index queries — this is the only exception. The database on disk must never contain
unencrypted entry data beyond the title.

### D3 — Master Key is Memory-Only
The derived master key exists only in RAM. It is never written to disk, never stored in
SharedPreferences, never persisted. On lock/logout, it is zeroed. The passphrase itself is
never stored — it's erased immediately after MK derivation.

### D4 — Biometrics Are a Cache
Fingerprint/face unlock decrypts a locally-stored encrypted master key — same model as
the web's IndexedDB-cached seed. If biometrics fail (new fingerprint, face not recognized),
fall back to passphrase. Biometrics are never the sole auth mechanism.

### D5 — Sync is Debounced, Not Real-Time
Writes trigger a push after a configurable debounce delay (default: 5 seconds). Rapid
successive writes collapse into a single push. Sync errors are silent (retry on next
interval) — never block the UI with sync error dialogs.

### D6 — Worker is Dumb
The Cloudflare Worker stores and retrieves opaque bytes. It knows nothing about entries,
blocks, chains, or users. No server-side validation, no server-side merge, no server-side
encryption. All intelligence is on the client. This is a design invariant, not an
implementation detail.

---

## E. Development Axioms

_How we build. Derived from the project's testing philosophy and practical constraints._

### E1 — Test Before Merge
No code merges without passing tests. `flutter analyze` must be clean. `flutter test` must
pass. New features require new tests. Bug fixes require regression tests. This is D10,
applied at the Flutter level.

### E2 — Test on Real Hardware Early
Emulators are for layout iteration. Real devices catch gesture timing, keyboard behavior,
biometric auth, network transitions, and thermal throttling. Test on a physical Android
device as soon as screens are functional. See `docs/planning/RELEASE_CHECKLIST.md` §1.

### E3 — Commit Working Code
Every commit must pass `flutter analyze` and `flutter test`. Broken intermediate states
belong on a branch, not in the commit history. Squash experimental work before merge.

### E4 — Stub First, Implement Later
When porting a web module (e.g., `merge_engine.js` → `merge_engine.dart`), write the stub
with the full API surface and `throw UnimplementedError()` bodies first. Commit the stub.
Then implement method by method. This keeps the architecture visible and prevents
analysis-paralysis.

### E5 — One Concern Per Commit
A commit titled "add merge engine" should add only the merge engine and its tests.
Don't bundle sync service changes, UI tweaks, or pubspec.yaml updates into the same
commit. This makes `git bisect` useful and code review focused.

### E6 — No Secrets in the Repo
Passphrases, API keys, recovery seeds, and test credentials are conversation-only or
live in `/tmp/`. Never commit them. The `.gitignore` already covers this, but we say
it explicitly: if you paste a secret into a source file, delete it before committing.

---

## F. Decision Axioms

_How to resolve ambiguity. Derived from the architectural decision records._

### F1 — Simplicity Over Generality
Solve the problem in front of you. Don't build an abstraction for a hypothetical future
use case. The merge engine merges staging entries — it doesn't need to be a generic
conflict resolver. The transport talks to a Cloudflare Worker — it doesn't need a
pluggable backend system (yet).

### F2 — Match the Existing Behavior
When porting a feature (sync, merge, genesis check, cookie validation), match the web/CLI
behavior exactly. If there's a bug in the reference implementation, fix it there first,
then port the fix. Never "improve" a feature during porting — you'll create cross-client
incompatibility.

### F3 — Prefer the User's Existing Data
On first launch, probe for existing ledger data (genesis + chain) before offering
"create new." If data exists, direct to unlock. If no data, offer onboarding. Never
overwrite an existing ledger without explicit user confirmation.

### F4 — Favor Explicit Over Implicit
Auto-sync is debounced and configurable — not silent and mandatory. Auto-commit is
forbidden — never. Auto-lock is configurable (timed, on background, never). Every
automation is opt-in or configurable, never imposed.

### F5 — When In Doubt, Consult the Spec
`PHPSPEC.md` is the authoritative format contract. If a field name, encoding, or
algorithm is ambiguous in the web/CLI code, the spec is the tiebreaker. If the spec
is also ambiguous, fix the spec first, then all implementations.

### F6 — Cross-Client Compatibility is Non-Negotiable
A ledger created by the CLI, synced via the web app, and viewed on mobile must be
identical in all three places. A staging entry captured on mobile must be syncable by
the web app. A block committed by the CLI must verify on mobile. If two clients
disagree about bytes, the format is broken.

---

## Cross-Reference

| Axiom | Source Directives | Source ADRs | Source Docs |
|-------|-------------------|-------------|-------------|
| A1 — User Owns Everything | D1, D6 | ADR-009, ADR-014, ADR-015 | DESIGN_GOALS §0 |
| A2 — Zero Knowledge | D2 | ADR-001, ADR-002, ADR-013 | DESIGN_GOALS §2 |
| A3 — Cryptographic Integrity | D4 | ADR-005, ADR-007 | DESIGN_GOALS §1 |
| A4 — Append-Only Ledger | D5 | ADR-010, ADR-012 | DESIGN_GOALS §3 |
| A5 — Staging is Sacred | D11 | ADR-009, ADR-015 | DESIGN_GOALS §4 |
| A6 — Offline-First | D6 | ADR-009, ADR-014 | CROSS_PLATFORM §5 |
| A7 — Recoverable from Seed | D8 | ADR-001, ADR-003 | DESIGN_GOALS §5 |
| A8 — Backward Compatible | D9 | ADR-005, ADR-011 | ROADMAP §Compat |
| B1 — Dependency Direction | — | — | FLUTTER_ARCH §4 |
| B2 — One Implementation | — | — | CROSS_PLATFORM §5 |
| B3 — No God Objects | — | — | FLUTTER_ARCH §3 |
| B4 — Screen ≠ Service | — | — | FLUTTER_ARCH §3 |
| B5 — Port, Don't Rewrite | — | — | FLUTTER_ARCH §2 |
| B6 — Test Each Layer | D10 | — | FLUTTER_ARCH §6 |
| C1–C5 | — | — | FLUTTER_ARCH §6 |
| D1–D6 | D6, D7 | ADR-009, ADR-014 | FLUTTER_ARCH §8 |
| E1–E6 | D10 | — | ROADMAP §Test Philosophy |
| F1–F6 | D1, D9 | ADR-005, ADR-011 | CROSS_PLATFORM §8 |

---

## Quick Reference Card

```
Before writing any code, ask:

1.  Does the user still own their data?                    (A1)
2.  Can the system read the user's data?                   (A2 — must be NO)
3.  Does the chain still verify end-to-end?                (A3)
4.  Am I editing/rewriting/deleting history?               (A4 — must be NO)
5.  Is staging leaking into ledger views?                  (A5 — must be NO)
6.  Does this work without internet?                       (A6)
7.  Can the user recover from seed alone?                  (A7)
8.  Will existing ledgers break?                           (A8)
9.  Is my import pointing in the right direction?          (B1)
10. Did I re-implement crypto in Dart?                     (B2 — must be NO)
11. Is this file over 200 lines?                           (B3 — split it)
12. Did I put business logic in a screen?                  (B4 — must be NO)
13. Did I match the web/CLI behavior exactly?              (B5)
14. Did I write tests?                                     (B6, E1)
15. Did I put form state in Riverpod?                      (C2 — must be NO)
16. Is this provider overridable in tests?                 (C4)
17. Is any unencrypted entry data on disk?                 (D2 — must be NO beyond title)
18. Is the master key in SharedPreferences?                (D3 — must be NO)
19. Did I make a network call from a screen?               (B4 — must be NO)
20. Will a CLI-created ledger work here?                   (F6)
```
