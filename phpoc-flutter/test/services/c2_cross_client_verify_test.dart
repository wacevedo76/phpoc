import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/rekey_service.dart';

/// C-2 Cross-Client Verification — Phase 2 RED harness (Flutter side).
///
/// Encodes the Phase 1 assertion matrix
/// (`docs/planning/C2_CROSS_CLIENT_VERIFY_PHASE1.md`) for the Flutter client:
///
///   - Group B (B1–B6):  Flutter as re-keyer — import the shared canonical
///                       (web-shaped, nested-identity) fixture and attempt a
///                       re-key. B1 is RED: the Flutter re-key path reads a
///                       FLAT `data_enc.seed`, but the web wire genesis stores
///                       a NESTED `identity.recovery_seed_enc` (R1/R2).
///   - Group A (A7–A12): Flutter as verifier of the web re-keyed wire artifact
///                       (`testdata/c2_web_rekeyed_wire.json`, produced by the
///                       web probe Group A). A9 is RED: Flutter import drops the
///                       nested `identity`.
///   - Group C (C1–C8):  cross-client cryptographic invariants, checked
///                       hermetically against the committed web fixture (the
///                       Web side of each lives in `c2_cross_client_verify.mjs`).
///
/// Live-only assertions (index/hash_index parity, device-cookie reauth) are
/// `skip`ped here and deferred to the live R2 E2E (Phase 3).
///
/// Runs with: flutter test test/services/c2_cross_client_verify_test.dart
///
/// Test constants are the SAME NON-SECRET dummies used by the Web probe and
/// `rekey_service_test.dart` (32×0x42 / 32×0x21) — fixtures only, NOT secrets.

/// 32 bytes of 0x42.
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// 32 bytes of 0x21.
const altSeedB64 = 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE=';

/// MK for [validSeedB64]: hex of raw 32×0x42 seed bytes.
const oldMK = '4242424242424242424242424242424242424242424242424242424242424242';

/// MK for [altSeedB64]: hex of raw 32×0x21 seed bytes.
const newMK = '2121212121212121212121212121212121212121212121212121212121212121';

/// Device-scoped identity secret (unchanged by re-key) — 32×0xab.
const identitySecret = 'abababababababababababababababababababababababababababababababab';

const oldPassphrase = 'CorrectHorseBatteryStaple42!';
const newPassphrase = 'NewCorrectHorseBatteryStaple99!';

// Artifact paths are resolved relative to the flutter package root
// (`flutter test` runs with cwd = phpoc-flutter/), hence `../testdata/…`.
const fixturePath = '../testdata/c2_cross_client_fixture.json';
const webArtifactPath = '../testdata/c2_web_rekeyed_wire.json';
const flutterArtifactPath = '../testdata/c2_flutter_rekeyed_wire.json';

/// Initialized [CryptoService] with the OLD MK cached (mirrors rekey_service_test).
CryptoService _crypto() {
  final c = CryptoService()..initialize();
  c.setMasterKey(oldMK);
  return c;
}

Map<String, dynamic>? _readArtifact(String path) {
  final f = File(path);
  if (!f.existsSync()) return null;
  return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
}

/// The `blocks` array of an artifact/fixture, or null when the file is absent.
List<dynamic>? _readBlocks(String path) {
  final artifact = _readArtifact(path);
  if (artifact == null) return null;
  final blocks = artifact['blocks'];
  return blocks is List ? blocks : null;
}

/// Decrypt, returning null instead of throwing (decrypt has no-tag fallbacks
/// that may return garbage rather than throw on a wrong key).
String? _tryDecrypt(CryptoService c, String ct, String keyHex) {
  try {
    return c.decrypt(ct, keyHex);
  } catch (_) {
    return null;
  }
}

/// Collect every `_enc` field as (blockType, key, ciphertext) across [blocks].
List<({String blockType, String key, String ct})> _collectEnc(List<dynamic> blocks) {
  final out = <({String blockType, String key, String ct})>[];
  for (final b in blocks) {
    final block = b as Map<String, dynamic>;
    for (final e in (block['entries'] as List<dynamic>? ?? [])) {
      final data = (e as Map<String, dynamic>)['data'] as Map<String, dynamic>;
      for (final k in data.keys.where((k) => k.endsWith('_enc'))) {
        out.add((blockType: block['type'] as String, key: k, ct: data[k] as String));
      }
    }
  }
  return out;
}

/// A [LedgerChain] backed by [db]'s block store, using [c] as its crypto.
LedgerChain _chain(CryptoService c, AppDatabase db) =>
    LedgerChain(crypto: c, store: LedgerBlockStore(db.blockDao));

/// Build a full Flutter service stack (RekeyService + AuthService + backup).
({RekeyService rekey, AuthService auth, CryptoService crypto, AppDatabase db,
    LedgerBackupService backup}) _stack(
  CryptoService c,
  AppDatabase db,
  AppPreferences prefs,
  SecurePreferences secPrefs,
) {
  final auth = AuthService(
      crypto: c, db: db, preferences: prefs, securePreferences: secPrefs);
  final backup = LedgerBackupService(db: db);
  final rekey = RekeyService(
    auth: auth,
    crypto: c,
    db: db,
    preferences: prefs,
    securePreferences: secPrefs,
    backupService: backup,
  );
  return (rekey: rekey, auth: auth, crypto: c, db: db, backup: backup);
}

/// Import [blocks] (PHPSPEC wire) into [db] and stage the seed vault under the
/// FLUTTER PDK so `auth.exportSeed` can clear the re-key ownership gate.
Future<void> _importWithVault(CryptoService c, AppDatabase db, List<dynamic> blocks) async {
  final backup = LedgerBackupService(db: db);
  await backup.importFromJson(jsonEncode(blocks));
  final oldPdk = c.derivePdk(oldPassphrase, CryptoService.pdkIterations);
  await db.setSeedVault(c.encrypt(validSeedB64, oldPdk));
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group B — Flutter re-keyer → Web verifier (B1–B6, Flutter side)
  // ═══════════════════════════════════════════════════════════════
  group('Group B: Flutter re-keyer (B1–B6)', () {
    late CryptoService c;
    late AppDatabase db;
    late RekeyService rekey;
    late LedgerBackupService backup;
    late Object? rekeyError;
    late String? exportJson;

    setUpAll(() async {
      c = _crypto();
      db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();

      final blocks = _readBlocks(fixturePath);
      if (blocks != null) {
        await _importWithVault(c, db, blocks);
      }

      final stack = _stack(c, db, prefs, secPrefs);
      rekey = stack.rekey;
      backup = stack.backup;

      try {
        await rekey.rekey(
          oldPassphrase: oldPassphrase,
          newPassphrase: newPassphrase,
          newSeed: altSeedB64,
        );
        rekeyError = null;
      } catch (e) {
        rekeyError = e;
      }
      try {
        exportJson = await backup.exportToJson();
      } catch (_) {
        exportJson = null;
      }
    });

    test('B1: rekey() completes without error against the canonical web fixture',
        () {
      expect(
        rekeyError,
        isNull,
        reason: 're-key threw: $rekeyError — R1/R2 divergence: the web wire '
            'genesis stores a NESTED identity.recovery_seed_enc, but Flutter '
            're-key reads a FLAT data_enc.seed',
      );
    });

    test('B2: mintNewSeed() returns a distinct 32-byte seed', () {
      final s = rekey.mintNewSeed(validSeedB64);
      expect(base64.decode(s).length, 32);
      expect(s, isNot(validSeedB64));
    });

    test('B3: exported wire genesis emits identity.recovery_seed_enc decrypted by the NEW PDK', () {
      expect(rekeyError, isNull,
          reason: 're-key did not complete (see B1): $rekeyError');
      final list = jsonDecode(exportJson!) as List<dynamic>;
      final genesis = list.first as Map<String, dynamic>;
      final identity = genesis['identity'];
      expect(identity, isA<Map<String, dynamic>>(),
          reason: 'genesis must carry a nested identity object (currently '
              'dropped by the Flutter storage-format re-key path)');
      final rec = (identity as Map)['recovery_seed_enc'] as String?;
      expect(rec, isNotNull, reason: 'identity.recovery_seed_enc must be present on the wire');
      final newPdk = c.derivePdk(newPassphrase, CryptoService.pdkIterations);
      expect(c.decrypt(rec!, newPdk), altSeedB64,
          reason: 'identity.recovery_seed_enc must decrypt under the NEW PDK');
    });

    test('B4: every _enc field re-encrypted under NEW MK; content_hash invariant', () {
      expect(rekeyError, isNull,
          reason: 're-key did not complete (see B1): $rekeyError');
      final enc = _collectEnc(jsonDecode(exportJson!) as List<dynamic>);
      for (final e in enc) {
        expect(c.decrypt(e.ct, newMK), isNotEmpty,
            reason: '${e.blockType}.${e.key} must decrypt under the NEW MK');
        expect(_tryDecrypt(c, e.ct, oldMK), isNot(c.decrypt(e.ct, newMK)),
            reason: '${e.blockType}.${e.key} must NOT decrypt under the OLD MK');
      }
      expect(enc.length, greaterThan(0), reason: 'at least one _enc field must exist');
    });

    test('B5: Flutter chain.verify() VALID under the new MK', () {
      expect(rekeyError, isNull,
          reason: 're-key did not complete (see B1) — cannot verify under the new MK');
      c.setMasterKey(newMK);
      expect(_chain(c, db).verify(), isTrue,
          reason: 're-keyed chain must verify under the NEW MK on Flutter');
    });

    test('B6: re-key emits the re-keyed chain to the shared wire artifact', () {
      expect(rekeyError, isNull,
          reason: 're-key did not complete (see B1): $rekeyError');
      final artifact = {
        'version': 1,
        'rekeyer': 'flutter',
        'new_seed': altSeedB64,
        'new_mk': newMK,
        'new_passphrase': newPassphrase,
        'blocks': jsonDecode(exportJson!),
      };
      final f = File(flutterArtifactPath);
      f.writeAsStringSync('${const JsonEncoder.withIndent('  ').convert(artifact)}\n');
      expect(f.existsSync(), isTrue);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group A — Web re-keyer → Flutter verifier (A7–A12, Flutter side)
  // ═══════════════════════════════════════════════════════════════
  group('Group A: Flutter verifier of the web re-keyed wire (A7–A12)', () {
    late CryptoService c;
    late AppDatabase db;
    late List<dynamic>? blocks;

    setUpAll(() async {
      c = _crypto();
      db = AppDatabase.inMemory();
      blocks = _readBlocks(webArtifactPath);
      if (blocks != null) {
        final backup = LedgerBackupService(db: db);
        await backup.importFromJson(jsonEncode(blocks!));
      }
      c.setMasterKey(newMK);
    });

    test('A7: flutter pulls (loads) the web re-keyed chain with no error', () {
      expect(blocks, isNotNull,
          reason: 'web re-keyed wire artifact absent — run the web re-key probe '
              '(c2_cross_client_verify.mjs, Group A) first');
      expect(blocks!.length, greaterThan(0));
    });

    test('A8: flutter chain.verify() VALID under the new MK', () {
      expect(blocks, isNotNull,
          reason: 'web re-keyed wire artifact absent — run the web re-key probe first');
      expect(_chain(c, db).verify(), isTrue,
          reason: 'Flutter must verify the web re-keyed chain (seals + entry '
              'hash + content_hash + key_version + prev_hash linkage)');
    });

    test('A9: flutter genesis parity — nested identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback}', () {
      expect(blocks, isNotNull,
          reason: 'web re-keyed wire artifact absent — run the web re-key probe first');
      final genesis = _chain(c, db).readAll().first;
      expect(genesis['identity'], isA<Map<String, dynamic>>(),
          reason: 'R1: Flutter import drops the nested identity — the web '
              'genesis identity object is not preserved on import');
    });

    test('A11: flutter device holding the OLD MK cannot decrypt the re-keyed ciphertext', () {
      expect(blocks, isNotNull,
          reason: 'web re-keyed wire artifact absent — run the web re-key probe first');
      final enc = _collectEnc(blocks!);
      for (final e in enc) {
        final correct = c.decrypt(e.ct, newMK);
        expect(correct, isNotEmpty, reason: '${e.blockType}.${e.key} must decrypt under NEW MK (sanity)');
        expect(_tryDecrypt(c, e.ct, oldMK), isNot(correct),
            reason: '${e.blockType}.${e.key} must NOT decrypt under the OLD MK (leak-nullification)');
      }
      expect(enc.length, greaterThan(0));
    });

    test('A10: flutter index.json / hash_index.json / genesis parity intact after pull',
        skip: 'deferred to live R2 E2E (Phase 3) — no hermetic index equivalent', () {});
    test('A12: flutter stale device-cookie specifier → reauthNeeded on next sync',
        skip: 'deferred to live R2 E2E (Phase 3) — requires a live sync transport', () {});
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C — Cross-client cryptographic invariants (C1–C8, Flutter side)
  // ═══════════════════════════════════════════════════════════════
  group('Group C: cross-client cryptographic invariants (Flutter side)', () {
    test('C1: deriveMasterKey(newSeed) yields the raw 32 seed bytes as the new MK', () {
      final c = _crypto();
      expect(c.deriveMasterKey(altSeedB64), newMK,
          reason: 'Flutter deriveMasterKey must match the web/WASM value');
    });

    test('C2: new MK ≠ old MK; new seed ≠ old seed', () {
      expect(newMK, isNot(oldMK));
      expect(altSeedB64, isNot(validSeedB64));
    });

    test('C3: content_hash parity — Flutter verifyContentHash matches the committed (web) content_hash', () {
      final fixture = _readArtifact(fixturePath)!;
      final c = _crypto();
      final blocks = (fixture['blocks'] as List).cast<Map<String, dynamic>>();
      // Reconstruct via the DB adapter so verify() exercises the full
      // store→map→verifyContentHash path under the OLD MK.
      final db = AppDatabase.inMemory();
      LedgerBlockStore(db.blockDao).appendBlocks(blocks);
      expect(_chain(c, db).verify(), isTrue,
          reason: 'fixture chain must verify (seal + entry hash + content_hash) under the OLD MK');
    });

    test('C4: key_version parity — fixture key_version is 1 (no bump)', () {
      final fixture = _readArtifact(fixturePath)!;
      for (final b in (fixture['blocks'] as List)) {
        final map = b as Map<String, dynamic>;
        expect(map['key_version'] ?? 1, 1, reason: '${map['type']} key_version must be 1');
      }
    });

    test('C5: identity parity — identity_pub_key == SHA-256(identity_secret)', () {
      final fixture = _readArtifact(fixturePath)!;
      final genesis = (fixture['blocks'] as List).first as Map<String, dynamic>;
      final identity = genesis['identity'] as Map<String, dynamic>?;
      expect(identity, isNotNull, reason: 'fixture genesis must carry a nested identity');
      final c = _crypto();
      expect(identity!['identity_pub_key'], c.sha256(identitySecret),
          reason: 'identity_pub_key must equal SHA-256(identity_secret) on both clients');
    });

    test('C6: prev_hash cascade intact in the committed fixture', () {
      final fixture = _readArtifact(fixturePath)!;
      final blocks = (fixture['blocks'] as List).cast<Map<String, dynamic>>();
      for (var i = 1; i < blocks.length; i++) {
        final prev = blocks[i - 1];
        final prevHash = prev['block_hash'] ?? prev['day_hash'] ?? prev['month_hash'] ?? prev['year_hash'];
        expect(blocks[i]['prev_hash'], prevHash,
            reason: 'block $i prev_hash must link to its predecessor');
      }
    });

    test('C7: fixture plaintext intact — every _enc decrypts to a non-empty string under the OLD MK', () {
      final fixture = _readArtifact(fixturePath)!;
      final c = _crypto();
      final enc = _collectEnc((fixture['blocks'] as List));
      for (final e in enc) {
        expect(c.decrypt(e.ct, oldMK), isNotEmpty,
            reason: '${e.blockType}.${e.key} must decrypt under the OLD MK (plaintext intact)');
      }
      expect(enc.length, greaterThan(0));
    });

    test('C8: seal-key derivation parity — Flutter recompute equals the committed (web) seal', () {
      final fixture = _readArtifact(fixturePath)!;
      final c = _crypto();
      final chain = _chain(c, AppDatabase.inMemory());
      for (final b in (fixture['blocks'] as List)) {
        final map = (b as Map).cast<String, dynamic>();
        final committed = map['block_hash'] ?? map['day_hash'] ?? map['month_hash'] ?? map['year_hash'];
        expect(chain.sealBlock(map), committed,
            reason: '${map['type']} seal must match the committed web seal (cross-client parity)');
      }
    });
  });
}
