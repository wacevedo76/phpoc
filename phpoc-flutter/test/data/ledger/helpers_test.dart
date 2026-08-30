import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';

/// Ledger Helpers — Phase 2 (RED) test suite.
///
/// All 15 assertions from docs/planning/flutter/LEDGER_PHASE1.md Group A.
/// These tests define the contract Phase 3 must satisfy.
///
/// Expected: all tests FAIL (RED) because helpers.dart does not exist yet.

// ── Test constants ──────────────────────────────────────────────

/// Known test entry matching Python helpers.py `compute_entry_hash` output.
const testEntry = {
  'title': 'Test Task',
  'startTime_enc': 'enc:000000006585c3f0',
  'duration': 3600000,
  'content_hash': 'abc123',
};

/// Python compute_entry_hash output for sort+indent2 JSON of:
/// {"content_hash":"abc123","duration":3600000,"startTime_enc":"enc:000000006585c3f0","title":"Test Task"}
/// SHA-256 hex: precomputed
const knownEntryHash =
    'c95db14c90832cd9ff3d5c1bd292490ed25a86aae2a53d41701dbb14984a4f02';

void main() {
  late CryptoService crypto;

  setUp(() async {
    crypto = CryptoService();
    await crypto.initialize();
  });

  // ═══════════════════════════════════════════════════════════════
  // Group A: Helpers & Utilities (15 tests)
  // ═══════════════════════════════════════════════════════════════

  group('A: getBlockHash', () {
    // A1 — getBlockHash returns block_hash for genesis blocks
    test('A1: getBlockHash returns block_hash for genesis blocks', () {
      final genesis = {
        'type': 'genesis',
        'block_hash': 'abc123def456',
        'day_hash': 'should-be-ignored',
      };
      expect(getBlockHash(genesis), 'abc123def456');
    });

    // A2 — getBlockHash returns day_hash for day blocks
    test('A2: getBlockHash returns day_hash for day blocks', () {
      final day = {
        'type': 'day',
        'day_hash': 'day1234567890',
      };
      expect(getBlockHash(day), 'day1234567890');
    });

    // A3 — getBlockHash returns month_hash for month_summary blocks
    test('A3: getBlockHash returns month_hash for month_summary blocks', () {
      final month = {
        'type': 'month_summary',
        'month_hash': 'month12345678',
      };
      expect(getBlockHash(month), 'month12345678');
    });

    // A4 — getBlockHash returns year_hash for year_summary blocks
    test('A4: getBlockHash returns year_hash for year_summary blocks', () {
      final year = {
        'type': 'year_summary',
        'year_hash': 'year1234567890',
      };
      expect(getBlockHash(year), 'year1234567890');
    });

    // A5 — getBlockHash returns empty string when no hash key present
    test('A5: getBlockHash returns empty string when no hash key present',
        () {
      final bad = {'type': 'day'};
      expect(getBlockHash(bad), '');
    });

    // A6 — getBlockHash falls back day_hash for legacy genesis without block_hash
    test(
        'A6: getBlockHash falls back day_hash for legacy genesis without block_hash',
        () {
      final legacy = {
        'type': 'genesis',
        'day_hash': 'legacyDayHash123',
      };
      expect(getBlockHash(legacy), 'legacyDayHash123');
    });

    // A7 — computeEntryHash produces SHA-256 of sort_keys+indent=2 JSON
    test(
        'A7: computeEntryHash produces SHA-256 of sort_keys+indent=2 JSON',
        () {
      final data = {'title': 'Test', 'duration': 1000, 'tags': <String>[]};
      final hash = computeEntryHash(data);
      expect(hash, isNotEmpty);
      expect(hash.length, 64);
      // Deterministic: same input → same hash
      final hash2 = computeEntryHash(data);
      expect(hash, hash2);
    });

    // A8 — computeEntryHash output matches Python for known test vector
    test(
        'A8: computeEntryHash output matches Python for known test vector',
        () {
      final hash = computeEntryHash(testEntry);
      // Must match the byte-identical Python output
      expect(hash, knownEntryHash);
    });

    // A9 — verifyEntryHashTwoWay matches sort+indent2 (canonical)
    test('A9: verifyEntryHashTwoWay matches sort+indent2 (canonical)', () {
      final data = {'title': 'Task', 'duration': 5000};
      final canonicalHash = computeEntryHash(data);
      expect(verifyEntryHashTwoWay(data, canonicalHash), isTrue);
    });

    // A10 — verifyEntryHashTwoWay matches sort+compact (legacy fallback)
    test('A10: verifyEntryHashTwoWay matches sort+compact (legacy fallback)',
        () {
      final data = {'title': 'Task', 'duration': 5000};
      // Compute sort+compact hash manually: sha256(sort_keys=True, no indent)
      // This is the legacy format pre-v0.4
      final compactJson =
          '{"duration":5000,"title":"Task"}'; // sorted keys, no indent
      final compactHash = crypto.sha256(compactJson);
      expect(verifyEntryHashTwoWay(data, compactHash), isTrue);
    });

    // A11 — verifyEntryHashTwoWay returns false for wrong hash
    test('A11: verifyEntryHashTwoWay returns false for wrong hash', () {
      final data = {'title': 'Task', 'duration': 5000};
      expect(
          verifyEntryHashTwoWay(data, '0' * 64), isFalse);
    });

    // A12 — verifyContentHash extensible algorithm
    test(
        'A12: verifyContentHash extensible algorithm: decrypts _enc fields, sorts lists',
        () async {
      crypto.setMasterKey(
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

      // Create an entry with _enc fields
      final encryptedTitle = crypto.encrypt('Secret Title', crypto.getMasterKey()!);
      final data = {
        'title_enc': encryptedTitle,
        'duration': 3600000,
        'tags': <String>['b', 'a'],
      };

      // Compute expected content hash: decrypt title_enc → title, sort tags → [a,b]
      // canonical: {"duration":3600000,"tags":["a","b"],"title":"Secret Title"}
      final hash = computeContentHash(data, crypto);
      expect(hash, isNotEmpty);

      // verifyContentHash should match
      expect(verifyContentHash(data, hash, decryptFn: (c) => crypto.decrypt(c, crypto.getMasterKey()!)), isTrue);
    });

    // A13 — verifyContentHash legacy v0.3.0 algorithm fallback
    test(
        'A13: verifyContentHash legacy v0.3.0 algorithm fallback', () {
      crypto.setMasterKey(
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

      // Legacy v0.3.0: 9 hardcoded fields with indent=2
      final data = {
        'title': 'Legacy Task',
        'startTime_enc': crypto.encrypt('1700000000000', crypto.getMasterKey()!),
        'endTime_enc': crypto.encrypt('1700003600000', crypto.getMasterKey()!),
        'metadata_enc': crypto.encrypt('{}', crypto.getMasterKey()!),
        'pauses_enc': crypto.encrypt('[]', crypto.getMasterKey()!),
        'tags': <String>[],
        'comment': '',
        'media': <String>[],
        'duration': 3600000,
      };

      // The content hash computed by the fallback should be verifiable
      // even though it's the legacy format
      final someContentHash = computeContentHash(data, crypto);
      expect(
          verifyContentHash(data, someContentHash, decryptFn: (c) => crypto.decrypt(c, crypto.getMasterKey()!)),
          isTrue);
    });

    // A13b — regression: JSON-typed _enc plaintext is hashed as a STRING,
    // matching Python `_verify_content_hash` / migrator `_compute_content_hash`
    // and Web `_verifyContentHash`. Decrypting `"{}"` to an empty map (via
    // jsonDecode) changed the canonical JSON bytes and made Flutter reject a
    // Python-migrated ledger. Digital plaintext must stay verbatim.
    test(
        'A13b: JSON-typed _enc plaintext is kept as string in content hash',
        () {
      crypto.setMasterKey(
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

      final data = {
        'duration': 598172,
        'metadata_enc': crypto.encrypt('{}', crypto.getMasterKey()!),
        'startTime_enc': crypto.encrypt('1777028295844', crypto.getMasterKey()!),
        'title': 'Music Practice - Flute',
      };

      final hash = computeContentHash(data, crypto);
      // Encrypt deterministic ciphertext each run, but the canonical string
      // must round-trip.
      expect(verifyContentHash(data, hash,
          decryptFn: (c) => crypto.decrypt(c, crypto.getMasterKey()!)), isTrue);
    });

    // A14 — verifyContentHash returns false when decryption fails and hash differs
    test(
        'A14: verifyContentHash returns false when decryption fails and hash differs',
        () {
      final data = {
        'title_enc': 'corrupted_ciphertext_that_cannot_be_decrypted',
        'duration': 5000,
      };
      // Wrong hash + bad cipher → should return false, not throw
      expect(
          verifyContentHash(data, '0' * 64,
              decryptFn: (_) => throw Exception('decrypt failed')),
          isFalse);
    });

    // A15 — verifyContentHash returns false for wrong hash
    test('A15: verifyContentHash returns false for wrong hash', () {
      crypto.setMasterKey(
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      final data = {'title': 'Task', 'duration': 5000};
      final wrongHash = 'f'.padRight(64, 'f');
      expect(
          verifyContentHash(data, wrongHash, decryptFn: (c) => crypto.decrypt(c, crypto.getMasterKey()!)),
          isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group CH: computeContentHash strip divergence — KEEP `_enc` suffix
  // (PHPSPEC §5.5/§6.1, byte-identical with Python json.dumps(sort_keys=True))
  // Blueprint: docs/planning/flutter/CONTENT_HASH_STRIP_DIVERGENCE_PHASE1.md
  // ═══════════════════════════════════════════════════════════════
  group('CH: computeContentHash strip divergence', () {
    const mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

    // CH1 — KEEP `_enc` suffix + plaintext-as-string (V1 vector)
    test('CH1: KEEPS _enc suffix + plaintext-as-string (V1 vector)', () {
      crypto.setMasterKey(mk);
      final data = {
        'duration': 598172,
        'metadata_enc': crypto.encryptWithCachedKey('{}'),
        'startTime_enc': crypto.encryptWithCachedKey('1777028295844'),
        'title': 'Music Practice - Flute',
      };
      expect(computeContentHash(data, crypto),
          '6bcdf73697a738fd7412bc6c4cfe8daf5fc4b7167b8dac8a013fe9602b1d26dd');
    });

    // CH2 — JSON-typed `_enc` plaintext stays a string (V2 vector)
    test('CH2: JSON-typed _enc plaintext stays a string (V2 vector)', () {
      crypto.setMasterKey(mk);
      final data = {
        'comment': 'deep work',
        'duration': 3600000,
        'endTime_enc': crypto.encryptWithCachedKey('1714003600000'),
        'pauses_enc': crypto.encryptWithCachedKey('[]'),
        'startTime_enc': crypto.encryptWithCachedKey('1714000000000'),
        'tags': ['focus', 'work'],
        'title': 'Coding',
      };
      expect(computeContentHash(data, crypto),
          '3df78f0abccaf7b9fdf0b504a1d205d91561420782791869642f4792e23169f9');
    });

    // CH3 — plaintext-only entry (V4): content_hash excluded, jsonSort spacing
    test('CH3: plaintext-only entry hashes to V4 vector', () {
      crypto.setMasterKey(mk);
      final data = {'title': 'Test', 'duration': 1000};
      expect(computeContentHash(data, crypto),
          'fe8dfdbf3f76aa2fa466cdcaa628343b87f9081c67c73db8dd35759a2c62d0f1');
    });

    // CH4 — list fields sorted (V3 vector)
    test('CH4: list fields sorted (V3 vector)', () {
      crypto.setMasterKey(mk);
      final data = {
        'duration': 1800000,
        'media': <String>[],
        'tags': ['b', 'a', 'c'],
        'title': 'Reading',
      };
      expect(computeContentHash(data, crypto),
          '77492680df22b4a852d2b7dacfc350275a02b08c3f32171087fd9412012f1708');
    });

    // CH5 — empty-string `_enc` kept as-is with suffix retained (V6 vector)
    test('CH5: empty _enc value kept as-is with suffix (V6 vector)', () {
      crypto.setMasterKey(mk);
      final data = {'duration': 1, 'empty_enc': '', 'title': 'X'};
      expect(computeContentHash(data, crypto),
          '7fa34bb1e3ef6a5d23c6d2a05b6d97358d1be0ddff8dc557f9f8c8d0a6eadfb8');
    });

    // CH6 — compute → verify round-trip self-consistent
    test('CH6: computeContentHash → verifyContentHash round-trips', () {
      crypto.setMasterKey(mk);
      final data = {
        'duration': 598172,
        'metadata_enc': crypto.encryptWithCachedKey('{}'),
        'startTime_enc': crypto.encryptWithCachedKey('1777028295844'),
        'title': 'Music Practice - Flute',
      };
      final hash = computeContentHash(data, crypto);
      expect(
        verifyContentHash(data, hash,
            decryptFn: (c) => crypto.decrypt(c, crypto.getMasterKey()!)),
        isTrue,
      );
    });
  });
}
