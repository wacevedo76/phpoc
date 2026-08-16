import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_storage.dart';

/// CommonplaceStorage — Phase 2 (RED) test suite.
///
/// All 9 assertions from docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md
/// Group E: CommonplaceStorage — Separate-File Persistence.
///
/// Expected: all tests FAIL (RED) because commonplace_storage.dart does not
/// exist yet.

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Temp file path helper (no repo writes; under the OS temp dir).
String _tmpPath(String name) {
  final dir = '${Directory.systemTemp.path}/commonplace_test';
  return '$dir/$name';
}

/// Delete a temp file if it exists (used to reset test state).
Future<void> _deleteIfExists(String path) async {
  final f = File(path);
  if (await f.exists()) {
    await f.delete();
  }
}

Map<String, dynamic> _entry({required String title}) => {
      'title': title,
      'tags': <String>['topic'],
      'entry': 'some passage',
      'timestamp_ms': 1700000000000,
    };

/// Build a chain, seed a genesis, commit one entry, and save to [storage].
CommonplaceEngine _engineOn(CommonplaceStorage storage) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  return CommonplaceEngine(
    crypto: crypto,
    store: storage,
    identitySecret: identitySecret,
  );
}

void main() {
  group('E: CommonplaceStorage — Separate-File Persistence', () {
    // CP-E1 — load() reads a commonplace.json that exports as a chain structure
    test('CP-E1: load() reads a commonplace.json as a chain structure', () async {
      final path = _tmpPath('e1_commonplace.json');
      await _deleteIfExists(path);

      // Save a chain via the storage API.
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = CommonplaceEngine(
        crypto: crypto,
        store: storage,
        identitySecret: identitySecret,
      );
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.commit([_entry(title: 'Persisted note')]);
      await storage.save();

      // Load it back into a fresh storage and confirm it exports as a chain.
      final loaded = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      await loaded.load();
      expect(loaded.getBlockCount(), greaterThanOrEqualTo(2));
    });

    // CP-E2 — save() writes a standalone, importable commonplace.json
    test('CP-E2: save() writes a standalone commonplace.json file', () async {
      final path = _tmpPath('e2_commonplace.json');
      await _deleteIfExists(path);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = _engineOn(storage);
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      await storage.save();

      expect(await File(path).exists(), isTrue);
      final json = await File(path).readAsString();
      final parsed = jsonDecode(json) as Map<String, dynamic>;
      // Self-contained chain structure with genesis + blocks.
      expect(parsed.containsKey('blocks') ||
          parsed.containsKey('chain') ||
          parsed.containsKey('genesis'), isTrue);
    });

    // CP-E3 — saved-then-loaded Commonplace chain verifies identically
    test('CP-E3: a saved-and-reloaded chain verifies identically', () async {
      final path = _tmpPath('e3_commonplace.json');
      await _deleteIfExists(path);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = _engineOn(storage);
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.commit([_entry(title: 'Round trip')]);
      expect(engine.verify(), isTrue);
      final originalBlockHash =
          storage.getLastBlock()!['block_hash'] ?? storage.getLastBlock()!['day_hash'];
      await storage.save();

      final loaded = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      await loaded.load();
      final loadedChain = CommonplaceChain(
        crypto: crypto,
        store: loaded,
        identitySecret: identitySecret,
      );
      expect(loadedChain.verify(), isTrue);
      expect(loaded.getLastBlock()!['block_hash'] ??
          loaded.getLastBlock()!['day_hash'], originalBlockHash);
    });

    // CP-E4 — commonplace.json contains no staging rows
    test('CP-E4: commonplace.json contains no staging rows', () async {
      final path = _tmpPath('e4_commonplace.json');
      await _deleteIfExists(path);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = _engineOn(storage);
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.commit([_entry(title: 'Clean')]);
      await storage.save();

      final json = await File(path).readAsString();
      // No staging markers leak into the exported chain.
      expect(json.contains('staging'), isFalse);
      expect(json.contains('plain:'), isFalse);
      expect(json.contains('unsealed'), isFalse);
    });

    // CP-E5 — loading a missing file returns a fresh (genesis-able) chain
    test('CP-E5: loading a missing commonplace.json yields a fresh chain',
        () async {
      final path = _tmpPath('e5_missing.json');
      await _deleteIfExists(path);

      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      expect(await File(path).exists(), isFalse);
      await storage.load();

      // A fresh storage can build a genesis without error.
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final chain = CommonplaceChain(
        crypto: crypto,
        store: storage,
        identitySecret: identitySecret,
      );
      expect(() => chain.buildGenesis(
            username: 'u',
            email: 'u@e.com',
            recoverySeedEnc: 'seed',
            identityPubKey: 'pk',
            identitySecretEncFallback: 'fb',
          ), returnsNormally);
      expect(chain.getBlockCount(), 1);
    });

    // CP-E6 — loading a corrupt file surfaces an error, not a crash
    test('CP-E6: loading a corrupt commonplace.json surfaces an error', () async {
      final path = _tmpPath('e6_corrupt.json');
      await _deleteIfExists(path);
      await File(path).writeAsString('{ not valid json !!');

      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      await expectLater(storage.load(), throwsException);
    });

    // CP-E7 — commonplace.json content is encrypted at rest
    test('CP-E7: file contents are encrypted at rest (no plaintext fields)',
        () async {
      final path = _tmpPath('e7_commonplace.json');
      await _deleteIfExists(path);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = _engineOn(storage);
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      final secretTitle = 'TopSecretPassageTitle';
      engine.commit([_entry(title: secretTitle)]);
      await storage.save();

      final json = await File(path).readAsString();
      expect(json.contains(secretTitle), isFalse);
      expect(json.contains('_enc'), isTrue);
    });

    // CP-E8 — file path is decoupled from the shared master key derivation
    test('CP-E8: the file path is independent of the master key derivation', () {
      // The storage location carries no crypto burden — importing from any path
      // still yields a chain that builds under the same MK.
      final storage = CommonplaceStorage(
          filePath: '/any/arbitrary/location/commonplace.json',
          masterKeyHex: mkHex);
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final chain = CommonplaceChain(
        crypto: crypto,
        store: storage,
        identitySecret: identitySecret,
      );

      // Path does not influence the genesis/hash derivation.
      final a = chain.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      expect(a['prev_hash'], '0' * 64);
    });

    // CP-E9 — same-passphrase re-auth re-derives the MK that decrypts a file
    test('CP-E9: the shared MK decrypts an existing commonplace.json', () async {
      final path = _tmpPath('e9_commonplace.json');
      await _deleteIfExists(path);

      // Writer crypto derives + caches MK.
      final writer = CryptoService();
      writer.initialize();
      writer.setMasterKey(mkHex);
      final storage = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      final engine = CommonplaceEngine(
        crypto: writer,
        store: storage,
        identitySecret: identitySecret,
      );
      engine.buildGenesis(
        username: 'u',
        email: 'u@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.commit([_entry(title: 'Reauth note')]);
      await storage.save();

      // A second crypto instance (same seed→same MK) must decrypt the file.
      final reader = CryptoService();
      reader.initialize();
      reader.setMasterKey(mkHex);
      final loaded = CommonplaceStorage(filePath: path, masterKeyHex: mkHex);
      await loaded.load();
      final loadedChain = CommonplaceChain(
        crypto: reader,
        store: loaded,
        identitySecret: identitySecret,
      );
      expect(loadedChain.verify(), isTrue);
    });
  });
}
