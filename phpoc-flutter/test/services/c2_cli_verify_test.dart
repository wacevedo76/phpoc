import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';

/// C-2 CLI↔Client Cross-Client Verification — Phase 2 RED (Flutter side).
///
/// Group L (B7–B12): Flutter as VERIFIER of the CLI-re-keyed canonical wire
/// (`testdata/c2_cli_rekeyed_wire.json`, produced by the Python driver
/// `tests/test_c2_cli_client_verify.py` Group A/B). Mirrors the Web↔Flutter
/// leg's `c2_cross_client_verify_test.dart` Group A, but the re-keyer is the
/// CLI and the MK is the RAW new seed (option (a), no version bump).
///
/// Group D (Flutter side): cross-client crypto invariants Flutter can check
/// hermetically against the CLI wire — raw-seed MK parity (D2), no
/// key_version bump (D3), identity stability (D5), prev_hash cascade (D6),
/// and seal parity (D8).
///
/// Live-only assertions (index/hash_index parity, device-cookie reauth) are
/// `skip`ped and deferred to `tests/test_c2_cli_client_live_r2.py` (Phase 3).
///
/// RED by design in Phase 2: the CLI re-keyer currently returns None on the
/// raw-seed test ledger (R2), so the wire artifact is absent → every Group L
/// assertion fails "artifact absent". After Phase 3 (option (a) raw-seed
/// re-key) the artifact exists and B8 becomes the sharpest R1/R4 probe:
/// Flutter derives the MK as the RAW seed (no versioned path), so a
/// versioned-HMAC CLI chain would fail seal verification here.
///
/// Runs with: flutter test test/services/c2_cli_verify_test.dart

/// Artifact path — resolved relative to the flutter package root
/// (`flutter test` runs with cwd = phpoc-flutter/), hence `../testdata/…`.
const cliWirePath = '../testdata/c2_cli_rekeyed_wire.json';

/// Decrypt, returning null instead of throwing (decrypt has no-tag fallbacks
/// that may return garbage rather than throw on a wrong key).
/// Decode a hex string into raw bytes (32-byte identity secret → SHA-256 input).
List<int> _hexDecode(String hex) {
  final out = <int>[];
  for (var i = 0; i + 1 < hex.length; i += 2) {
    out.add(int.parse(hex.substring(i, i + 2), radix: 16));
  }
  return out;
}

String? _tryDecrypt(CryptoService c, String ct, String keyHex) {
  try {
    return c.decrypt(ct, keyHex);
  } catch (_) {
    return null;
  }
}

/// Collect every `_enc` field as (blockType, key, ct) across [blocks].
List<({String blockType, String key, String ct})> _collectEnc(List<dynamic> blocks) {
  final out = <({String blockType, String key, String ct})>[];
  for (final b in blocks) {
    final block = b as Map<String, dynamic>;
    for (final e in (block['entries'] as List<dynamic>? ?? [])) {
      final data = (e as Map<String, dynamic>)['data'] as Map<String, dynamic>;
      for (final k in data.keys.where((k) => k.endsWith('_enc'))) {
        final v = data[k];
        if (v is String && v.isNotEmpty) {
          out.add((blockType: block['type'] as String, key: k, ct: v));
        }
      }
    }
  }
  return out;
}

Map<String, dynamic>? _readArtifact(String path) {
  final f = File(path);
  if (!f.existsSync()) return null;
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

List<dynamic>? _readBlocks(String path) {
  final artifact = _readArtifact(path);
  if (artifact == null) return null;
  final blocks = artifact['blocks'];
  return blocks is List ? blocks : null;
}

/// A [LedgerChain] backed by [db]'s block store, using [c] as its crypto.
LedgerChain _chain(CryptoService c, AppDatabase db) =>
    LedgerChain(crypto: c, store: LedgerBlockStore(db.blockDao));

void main() {
  group('Group L: Flutter verifier of the CLI re-keyed wire (B7–B12)', () {
    late CryptoService c;
    late AppDatabase db;
    late Map<String, dynamic>? artifact;
    late List<dynamic>? blocks;
    late String newMK;
    late String oldMK;

    setUpAll(() async {
      c = CryptoService()..initialize();
      db = AppDatabase.inMemory();
      artifact = _readArtifact(cliWirePath);
      blocks = artifact == null ? null : _readBlocks(cliWirePath);
      newMK = artifact?['new_mk'] as String? ?? '';
      oldMK = artifact?['old_mk'] as String? ?? '';
      if (blocks != null) {
        final backup = LedgerBackupService(db: db);
        await backup.importFromJson(jsonEncode(blocks!));
      }
      if (newMK.isNotEmpty) {
        c.setMasterKey(newMK);
      }
    });

    test('B7: flutter pulls (loads) the CLI re-keyed chain with no error', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit '
              'testdata/c2_cli_rekeyed_wire.json (R2: raw-seed ledger gate; '
              'run tests/test_c2_cli_client_verify.py in Phase 3)');
      expect(blocks!.length, 31,
          reason: 'the real test ledger must re-key to 31 blocks');
      expect((blocks!.first as Map)['type'], 'genesis');
    });

    test('B8: flutter chain.verify() VALID under the new MK', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      expect(_chain(c, db).verify(), isTrue,
          reason: 'R1/R4 probe: Flutter derives the MK as the RAW new seed; '
              'a versioned-HMAC CLI chain (key_version bump) cannot seal-verify here');
    });

    test('B9: flutter genesis parity — nested identity.{recovery_seed_enc, '
        'identity_pub_key, identity_secret_enc_fallback}', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      final genesis = _chain(c, db).readAll().first;
      final identity = genesis['identity'];
      expect(identity, isA<Map<String, dynamic>>(),
          reason: 'genesis must carry a nested identity object');
      expect((identity as Map)['recovery_seed_enc'], isNotNull,
          reason: 'identity.recovery_seed_enc must be present');
      expect(identity['identity_pub_key'], isNotNull);
      expect(identity['identity_secret_enc_fallback'], isNotNull);
      // Fallback must decrypt under the NEW MK (raw seed).
      final idHex = c.decrypt(
          identity['identity_secret_enc_fallback'] as String, newMK);
      expect(idHex, isNotEmpty);
    });

    test('B11: flutter device holding the OLD MK cannot decrypt the re-keyed '
        'ciphertext', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      final enc = _collectEnc(blocks!);
      for (final e in enc) {
        final correct = c.decrypt(e.ct, newMK);
        expect(correct, isNotEmpty,
            reason: '${e.blockType}.${e.key} must decrypt under NEW MK (sanity)');
        expect(_tryDecrypt(c, e.ct, oldMK), isNot(correct),
            reason: '${e.blockType}.${e.key} must NOT decrypt under the OLD MK '
                '(leak-nullification)');
      }
      expect(enc.length, greaterThan(0));
    });

    test('B10: flutter index.json / hash_index.json / genesis parity after pull',
        skip: 'deferred to live R2 E2E (Phase 3) — no hermetic index equivalent', () {});
    test('B12: flutter stale device-cookie specifier → reauthNeeded on next sync',
        skip: 'deferred to live R2 E2E (Phase 3) — requires a live sync transport', () {});
  });

  group('Group D: cross-client crypto invariants (Flutter side)', () {
    late Map<String, dynamic>? artifact;
    late List<dynamic>? blocks;
    late String newSeedB64;
    late String newMK;

    setUpAll(() {
      artifact = _readArtifact(cliWirePath);
      blocks = artifact == null ? null : _readBlocks(cliWirePath);
      newSeedB64 = artifact?['new_seed'] as String? ?? '';
      newMK = artifact?['new_mk'] as String? ?? '';
    });

    test('D2: deriveMasterKey(newSeed) == raw new-seed bytes == new_mk', () {
      expect(artifact, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      final c = CryptoService()..initialize();
      expect(c.deriveMasterKey(newSeedB64), newMK,
          reason: 'Flutter deriveMasterKey must equal the CLI raw-seed new_mk '
              '(option (a): the raw seed IS the MK)');
    });

    test('D3: key_version after seed-mint re-key is unchanged (no bump)', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      for (final b in blocks!) {
        final map = b as Map<String, dynamic>;
        final kv = map['key_version'];
        expect(kv == null || kv == 0, isTrue,
            reason: '${map['type']} key_version must stay raw (0/absent) — a '
                'seed replacement must NOT bump key_version (R1)');
      }
    });

    test('D5: identity_pub_key == SHA-256(identity_secret) invariant', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      final c = CryptoService()..initialize();
      c.setMasterKey(newMK);
      final genesis = (blocks!.first as Map<String, dynamic>);
      final identity = genesis['identity'] as Map<String, dynamic>;
      final idHex =
          c.decrypt(identity['identity_secret_enc_fallback'] as String, newMK);
      // R6 resolution: canonical derivation is SHA-256 over the RAW 32-byte
      // identity secret (PHPSPEC §2.7.1, Rust digest.rs::identity_pub_key),
      // NOT over the hex-string UTF-8. Decode the decrypted hex to raw bytes
      // before hashing.
      expect(identity['identity_pub_key'],
          crypto.sha256.convert(_hexDecode(idHex)).toString(),
          reason: 'identity_pub_key must equal SHA-256(raw 32-byte identity_secret)');
    });

    test('D6: prev_hash cascade intact in the CLI re-keyed wire', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      for (var i = 1; i < blocks!.length; i++) {
        final prev = (blocks![i - 1] as Map<String, dynamic>);
        final cur = (blocks![i] as Map<String, dynamic>);
        final prevHash = prev['block_hash'] ??
            prev['day_hash'] ??
            prev['month_hash'] ??
            prev['year_hash'];
        expect(cur['prev_hash'], prevHash,
            reason: 'block $i prev_hash must link to its predecessor');
      }
    });

    test('D8: seal parity — Flutter sealBlock equals the CLI wire seal', () {
      expect(blocks, isNotNull,
          reason: 'artifact absent — the CLI re-keyer did not emit the wire');
      final c = CryptoService()..initialize();
      c.setMasterKey(newMK);
      final chain = _chain(c, AppDatabase.inMemory());
      for (final b in blocks!) {
        final map = (b as Map).cast<String, dynamic>();
        final committed = map['block_hash'] ??
            map['day_hash'] ??
            map['month_hash'] ??
            map['year_hash'];
        expect(chain.sealBlock(map), committed,
            reason: '${map['type']} seal must match the CLI seal (ADR-029/029a '
                'cross-client parity)');
      }
    });
  });
}
