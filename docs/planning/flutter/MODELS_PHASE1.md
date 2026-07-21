# Flutter Domain Models — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 1
> **Purpose:** Blueprint of all test assertions for domain models and utilities.
> **Status:** ✅ Phases 1-4 Complete — 94/94 GREEN
> **Next Phase:** N/A (Models task complete. Next: Crypto FFI Bridge)
> **Constraint:** Pure Dart. No Flutter imports. No external deps. `dart test` (no emulator).

## Architecture Overview

```
lib/core/
├── models/
│   ├── entry.dart          ← Entry + PauseRecord
│   ├── block.dart          ← Block (genesis/year/month/day)
│   ├── device_cookie.dart  ← DeviceCookie
│   ├── identity.dart       ← Identity (device ID derivation)
│   └── sync_result.dart    ← SyncResult enum (extends existing SyncCheckResult)
└── utils/
    ├── base64.dart         ← base64 encode/decode (standard + URL-safe)
    ├── json_utils.dart     ← jsonSort, jsonSortIndent2 (matches web byte-for-byte)
    └── hash_utils.dart     ← SHA-256 wrapper (delegates to dart:crypto or future Rust FFI)
```

**Note on existing stubs:** `entry.dart`, `device_cookie.dart`, and `sync_result.dart` exist as stubs using Equatable. The INITIAL_PLAN specifies Freezed for Entry. Phase 3 will decide between Equatable (simpler, already used) and Freezed (code-gen, copyWith built-in). The test assertions work with either — they test the public API, not the implementation.

---

## Test Groups

### Group A: Entry — 21 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Construct Entry with all required fields | Verifies minimum valid entry creation | Required: entryId, title, startEpoch |
| A2 | Construct Entry with all optional fields | Verifies full entry with endEpoch, tags, pauses, metadata | All fields must be supported from day one |
| A3 | `durationMs` returns `endEpoch - startEpoch` for completed entry with no pauses | Verifies basic duration calculation | Core display value — must be correct |
| A4 | `durationMs` accounts for pause deductions | Verifies pause subtraction from total duration | Pauses are first-class — incorrectly counting them breaks reporting |
| A5 | `durationMs` returns 0 when `endEpoch` is null (active) | Verifies active task duration is zero | Follows web convention: active tasks have no duration yet |
| A6 | `durationMs` clamps negative result to 0 | Verifies defensive clamping for malformed data | Pause overlapping endEpoch could yield negative durations |
| A7 | `durationMs` returns 0 when startEpoch == endEpoch | Verifies zero-length entry edge case | Should not crash or return negative |
| A8 | `copyWith` creates independent copy with single field change | Verifies copyWith returns new instance with only specified field changed | Immutability contract — mutation must produce new object |
| A9 | `copyWith` preserves all unspecified fields | Verifies unchanged fields carry through | Partial updates must not lose data |
| A10 | Original Entry unchanged after `copyWith` | Verifies immutability of source | copyWith must not mutate the original |
| A11 | Two Entries with identical fields are equal | Verifies value equality | Structural equality, not reference equality |
| A12 | Two Entries with different entryId are not equal | Verifies equality uses all props | Different IDs = different entries |
| A13 | Two Entries differ by single tag in list | Verifies deep equality through collections | List comparison must be structural, not reference |
| A14 | JSON roundtrip: Entry → toJson → fromJson → equal to original | Verifies serialization fidelity | Model must survive JSON encode/decode cycle intact |
| A15 | JSON roundtrip preserves `null` endEpoch | Verifies null handling in serialization | Active tasks have null endEpoch — must roundtrip |
| A16 | JSON roundtrip preserves pauses array with multiple records | Verifies nested object serialization | Pauses are JSON arrays of objects — deep serialization |
| A17 | `tags` list is immutable after construction | Verifies defensive immutability of collections | `tags` is `List<String>` — must be unmodifiable |
| A18 | `pauses` list is immutable after construction | Verifies defensive immutability of collections | `pauses` is `List<PauseRecord>` — must be unmodifiable |
| A19 | `isActive` defaults to `true` | Verifies default value | Captured entries start active |
| A20 | `committed` defaults to `false` | Verifies default value | Entries are uncommitted until sealed into a block |
| A21 | `tags` defaults to empty list | Verifies default value | Tags are optional — empty list, not null |

### Group B: PauseRecord — 8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | Construct PauseRecord with required fields | Verifies minimum valid pause creation | Required: startEpoch only (pause start) |
| B2 | Construct PauseRecord with endEpoch | Verifies completed pause | Ended pauses have both start and end |
| B3 | `durationMs` returns `endEpoch - startEpoch` when both set | Verifies completed pause duration | Used to subtract from entry duration |
| B4 | `durationMs` returns 0 when endEpoch is null (open) | Verifies open pause has no duration | Ongoing pause = no elapsed time yet |
| B5 | `isOpen` returns true when endEpoch is null | Verifies open pause detection | UI needs to know if pause is active |
| B6 | `isOpen` returns false when endEpoch is set | Verifies closed pause detection | Closed pauses should not show as active |
| B7 | Two PauseRecords with same fields are equal | Verifies value equality | Pauses used in equality checks |
| B8 | JSON roundtrip: PauseRecord → toJson → fromJson → equal | Verifies serialization fidelity | Pauses stored as JSON in staging |

### Group C: Block — 12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Construct genesis block with all fields | Verifies genesis block creation | Genesis is the chain root — must be valid |
| C2 | Construct day block with entries array | Verifies day block creation | Day blocks contain committed entries |
| C3 | Construct month summary block | Verifies month block type | Summary blocks aggregate periods |
| C4 | Construct year summary block | Verifies year block type | Summary blocks aggregate periods |
| C5 | Genesis block prev_hash is all zeros (32 zero bytes) | Verifies genesis anchor | Per PHPSPEC §4.2 — chain root convention |
| C6 | Day block prev_hash links to prior block's hash | Verifies chain linking structure | Immutability depends on prev_hash linking |
| C7 | `block_type` enum validation: only genesis, year, month, day | Verifies type safety | Prevents invalid block types from entering the chain |
| C8 | JSON roundtrip: Block → toJson → fromJson → equal | Verifies serialization fidelity | Blocks stored as JSON on Worker and disk |
| C9 | JSON roundtrip preserves `data_enc` (base64 blob) | Verifies encrypted payload survives serialization | data_enc is the main block payload — must be preserved |
| C10 | JSON roundtrip with null identity_seal | Verifies optional field handling | Day blocks may omit identity_seal |
| C11 | Two blocks with same fields are equal | Verifies value equality | Used in test assertions |
| C12 | Blocks differ by block_index | Verifies equality includes index | Chain ordering depends on block_index |

### Group D: DeviceCookie — 10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Construct DeviceCookie with device_uuid, device_specifier, creation_time | Verifies minimum valid cookie | All three fields required for auth gate |
| D2 | JSON roundtrip: DeviceCookie → toJson → fromJson → equal | Verifies serialization fidelity | Cookies travel over HTTP as JSON |
| D3 | JSON deserialization with missing field throws | Verifies input validation | Corrupt cookie data must not silently succeed |
| D4 | `isValid()` returns true when within TTL | Verifies TTL check — valid case | Core auth gate logic: same-device fast path |
| D5 | `isValid()` returns false when TTL expired | Verifies TTL check — expired case | Expired cookies trigger re-auth |
| D6 | `isValid()` at exact TTL boundary: creation_time + TTL | Verifies boundary behavior | Off-by-one in TTL check breaks fast path |
| D7 | `isValid()` with very large TTL (24 hours) returns true | Verifies non-default TTL | Different environments may use different TTLs |
| D8 | `isValid()` with 0 TTL returns false immediately | Verifies zero TTL edge case | Zero TTL = always invalid |
| D9 | Two cookies with same specifier are equal | Verifies equality on cookie data | Cookie comparison used in auth gate |
| D10 | Two cookies with different specifiers are not equal | Verifies specifier distinguishes sessions | Cross-device detection depends on specifier mismatch |

### Group E: Identity — 8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Derive device_id from MK + device_secret produces hex string | Verifies HMAC-SHA256 derivation | Core identity: every device has unique ID |
| E2 | Same (MK, secret) produces same device_id | Verifies deterministic derivation | Identity must be stable for a given device |
| E3 | Different MK produces different device_id | Verifies MK binds identity | Different ledger = different identity |
| E4 | Different secret produces different device_id | Verifies secret binds to device | Different device = different identity |
| E5 | device_id is exactly 64 hex characters | Verifies output format | Must match web and CLI format: 64-char hex |
| E6 | Client suffix appending: "uuid4" + "-flutter" → device_id_with_suffix | Verifies cross-client identity | Per I-09 — CLI uses -cli, web uses -web, mobile uses -flutter |
| E7 | Identity message format: "phpoc:device:<secret>" | Verifies HMAC message convention | Must match web's `deriveDeviceId()` and Python's `derive_device_id()` |
| E8 | device_id from pure-Dart HMAC matches web JS output (known test vector) | Verifies cross-client compatibility | Byte-for-byte identical output across platforms |

### Group F: SyncResult — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | SyncResult enum has all four values: READY, OFFLINE, REAUTH_NEEDED, GENESIS_MISMATCH | Verifies enum completeness | Must match web's SYNC_RESULT |
| F2 | SyncResult.READY.toString() returns "READY" | Verifies string representation | Used in logging and UI |
| F3 | SyncResult value lookup by string: fromString("READY") → SyncResult.READY | Verifies deserialization | Remote results arrive as strings |
| F4 | fromString throws on invalid string | Verifies input validation | Unknown sync states must be rejected |
| F5 | SyncResult matches existing SyncCheckResult enum (if extended) or replaces it | Verifies naming consistency | Existing scaffold uses SyncCheckResult — Phase 3 decides naming |

### Group G: Base64 — 10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `base64Encode(bytes)` → `base64Decode(str)` roundtrip | Verifies encode/decode cycle | Core data transformation — must be lossless |
| G2 | Standard base64: "Hello World" → "SGVsbG8gV29ybGQ=" | Verifies standard encode output | Must match web's `bytesToBase64` |
| G3 | Standard base64: decode "SGVsbG8gV29ybGQ=" → "Hello World" | Verifies standard decode | Must match web's `base64ToBytes` |
| G4 | URL-safe base64 replaces `+` → `-`, `/` → `_`, strips `=` | Verifies URL-safe encode | Worker paths use URL-safe base64 |
| G5 | URL-safe decode handles `-`, `_`, missing padding | Verifies URL-safe decode | Must accept URL-safe input without error |
| G6 | Empty Uint8List: encode → "" | Verifies empty input handling | Should not crash on zero-length input |
| G7 | Empty string: decode → empty Uint8List | Verifies empty decode | Should not crash on empty string |
| G8 | Decode throws on invalid base64 character | Verifies error handling | Malformed input must be rejected |
| G9 | Encode single byte (0xFF) → "/w==" | Verifies edge case: single byte | Padding logic must handle odd-length input |
| G10 | Encode two bytes (0xFF, 0xFF) → "//8=" | Verifies edge case: two bytes | Padding logic must handle 2-byte input |

### Group H: JSON Canonical Sort — 12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `jsonSort` with simple object: keys sorted alphabetically | Verifies basic key sorting | Deterministic JSON requires sorted keys |
| H2 | `jsonSort` with nested object: keys sorted at all levels | Verifies recursive key sorting | Deep sorting required for content hash |
| H3 | `jsonSort` with array: elements in order, not sorted | Verifies arrays preserve order | Array order is semantically meaningful |
| H4 | `jsonSort` skips keys with undefined values | Verifies undefined handling | Matches web's structured clone behavior |
| H5 | `jsonSort` output matches web's `jsonSort` for known test vector | Verifies cross-client byte-for-byte | Content hash depends on exact same JSON output |
| H6 | `jsonSortIndent2` produces 2-space indented output | Verifies indent format | Matches Python's `json.dumps(indent=2)` |
| H7 | `jsonSortIndent2` with nested object: correct indentation at depth | Verifies deep indentation | Nested objects must indent correctly at all levels |
| H8 | `jsonSortIndent2` output matches web's `jsonSortIndent2` for known test vector | Verifies cross-client byte-for-byte | Entry hashing depends on this exact output |
| H9 | `jsonSort` with null → "null" | Verifies null serialization | Null must be JSON null, not omitted |
| H10 | `jsonSort` with boolean → "true" or "false" | Verifies boolean serialization | Booleans must be lowercase JSON booleans |
| H11 | `jsonSort` with empty object → "{}" | Verifies empty object | Must not produce whitespace or newlines |
| H12 | `jsonSort` with empty array → "[]" | Verifies empty array | Must produce valid empty JSON array |

### Group I: Hash Utils — 7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | SHA-256 of "hello" produces correct 64-char hex digest | Verifies basic SHA-256 | Must match NIST test vectors |
| I2 | SHA-256 of empty string produces correct digest | Verifies empty input | Empty input must not crash |
| I3 | SHA-256 of binary data (Uint8List) produces correct digest | Verifies binary input support | Content hashes work on binary payloads |
| I4 | SHA-256 output matches web's `crypto.sha256` for same input | Verifies cross-client compatibility | Content hash verification across platforms |
| I5 | SHA-256 of 100KB input produces correct digest | Verifies large input handling | Blocks can contain many entries |
| I6 | Repeated SHA-256 of same input produces same output | Verifies determinism | Must be deterministic — not random |
| I7 | SHA-256 of different inputs produce different outputs | Verifies collision resistance (basic) | Different data = different hash |

---

## Summary

| Group | Module | Assertions |
|-------|--------|-----------|
| A | Entry | 21 |
| B | PauseRecord | 8 |
| C | Block | 12 |
| D | DeviceCookie | 10 |
| E | Identity | 8 |
| F | SyncResult | 5 |
| G | Base64 | 10 |
| H | JSON Canonical Sort | 12 |
| I | Hash Utils | 7 |
| **Total** | | **93** |

### Key Cross-Client Tests (byte-for-byte verification vs web)

- **E8:** Identity derivation matches web JS output
- **H5:** `jsonSort` output matches web byte-for-byte
- **H8:** `jsonSortIndent2` output matches web byte-for-byte
- **I4:** SHA-256 output matches web output

### Existing Stubs to Evolve

- `entry.dart` — Has Entry + PauseRecord with Equatable. Tests cover the existing API. Phase 3 decides Equatable vs Freezed.
- `device_cookie.dart` — Has DeviceCookie with Equatable, toJson/fromJson, TTL. Tests validate existing behavior.
- `sync_result.dart` — Has SyncCheckResult enum. Tests verify naming and completeness (INITIAL_PLAN calls it SyncResult).
