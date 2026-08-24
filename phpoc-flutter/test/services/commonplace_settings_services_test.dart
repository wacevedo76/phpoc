import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';
import 'package:phpoc_flutter/services/rekey_service.dart';

/// Phase 2 (RED) — Commonplace Book Settings: service-layer extensions.
///
/// Implements the service-level assertions from
/// docs/planning/flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md:
/// - Group R (CPS-R1..R7): re-key extends `RekeyService` to re-encrypt the
///   `commonplace.json` chain under the new MK, re-seal it, stay atomic, and
///   surface `commonplaceBlocksReencrypted`/`commonplaceEntriesReencrypted`
///   on the result (CPS-R8, the shared re-key dialog reachability, is the
///   screen-level widget test in `commonplace_settings_screen_test.dart`).
/// - Group C (CPS-C1/C2): `OnboardingService.clearAllData()` also resets the
///   Commonplace chain (idempotent), and the Ledger/Commonplace clear both
///   books symmetrically.
/// - Group T (CPS-T1/T2/T3): `AppPreferences` persists a separate
///   `commonplace_theme_mode` key distinct from `theme_mode`.
///
/// Expected: these tests FAIL (RED) because the service signatures below
/// (extra `commonplaceService` on `RekeyService`, `clearCommonplace` on
/// `OnboardingService`, and `get/setCommonplaceThemeMode` on preferences)
/// are not implemented yet (Phase 3).

/// 32 bytes of 0x42 = base64 "QkJC..." — 32×0x42 bytes (fixture seed, NOT real).
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

/// 32 bytes of 0x21 = base64 "ISEh..." — a different fixture seed (NOT real).
const altSeedB64 = 'ISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISE=';

/// MK for [validSeedB64] (hex of raw 32×0x42 seed bytes).
const oldMK = '4242424242424242424242424242424242424242424242424242424242424242';

/// MK for [altSeedB64] (hex of raw 32×0x21 seed bytes).
const newMK = '2121212121212121212121212121212121212121212121212121212121212121';

/// A valid passphrase (≥8 chars).
const validPassphrase = 'CorrectHorseBatteryStaple42!';

/// A different valid passphrase.
const newPassphrase = 'NewCorrectHorseBatteryStaple99!';

// ═══════════════════════════════════════════════════════════════
// Test fixture helpers
// ═══════════════════════════════════════════════════════════════

/// In-memory block-store fake matching the `CommonplaceStorage` store contract.
class _FakeCommonplaceStore {
  final List<Map<String, dynamic>> _blocks = [];
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e);
  }
  void appendBlocks(List<Map<String, dynamic>> blocks) =>
      _blocks.addAll(blocks);
  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }
  int getBlockCount() => _blocks.length;
  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;
}

/// An initialized [CryptoService], caching [oldMK].
CryptoService _crypto() {
  final c = CryptoService()..initialize();
  c.setMasterKey(oldMK);
  return c;
}

/// A [CommonplaceService] over an in-memory store, seeded with a genesis +
/// [count] committed passages, sealed under [mkHex].
Future<CommonplaceService> _makeCommonplace(String mkHex, {int count = 2}) async {
  final crypto = CryptoService()..initialize();
  crypto.setMasterKey(mkHex);
  final service = CommonplaceService(
    crypto: crypto,
    store: _FakeCommonplaceStore(),
  );
  await service.ensureGenesis(
    username: 'cp-user',
    email: 'cp@example.com',
    recoverySeedEnc: 'enc-seed',
    identityPubKey: 'pub',
    identitySecretEncFallback: 'fb',
  );
  for (var i = 0; i < count; i++) {
    await service.addEntry(
      title: 'Note $i',
      entry: 'passage $i',
      tags: const ['theme'],
      adHoc: {'src': 'test'},
    );
  }
  return service;
}

/// Seed the ledger (genesis + one day block) with a vault, mirroring
/// `rekey_service_test.dart`.
Future<void> _seedLedger({
  required CryptoService crypto,
  required AppDatabase db,
  required String passphrase,
  required String seedB64,
}) async {
  final pdk = crypto.derivePdk(passphrase, CryptoService.pdkIterations);
  final encryptedSeed = crypto.encrypt(seedB64, pdk);
  final genesisData = json.encode({'seed': encryptedSeed});
  final dataEncB64 = base64.encode(utf8.encode(genesisData));
  final seal = crypto.seal(dataEncB64, oldMK);

  await db.blockDao.insertBlock(Block(
    blockId: 'genesis-test',
    blockType: BlockType.genesis,
    blockIndex: 0,
    keyVersion: 1,
    dataEnc: dataEncB64,
    identitySeal: seal,
    prevHash: Block.genesisPrevHash,
    createdAt: 1700000000,
  ));
  await db.setSeedVault(encryptedSeed);
}

/// The future [RekeyService] constructor accepting a `commonplaceService`.
///
/// RED: this signature does not exist yet — Phase 3 adds the optional
/// `commonplaceService` (or equivalent) and re-encrypts the Commonplace chain.
RekeyService _makeRekey({
  required CryptoService crypto,
  required AppDatabase db,
  required AppPreferences prefs,
  required SecurePreferences secPrefs,
  CommonplaceService? commonplaceService,
}) {
  final auth = AuthService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: secPrefs,
  );
  return RekeyService(
    auth: auth,
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: secPrefs,
    backupService: LedgerBackupService(db: db),
    commonplaceService: commonplaceService,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group R: Re-key re-encrypts the Commonplace chain (CPS-R1..R8)
  // ═══════════════════════════════════════════════════════════════
  group('R: Re-key extends RekeyService to re-encrypt commonplace.json', () {
    test('CPS-R1: after a re-key the Commonplace entries decrypt under the NEW MK',
        () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK);
      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: commonplace,
      );
      await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      // The live crypto session is now under the NEW MK. Reading entries must
      // still decrypt the re-encrypted Commonplace chain.
      final entries = await commonplace.readEntries();
      expect(entries, isNotEmpty,
          reason: 'Commonplace chain must survive re-key');
      for (final e in entries) {
        expect(e['entry'], startsWith('passage '),
            reason: 'entry must decrypt under the NEW MK after re-key');
      }
    });

    test('CPS-R2: the Commonplace chain still verifies after re-key', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK);
      expect(commonplace.verify(), isTrue, reason: 'pre-re-key chain valid');
      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: commonplace,
      );
      await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      expect(commonplace.verify(), isTrue,
          reason: 'seals re-derived under new MK must still verify');
    });

    test('CPS-R3: non-encrypted Commonplace fields are untouched by re-key',
        () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK, count: 1);
      // Capture pre-re-key header (timestamp_ms/date/type — plaintext fields).
      final before = (await commonplace.readEntries()).single;
      final beforeStamp = before['timestamp_ms'];
      final beforeDate = before['date'];

      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: commonplace,
      );
      await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      final after = (await commonplace.readEntries()).single;
      expect(after['timestamp_ms'], beforeStamp,
          reason: 'plaintext timestamp_ms must be preserved (R9 parity)');
      expect(after['date'], beforeDate,
          reason: 'plaintext date must be preserved');
      expect(after['ad_hoc'], {'src': 'test'},
          reason: 'ad_hoc re-encrypted content must decode back identically');
    });

    test('CPS-R4: the ledger re-key path is unchanged in behavior', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK);
      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: commonplace,
      );

      await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      // Ledger vault now decrypts under the NEW PDK to the new seed.
      final vault = await db.getSeedVault();
      final newPdk = crypto.derivePdk(newPassphrase, CryptoService.pdkIterations);
      expect(crypto.decrypt(vault!, newPdk), altSeedB64,
          reason: 'ledger vault must still re-key (no regression)');
      // Vault cannot be decrypted by the old PDK.
      final oldPdk = crypto.derivePdk(validPassphrase, CryptoService.pdkIterations);
      expect(() => crypto.decrypt(vault, oldPdk), throwsA(isA<Exception>()),
          reason: 'old PDK must not decrypt the re-keyed vault');
    });

    test('CPS-R5: re-key re-encrypts the Commonplace genesis recovery_seed_enc '
        '(if populated) under the new key set', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      // Build a Commonplace chain whose genesis carries a non-empty seed.
      final cpCrypto = CryptoService()..initialize();
      cpCrypto.setMasterKey(oldMK);
      final service = CommonplaceService(
        crypto: cpCrypto,
        store: _FakeCommonplaceStore(),
      );
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: crypto.encrypt(validSeedB64, oldMK),
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );

      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: service,
      );
      await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      // Genesis recovery_seed_enc must now decrypt under the NEW MK.
      final genesis = service.engine.chain.readAll().first;
      final seedEnc = genesis['recovery_seed_enc'] as String;
      expect(crypto.decrypt(seedEnc, newMK), isNotEmpty,
          reason: 'recovery_seed_enc must be re-encrypted under the new MK');
    });

    test('CPS-R6: a failed Commonplace re-encrypt aborts before any write '
        '(no partial cross-chain re-key)', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      // Capture pre-re-key ledger vault + block count.
      final vaultBefore = await db.getSeedVault();
      final ledgerBlocksBefore = (await db.blockDao.getAllBlocks()).length;

      // A Commonplace service whose store throws on append — forces the
      // re-encrypt step to fail AFTER the ledger preflight but BEFORE any
      // cross-chain write can persist.
      final brokenService = CommonplaceService(
        crypto: crypto,
        store: _ThrowingCommonplaceStore(),
      );
      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: brokenService,
      );

      await expectLater(
        rekey.rekey(
          oldPassphrase: validPassphrase,
          newPassphrase: newPassphrase,
          newSeed: altSeedB64,
        ),
        throwsA(isA<StateError>()),
        reason: 'a Commonplace re-encrypt failure must abort the re-key',
      );

      // No partial write on the LEDGER side: vault + blocks unchanged.
      final vaultAfter = await db.getSeedVault();
      expect(vaultAfter, vaultBefore,
          reason: 'vault must be untouched after failed Commonplace re-key');
      expect((await db.blockDao.getAllBlocks()).length, ledgerBlocksBefore,
          reason: 'ledger blocks must be untouched');
      // The broken Commonplace store remains un-modified (no partial re-seal).
      expect(brokenService.store.getBlockCount(), 0,
          reason: 'no Commonplace block may be re-sealed before the abort');
    });

    test('CPS-R7: RekeyResult surfaces how many Commonplace blocks/entries '
        'were re-encrypted', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK, count: 3);
      final totalCpBlocks = commonplace.engine.chain.readAll().length;

      final rekey = _makeRekey(
        crypto: crypto,
        db: db,
        prefs: prefs,
        secPrefs: secPrefs,
        commonplaceService: commonplace,
      );
      final result = await rekey.rekey(
        oldPassphrase: validPassphrase,
        newPassphrase: newPassphrase,
        newSeed: altSeedB64,
      );

      expect(result.commonplaceBlocksReencrypted, totalCpBlocks,
          reason: 'the result must report the Commonplace blocks re-encrypted');
      expect(result.commonplaceEntriesReencrypted, 3,
          reason: 'the result must report the Commonplace entries re-encrypted');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: Clear All Data (both books) — service layer (CPS-C1/C2)
  // ═══════════════════════════════════════════════════════════════
  group('C: OnboardingService.clearAllData widens to the Commonplace chain', () {
    test('CPS-C1: clearAllData() also resets the Commonplace chain (not just '
        'the Ledger DB)', () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      final commonplace = await _makeCommonplace(oldMK, count: 2);
      expect(commonplace.engine.chain.readAll().length, greaterThan(0));

      final onboarding = _makeOnboarding(crypto, db, prefs, secPrefs,
          commonplaceService: commonplace);
      await onboarding.clearAllData();

      expect(commonplace.engine.chain.readAll(), isEmpty,
          reason: 'clearAllData must wipe the Commonplace chain too');
      expect(commonplace.engine.getBlockCount(), 0,
          reason: 'no Commonplace blocks remain after clear-all');
    });

    test('CPS-C2: clearAllData is idempotent when commonplace.json is absent',
        () async {
      final crypto = _crypto();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final secPrefs = SecurePreferences.testInstance();
      await _seedLedger(
          crypto: crypto, db: db, passphrase: validPassphrase, seedB64: validSeedB64);
      // A fresh Commonplace service with NO genesis — must not throw.
      final emptyCp = CommonplaceService(
        crypto: crypto,
        store: _FakeCommonplaceStore(),
      );

      final onboarding = _makeOnboarding(crypto, db, prefs, secPrefs,
          commonplaceService: emptyCp);
      // Twice, to prove idempotency.
      await onboarding.clearAllData();
      await onboarding.clearAllData();

      expect(emptyCp.engine.getBlockCount(), 0,
          reason: 'no exception and chain stays empty');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group T: per-book theme preference storage (CPS-T1/T2/T3)
  // ═══════════════════════════════════════════════════════════════
  group('T: AppPreferences holds a separate commonplace_theme_mode', () {
    test('CPS-T1: a separate commonplace_theme_mode key is persisted apart '
        'from theme_mode', () async {
      final prefs = AppPreferences.testInstance();
      await prefs.setThemeMode('greenDark');
      await prefs.setCommonplaceThemeMode('fuchsiaGold');

      expect(await prefs.getThemeMode(), 'greenDark');
      expect(await prefs.getCommonplaceThemeMode(), 'fuchsiaGold',
          reason: 'commonplace theme must be stored under its own key');
    });

    test('CPS-T2: setting the Commonplace theme does not write to theme_mode',
        () async {
      final prefs = AppPreferences.testInstance();
      await prefs.setThemeMode('greenLight');
      await prefs.setCommonplaceThemeMode('catppuccinMocha');

      expect(await prefs.getThemeMode(), 'greenLight',
          reason: 'theme_mode must be untouched');
      expect(await prefs.getCommonplaceThemeMode(), 'catppuccinMocha');
    });

    test('CPS-T3: changing the Commonplace theme leaves theme_mode unaffected '
        'and vice versa', () async {
      final prefs = AppPreferences.testInstance();
      await prefs.setThemeMode('fuchsiaCyan');
      await prefs.setCommonplaceThemeMode('fuchsiaPurple');

      // Change the Commonplace theme twice — theme_mode stays fixed.
      await prefs.setCommonplaceThemeMode('greenLight');
      await prefs.setCommonplaceThemeMode('greenDark');
      expect(await prefs.getThemeMode(), 'fuchsiaCyan',
          reason: 'one book does not clobber the other stored value');

      // And the Ledger theme change does not touch the Commonplace value.
      await prefs.setThemeMode('catppuccinLatte');
      expect(await prefs.getCommonplaceThemeMode(), 'greenDark');
    });
  });
}

/// A store that throws on any append — used to force a Commonplace re-encrypt
/// failure so CPS-R6 can assert atomicity (no partial write).
class _ThrowingCommonplaceStore {
  final int _count = 0;
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) =>
      const [];
  void appendBlocks(List<Map<String, dynamic>> blocks) =>
      throw StateError('append failed');
  List<Map<String, dynamic>> truncate(int keepCount) => const [];
  int getBlockCount() => _count;
  Map<String, dynamic>? getLastBlock() => null;
}

/// Build an [OnboardingService] wired to a real in-memory [StagingStore] and
/// [SyncService] plus the (future) [commonplaceService] extension.
OnboardingService _makeOnboarding(
  CryptoService crypto,
  AppDatabase db,
  AppPreferences prefs,
  SecurePreferences secPrefs, {
  required CommonplaceService commonplaceService,
}) {
  final sync = SyncService(
    storage: _NoopStorage(),
    crypto: crypto,
    stagingStore: StagingStore(db),
  );
  return OnboardingService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: secPrefs,
    syncService: sync,
    commonplaceService: commonplaceService,
  );
}

class _NoopStorage {
  final _map = <String, dynamic>{};
  Future<dynamic> get(String key) async => _map[key];
  Future<void> set(String key, dynamic value) async => _map[key] = value;
  Future<void> remove(String key) async => _map.remove(key);
}
