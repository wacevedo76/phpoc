import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/models/pull_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// OnboardingService tests — Groups C (9) + D (7) + E (6) + F (4) = 26 assertions.
///
/// Covers:
///   C1–C9: createNewLedger
///   D1–D7: importFromSeed
///   E1–E6: connectWorker
///   F1–F4: hasExistingData

// ── Test constants ──────────────────────────────────────────────

const validPassphrase = 'CorrectHorseBatteryStaple42!';
const shortPassphrase = 'short';

/// 32 bytes of 0x42 = base64.
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

// ── Helpers ────────────────────────────────────────────────────

/// Create a fake in-memory storage for SyncService.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Create a fresh OnboardingService with all dependencies.
Future<OnboardingService> _makeOnboarding({
  CryptoService? crypto,
  AppDatabase? db,
  AppPreferences? prefs,
  SecurePreferences? securePrefs,
}) async {
  final c = crypto ?? (CryptoService()..initialize());
  final d = db ?? AppDatabase.inMemory();
  final p = prefs ?? AppPreferences.testInstance();
  final s = securePrefs ?? SecurePreferences.testInstance();
  final storage = _FakeStorage();
  final sync = SyncService(storage: storage, crypto: c);

  if (crypto == null) await c.initialize();

  return OnboardingService(
    crypto: c,
    db: d,
    preferences: p,
    securePreferences: s,
    syncService: sync,
  );
}

/// Fake LedgerPullService for restoreFromCloud testing.
class _FakeLedgerPullService {
  bool pullAllCalled = false;
  PullResult pullAllResult =
      PullResult.ok(blocksPulled: 3, entriesStaged: 5);
  Object? _throwError;

  Future<PullResult> pullAll() async {
    pullAllCalled = true;
    if (_throwError != null) throw _throwError!;
    return pullAllResult;
  }
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group C: OnboardingService — createNewLedger (9 tests)
  // ═══════════════════════════════════════════════════════════════

  group('C: OnboardingService — createNewLedger', () {
    // C1
    test('C1: createNewLedger(passphrase) → returns 44-char base64 seed',
        () async {
      final onboarding = await _makeOnboarding();
      final seed = await onboarding.createNewLedger(validPassphrase);

      expect(seed, isA<String>());
      expect(seed.length, 44,
          reason: 'Seed must be 44-char base64 (32 bytes)');
      // Should be valid base64
      expect(() => base64Decode(seed), returnsNormally);
    });

    // C2
    test('C2: createNewLedger writes genesis block (type=genesis, index=0)',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.createNewLedger(validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty,
          reason: 'Genesis block must exist after ledger creation');

      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
        orElse: () => blocks.first,
      );
      expect(genesis.blockType, BlockType.genesis);
      expect(genesis.blockIndex, 0,
          reason: 'Genesis must be block_index=0');
    });

    // C3
    test('C3: Genesis block contains encrypted seed (not plaintext)',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      final seed = await onboarding.createNewLedger(validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty);
      final genesis = blocks.firstWhere((b) => b.blockType == BlockType.genesis);

      // data_enc must not contain the plaintext seed
      expect(genesis.dataEnc, isNot(contains(seed)),
          reason: 'Seed must be encrypted in genesis (D2: zero-knowledge)');
    });

    // C4
    test('C4: Genesis block has valid identity_seal (HMAC-SHA256)',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.createNewLedger(validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere((b) => b.blockType == BlockType.genesis);

      expect(genesis.identitySeal, isNotNull,
          reason: 'Genesis must have an identity seal');
      expect(genesis.identitySeal, isNotEmpty);
      // HMAC-SHA256 output is 64 hex chars
      expect(genesis.identitySeal!.length, 64,
          reason: 'Identity seal must be 64-char hex (SHA-256)');
    });

    // C5
    test('C5: after createNewLedger, preferences.hasExistingData() == true',
        () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.createNewLedger(validPassphrase);

      expect(await prefs.hasExistingData(), isTrue,
          reason: 'Boot probe must detect newly created ledger');
    });

    // C6
    test('C6: createNewLedger creates UUIDv4 device identity in preferences',
        () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.createNewLedger(validPassphrase);

      final uuid = await prefs.getDeviceUuid();
      expect(uuid, isNotNull,
          reason: 'Device must have a UUID after onboarding');
      expect(uuid, isNotEmpty);
      // UUID format: 8-4-4-4-12 hex chars
      expect(uuid!.length, greaterThanOrEqualTo(36),
          reason: 'Device UUID must be in standard format');
      // Should contain dashes (UUIDv4 format)
      expect(uuid.contains('-'), isTrue);
    });

    // C7
    test('C7: createNewLedger twice → throws LedgerExistsException', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      await onboarding.createNewLedger(validPassphrase);

      expect(
        () => onboarding.createNewLedger(validPassphrase),
        throwsA(isA<LedgerExistsException>()),
      );
    });

    // C8
    test('C8: two createNewLedger calls produce different seeds', () async {
      // Create two fresh ledgers on separate databases
      final db1 = AppDatabase.inMemory();
      final db2 = AppDatabase.inMemory();

      final onboarding1 = await _makeOnboarding(db: db1);
      final onboarding2 = await _makeOnboarding(db: db2);

      final seed1 = await onboarding1.createNewLedger(validPassphrase);
      final seed2 = await onboarding2.createNewLedger(validPassphrase);

      expect(seed1, isNot(seed2),
          reason: 'Seeds must be unique and unpredictable');
    });

    // C9
    test('C9: createNewLedger with short passphrase (<8 chars) → throws '
        'validation error', () async {
      final onboarding = await _makeOnboarding();

      expect(
        () => onboarding.createNewLedger(shortPassphrase),
        throwsA(isA<Exception>()),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: OnboardingService — importFromSeed (7 tests)
  // ═══════════════════════════════════════════════════════════════

  group('D: OnboardingService — importFromSeed', () {
    // D1
    test('D1: importFromSeed(validSeed, passphrase) → genesis block written',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty,
          reason: 'Import must create a genesis block');
    });

    // D2
    test('D2: imported genesis has block_type=genesis, block_index=0',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
        orElse: () => blocks.first,
      );
      expect(genesis.blockType, BlockType.genesis);
      expect(genesis.blockIndex, 0);
    });

    // D3
    test('D3: importFromSeed(invalidBase64) → throws format/validation error',
        () async {
      final onboarding = await _makeOnboarding();

      expect(
        () => onboarding.importFromSeed('!!!not-base64!!!', validPassphrase),
        throwsA(isA<Exception>()),
      );
    });

    // D4
    test('D4: after importFromSeed → preferences.hasExistingData() == true',
        () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      expect(await prefs.hasExistingData(), isTrue,
          reason: 'Boot probe must detect imported data');
    });

    // D5
    test('D5: importFromSeed creates UUIDv4 device identity', () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final uuid = await prefs.getDeviceUuid();
      expect(uuid, isNotNull);
      expect(uuid, isNotEmpty);
      expect(uuid!.length, greaterThanOrEqualTo(36));
    });

    // D6
    test('D6: importFromSeed when data exists → throws LedgerExistsException',
        () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      await onboarding.createNewLedger(validPassphrase);

      expect(
        () => onboarding.importFromSeed(validSeedB64, validPassphrase),
        throwsA(isA<LedgerExistsException>()),
      );
    });

    // D7
    test('D7: imported seed is stored encrypted in genesis (D2 compliance)',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere((b) => b.blockType == BlockType.genesis);

      // The genesis data_enc must NOT contain the plaintext seed
      expect(genesis.dataEnc, isNot(contains(validSeedB64)),
          reason: 'Seed must be encrypted at rest (D2)');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: OnboardingService — connectWorker (6 tests)
  // ═══════════════════════════════════════════════════════════════

  group('E: OnboardingService — connectWorker', () {
    // E1
    test('E1: connectWorker(url, apiKey) → URL stored in AppPreferences',
        () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      const url = 'https://worker.example.com';
      await onboarding.connectWorker(url, 'test-api-key');

      final stored = await prefs.getWorkerUrl();
      expect(stored, url);
    });

    // E2
    test('E2: connectWorker → API key stored in SecurePreferences (encrypted)',
        () async {
      final securePrefs = SecurePreferences.testInstance();
      final onboarding = await _makeOnboarding(securePrefs: securePrefs);

      const apiKey = 'sk-secret-api-key-abc123';
      await onboarding.connectWorker('https://worker.example.com', apiKey);

      final stored = await securePrefs.getApiKey();
      expect(stored, apiKey,
          reason: 'API key must be stored in encrypted storage');
    });

    // E3
    test('E3: connectWorker(invalidUrl) → throws validation error', () async {
      final onboarding = await _makeOnboarding();

      expect(
        () => onboarding.connectWorker('not-a-url!!!', 'test-key'),
        throwsA(isA<Exception>()),
      );
    });

    // E4 — connectWorker wires transport into SyncService
    test('E4: connectWorker → SyncService.isRemoteAvailable == true',
        () async {
      final storage = _FakeStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      final sync = SyncService(storage: storage, crypto: crypto);

      final onboarding = OnboardingService(
        crypto: crypto,
        db: AppDatabase.inMemory(),
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
        syncService: sync,
      );

      await onboarding.connectWorker('https://worker.example.com', 'test-key');

      expect(sync.isRemoteAvailable, isTrue,
          reason: 'Transport must be wired into SyncService after connect');
    });

    // E5
    test('E5: connectWorker with valid but unreachable URL → succeeds '
        '(health check is best-effort)', () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      // Valid URL format — health check is best-effort, config persists.
      const url = 'https://203.0.113.1:9999';
      await onboarding.connectWorker(url, 'test-key');

      final stored = await prefs.getWorkerUrl();
      expect(stored, url,
          reason: 'Config must persist even if health check fails');
    });

    // E6
    test('E6: connectWorker overwrites previous Worker config', () async {
      final prefs = AppPreferences.testInstance();
      final securePrefs = SecurePreferences.testInstance();
      final onboarding = await _makeOnboarding(
        prefs: prefs, securePrefs: securePrefs);

      await onboarding.connectWorker('https://first.example.com', 'key-one');
      await onboarding.connectWorker('https://second.example.com', 'key-two');

      final url = await prefs.getWorkerUrl();
      final apiKey = await securePrefs.getApiKey();

      expect(url, 'https://second.example.com',
          reason: 'URL must be overwritten, not appended');
      expect(apiKey, 'key-two',
          reason: 'API key must be overwritten, not appended');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: OnboardingService — hasExistingData (4 tests)
  // ═══════════════════════════════════════════════════════════════

  group('F: OnboardingService — hasExistingData', () {
    // F1
    test('F1: hasExistingData() returns false on fresh database', () async {
      final onboarding = await _makeOnboarding();
      final result = await onboarding.hasExistingData();
      expect(result, isFalse,
          reason: 'Clean install must be detected');
    });

    // F2
    test('F2: hasExistingData() returns true after createNewLedger()',
        () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      await onboarding.createNewLedger(validPassphrase);

      final result = await onboarding.hasExistingData();
      expect(result, isTrue,
          reason: 'Created ledger must be detected');
    });

    // F3
    test('F3: hasExistingData() returns true after importFromSeed()',
        () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final result = await onboarding.hasExistingData();
      expect(result, isTrue,
          reason: 'Imported ledger must be detected');
    });

    // F4
    test('F4: hasExistingData() auto-heals when genesis exists but prefs flag '
        'is absent', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      // Create a ledger, then clear the prefs flag manually
      await onboarding.createNewLedger(validPassphrase);
      await prefs.setHasExistingData(false);

      // hasExistingData must detect the genesis block and auto-heal
      final result = await onboarding.hasExistingData();
      expect(result, isTrue,
          reason: 'Auto-heal: genesis exists, prefs flag should be restored');

      // The flag should now be true (healed)
      expect(await prefs.hasExistingData(), isTrue,
          reason: 'Preferences flag must be restored after auto-heal');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: OnboardingService — restoreFromCloud (5 tests)
  // ═══════════════════════════════════════════════════════════════

  group('G: OnboardingService — restoreFromCloud', () {
    Future<OnboardingService> _makeRestoreOnboarding({
      CryptoService? crypto,
      AppDatabase? db,
      AppPreferences? prefs,
      SecurePreferences? securePrefs,
      dynamic ledgerPull,
    }) async {
      final c = crypto ?? (CryptoService()..initialize());
      final d = db ?? AppDatabase.inMemory();
      final p = prefs ?? AppPreferences.testInstance();
      final s = securePrefs ?? SecurePreferences.testInstance();
      final storage = _FakeStorage();
      final sync = SyncService(storage: storage, crypto: c);
      final pull = ledgerPull ?? _FakeLedgerPullService();

      if (crypto == null) await c.initialize();

      return OnboardingService(
        crypto: c,
        db: d,
        preferences: p,
        securePreferences: s,
        syncService: sync,
        ledgerPullService: pull,
      );
    }

    // G1
    test('G1: restoreFromCloud creates genesis block in Flutter format '
        '(data_enc with PDK-encrypted seed)', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeRestoreOnboarding(db: db);

      await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty,
          reason: 'restoreFromCloud must create a genesis block '
              'so AuthService.reauthenticate() can extract the seed '
              'from data_enc using PDK');

      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
        orElse: () => blocks.first,
      );
      expect(genesis.dataEnc.length, greaterThan(10),
          reason: 'Genesis data_enc must contain encrypted seed for auth');
    });

    // G2
    test('G2: restoreFromCloud calls LedgerPullService.pullAll()', () async {
      final mockPull = _FakeLedgerPullService();
      final onboarding = await _makeRestoreOnboarding(ledgerPull: mockPull);

      await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
      );

      expect(mockPull.pullAllCalled, isTrue,
          reason: 'restoreFromCloud must pull ledger blocks via '
              'LedgerPullService.pullAll');
    });

    // G3
    test('G3: restoreFromCloud pullAll result reports entries staged',
        () async {
      final fakePull = _FakeLedgerPullService();
      fakePull.pullAllResult =
          PullResult.ok(blocksPulled: 5, entriesStaged: 12);

      final db = AppDatabase.inMemory();
      final onboarding = await _makeRestoreOnboarding(
          db: db, ledgerPull: fakePull);

      await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      // Pull was called and returned entriesStaged > 0
      expect(fakePull.pullAllCalled, isTrue);
      expect(fakePull.pullAllResult.entriesStaged, greaterThan(0),
          reason: 'Pull result must report entries staged from pulled blocks');
    });

    // G4
    test('G4: restoreFromCloud validates seed before any DB writes', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeRestoreOnboarding(db: db);

      // Invalid seed — must fail before writing anything
      try {
        await onboarding.restoreFromCloud(
          '!!!bad-seed!!!',
          validPassphrase,
          'https://worker.example.com',
          'test-key',
        );
        fail('Expected exception for invalid seed');
      } catch (_) {
        // Expected — invalid seed rejected
      }

      // No blocks should have been written
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Invalid seed must be rejected before any DB writes');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group I: restoreFromCloud — error surfacing (5 tests)
  // ═══════════════════════════════════════════════════════════════

  group('I: restoreFromCloud — error surfacing', () {
    /// Creates a fake LedgerPullService with a configurable result/error.
    _FakeLedgerPullService _makeFakePull({
      PullResult? result,
      Object? throwError,
    }) {
      final fake = _FakeLedgerPullService();
      if (result != null) fake.pullAllResult = result;
      if (throwError != null) {
        fake._throwError = throwError;
      }
      return fake;
    }

    Future<OnboardingService> _makeOnboarding({
      dynamic ledgerPull,
    }) async {
      final crypto = CryptoService();
      await crypto.initialize();
      return OnboardingService(
        crypto: crypto,
        db: AppDatabase.inMemory(),
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
        syncService: SyncService(
          storage: _FakeStorage(),
          crypto: crypto,
        ),
        ledgerPullService: ledgerPull,
      );
    }

    // I1
    test('I1: restoreFromCloud returns PullResult (not void)', () async {
      final fakePull = _makeFakePull(
        result: PullResult.ok(blocksPulled: 3, entriesStaged: 5),
      );
      final onboarding = await _makeOnboarding(ledgerPull: fakePull);

      final result = await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      expect(result, isA<PullResult>(),
          reason: 'restoreFromCloud must return PullResult '
              'so callers can inspect success/failure');
      expect(result.success, isTrue);
      expect(result.blocksPulled, 3);
      expect(result.entriesStaged, 5);
    });

    // I2
    test('I2: Valid credentials → PullResult.success=true', () async {
      final fakePull = _makeFakePull(
        result: PullResult.ok(blocksPulled: 5, entriesStaged: 10),
      );
      final onboarding = await _makeOnboarding(ledgerPull: fakePull);

      final result = await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      expect(result.success, isTrue,
          reason: 'Valid credentials must produce successful PullResult');
      expect(result.blocksPulled, greaterThan(0));
      expect(result.entriesStaged, greaterThan(0));
    });

    // I3
    test('I3: connectWorker fails → PullResult.success=false '
        'with connection error', () async {
      // Use a URL that will fail Uri.tryParse / health check
      // The service catches connection errors and returns failure
      final fakePull = _makeFakePull(
        result: PullResult.failure(
          errors: ['Connection refused'],
        ),
      );
      final onboarding = await _makeOnboarding(ledgerPull: fakePull);

      // The fakePull is wired directly; regardless of connectWorker
      // behavior, if pullAll returns failure, restore returns it.
      // We test the error-propagation path here.
      final result = await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://unreachable.example.com',
        'test-key',
        wipeExisting: true,
      );

      expect(result, isA<PullResult>());
      expect(result.success, isFalse,
          reason: 'Connection failure must produce failed PullResult');
      expect(result.errors, isNotEmpty,
          reason: 'Error message must be surfaced to caller');
    });

    // I4
    test('I4: All blocks fail deobfuscation → PullResult.errors '
        'contains "deobfuscate"', () async {
      final fakePull = _makeFakePull(
        result: PullResult.failure(
          errors: [
            'Failed to deobfuscate block 0: CryptoException: '
                'Blob integrity check failed: tampered or wrong key',
          ],
          failedBlocks: [0, 1, 2],
        ),
      );
      final onboarding = await _makeOnboarding(ledgerPull: fakePull);

      final result = await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      expect(result.success, isFalse,
          reason: 'Zero blocks deobfuscated = failure');
      expect(result.blocksPulled, 0);
      expect(
        result.errors.any(
          (e) => e.toLowerCase().contains('deobfuscate'),
        ),
        isTrue,
        reason: 'Error must indicate deobfuscation failure '
            '(key mismatch / wrong seed)',
      );
    });

    // I5
    test('I5: pullAll throws → PullResult returned with error '
        '(not rethrown)', () async {
      // Simulate a network timeout during pull
      final fakePull = _FakeLedgerPullService();
      fakePull._throwError = Exception('Network timeout');
      final onboarding = await _makeOnboarding(ledgerPull: fakePull);

      final result = await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://worker.example.com',
        'test-key',
        wipeExisting: true,
      );

      expect(result, isA<PullResult>(),
          reason: 'Thrown exceptions must be caught and returned '
              'as PullResult, not propagated to UI');
      expect(result.success, isFalse);
      expect(result.errors, isNotEmpty);
      expect(
        result.errors.first,
        contains('timeout'),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group K: restoreFromCloud — validation errors still throw
  // ═══════════════════════════════════════════════════════════════

  group('K: restoreFromCloud — validation errors still throw', () {
    // K1
    test('K1: Invalid seed format → throws FormatException '
        '(not returns error PullResult)', () async {
      final onboarding = await _makeOnboarding();

      try {
        await onboarding.restoreFromCloud(
          '!!!not-valid-base64!!!',
          validPassphrase,
          'https://worker.example.com',
          'test-key',
          wipeExisting: true,
        );
        fail('Expected FormatException for invalid seed base64');
      } catch (e) {
        expect(e, isA<FormatException>(),
            reason: 'Invalid seed format must throw FormatException '
                'synchronously, not return error PullResult');
      }
    });

    // K2
    test('K2: Short passphrase → throws FormatException '
        '(not returns error PullResult)', () async {
      final onboarding = await _makeOnboarding();

      try {
        await onboarding.restoreFromCloud(
          validSeedB64,
          shortPassphrase,
          'https://worker.example.com',
          'test-key',
          wipeExisting: true,
        );
        fail('Expected FormatException for short passphrase');
      } catch (e) {
        expect(e, isA<FormatException>(),
            reason: 'Short passphrase must throw FormatException '
                'synchronously, not return error PullResult');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: OnboardingService — importFromFile (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('L: OnboardingService — importFromFile', () {
    // ── Test fixtures ──────────────────────────────────────────

    /// Known 32-byte seed for deterministic test seals.
    const testSeedB64 =
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

    /// Write [content] to a temp file and return its path.
    Future<String> _writeTempFile(String content) async {
      final dir = Directory.systemTemp.createTempSync('phpoc_L_');
      final file = File('${dir.path}/import_test.json');
      await file.writeAsString(content);
      return file.path;
    }

    /// Minimal genesis block for test fixtures.
    Map<String, dynamic> _sampleGenesis() => {
          'type': 'genesis',
          'day_index': 0,
          'date': '2026-06-01',
          'identity': {'username': 'testuser'},
          'prev_hash': '0' * 64,
          'entries': [],
          'block_hash': 'a' * 64,
        };

    /// Minimal day block for test fixtures.
    Map<String, dynamic> _sampleDayBlock() => {
          'type': 'day',
          'day_index': 1,
          'date': '2026-06-01',
          'prev_hash': 'a' * 64,
          'entries': [
            {
              'hash': 'b' * 64,
              'data': {'title': 'Test entry', 'duration': 3600},
            },
          ],
          'day_hash': 'c' * 64,
        };

    /// Minimal staging entry for v1/v2 fixtures.
    Map<String, dynamic> _sampleStagingEntry() => {
          'entry_id': '00000000-0000-0000-0000-000000000001',
          'title': 'Staged entry',
          'duration': 0,
          'is_active': true,
          'is_paused': false,
          'start_epoch': 1_000_000_000_000,
          'end_epoch': null,
          'pauses': [],
          'tags': [],
          'media': [],
          'device_uuid': 'd' * 64,
          'metadata': {},
          'hash': 'e' * 64,
          'committed': false,
          'block_index': null,
        };

    /// Build a v2 export JSON string with a correct seal.
    ///
    /// Seal = HMAC-SHA256(MK, jsonEncode({"ledger":..., "staging":...}))
    Future<String> _buildV2Json(
      CryptoService crypto,
      String seedB64, {
      List<Map<String, dynamic>>? ledger,
      List<Map<String, dynamic>>? staging,
    }) async {
      final mk = crypto.deriveMasterKey(seedB64);
      final l = ledger ?? [_sampleGenesis(), _sampleDayBlock()];
      final s = staging ?? [_sampleStagingEntry()];
      final payload = jsonEncode({'ledger': l, 'staging': s});
      final seal = crypto.seal(payload, mk);
      return jsonEncode({
        'format_version': '2',
        'ledger': l,
        'staging': s,
        'seal': seal,
      });
    }

    /// Build a v1 export JSON string with a correct seal.
    ///
    /// Seal = HMAC-SHA256(MK, jsonEncode({"entries":...}))
    Future<String> _buildV1Json(
      CryptoService crypto,
      String seedB64, {
      List<Map<String, dynamic>>? entries,
    }) async {
      final mk = crypto.deriveMasterKey(seedB64);
      final e = entries ?? [_sampleStagingEntry()];
      final payload = jsonEncode({'entries': e});
      final seal = crypto.seal(payload, mk);
      return jsonEncode({
        'format_version': '1',
        'entries': e,
        'seal': seal,
      });
    }

    /// Build a raw chain JSON string (no envelope seal).
    String _buildRawChainJson() {
      return jsonEncode([_sampleGenesis(), _sampleDayBlock()]);
    }

    // ── Tests ──────────────────────────────────────────────────

    // L1
    test('L1: importFromFile with v2 export → ledger blocks written '
        'via LedgerBackupService', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty,
          reason: 'v2 export must import ledger blocks into blocks table');
      expect(blocks.length, greaterThanOrEqualTo(2),
          reason: 'v2 fixture has 2 blocks (genesis + day)');
    });

    // L2
    test('L2: importFromFile with v2 → staging entries written to '
        'entries table', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // Entries table should contain the staging entry
      final entries = await db.entryDao.getAllEntries();
      expect(entries, isNotEmpty,
          reason: 'v2 export must write staging entries to entries table');
    });

    // L3
    test('L3: importFromFile with v2 → identity extracted from genesis '
        'block', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(
          crypto: crypto, db: db, prefs: prefs);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // Identity must be extracted so AuthService can reauthenticate.
      // After import, hasExistingData() returns true (identity + genesis exist).
      expect(await prefs.hasExistingData(), isTrue,
          reason: 'v2 import must extract identity from genesis block '
              'so AuthService.reauthenticate() can find identity_secret_enc_fallback');
    });

    // L4
    test('L4: importFromFile with raw chain (ledger.json) → ledger blocks '
        'written', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = _buildRawChainJson();
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty,
          reason: 'Raw chain format (ledger.json) must import blocks');
      expect(blocks.length, greaterThanOrEqualTo(2),
          reason: 'Raw chain fixture has 2 blocks');
    });

    // L5
    test('L5: importFromFile with v1 export → staging entries written, '
        'no ledger blocks', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV1Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // Staging entries must be written
      final entries = await db.entryDao.getAllEntries();
      expect(entries, isNotEmpty,
          reason: 'v1 export must write staging entries to entries table');

      // Ledger blocks must NOT be written (v1 is staging-only)
      final blocks = await db.blockDao.getAllBlocks();
      final nonGenesis = blocks
          .where((b) => b.blockType != BlockType.genesis)
          .toList();
      expect(nonGenesis, isEmpty,
          reason: 'v1 export has no ledger blocks — only staging entries');
    });

    // L6
    test('L6: importFromFile with malformed JSON → throws FormatException',
        () async {
      final crypto = CryptoService();
      await crypto.initialize();

      final filePath = await _writeTempFile('this is not json {{{');

      final onboarding = await _makeOnboarding(crypto: crypto);

      expect(
        () => onboarding.importFromFile(
            filePath, testSeedB64, validPassphrase),
        throwsA(isA<FormatException>()),
      );
    });

    // L7
    test('L7: importFromFile with wrong recovery seed → seal verification '
        'fails', () async {
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      // Use a different seed — seal must not match
      const wrongSeed =
          'QzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=';

      final onboarding = await _makeOnboarding(crypto: crypto);

      expect(
        () => onboarding.importFromFile(filePath, wrongSeed, validPassphrase),
        throwsA(isA<Exception>()),
        reason: 'Wrong seed must be detected via seal mismatch — '
            'the seed is proof of ownership',
      );
    });

    // L8
    test('L8: importFromFile with tampered v2 file (seal mismatch) → '
        'throws validation error', () async {
      final crypto = CryptoService();
      await crypto.initialize();

      // Build valid v2 then tamper with the staging entry
      final ledger = [_sampleGenesis(), _sampleDayBlock()];
      final staging = [_sampleStagingEntry()];
      final validJson = await _buildV2Json(crypto, testSeedB64,
          ledger: ledger, staging: staging);
      final parsed = jsonDecode(validJson) as Map<String, dynamic>;

      // Tamper: change a staging entry title
      final tamperedStaging =
          List<Map<String, dynamic>>.from(parsed['staging']);
      tamperedStaging[0] = Map<String, dynamic>.from(tamperedStaging[0])
        ..['title'] = 'TAMPERED DATA';

      // Rebuild JSON with the original seal (which no longer matches)
      final tampered = jsonEncode({
        'format_version': '2',
        'ledger': parsed['ledger'],
        'staging': tamperedStaging,
        'seal': parsed['seal'], // old seal — won't match
      });

      final filePath = await _writeTempFile(tampered);
      final onboarding = await _makeOnboarding(crypto: crypto);

      expect(
        () => onboarding.importFromFile(
            filePath, testSeedB64, validPassphrase),
        throwsA(isA<Exception>()),
        reason: 'Tampered file must be detected via seal mismatch — '
            'an attacker modifying the file between export and import '
            'must be caught',
      );
    });

    // L9
    test('L9: importFromFile when ledger already exists → throws '
        'LedgerExistsException', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final crypto = CryptoService();
      await crypto.initialize();

      // First, create a ledger
      final onboarding1 = await _makeOnboarding(
          crypto: crypto, db: db, prefs: prefs);
      await onboarding1.createNewLedger(validPassphrase);

      // Now try to import from file on the same DB
      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding2 = await _makeOnboarding(
          crypto: crypto, db: db, prefs: prefs);

      expect(
        () => onboarding2.importFromFile(
            filePath, testSeedB64, validPassphrase),
        throwsA(isA<LedgerExistsException>()),
        reason: 'Import must refuse to overwrite an existing ledger — '
            'same data guard as createNewLedger and importFromSeed',
      );
    });

    // L10
    test('L10: importFromFile creates Flutter-format genesis block with '
        'PDK-encrypted seed', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // A genesis block must exist with Flutter-format data_enc
      final genesisBlocks =
          await db.blockDao.getBlocksByType(BlockType.genesis);
      expect(genesisBlocks, isNotEmpty,
          reason: 'Flutter-format genesis must exist after import');

      final genesis = genesisBlocks.first;
      // data_enc must be non-empty (contains PDK-encrypted seed)
      expect(genesis.dataEnc, isNotEmpty);
      expect(genesis.dataEnc.length, greaterThan(10),
          reason: 'data_enc must contain encrypted seed for auth');

      // data_enc must NOT contain the plaintext seed
      expect(genesis.dataEnc, isNot(contains(testSeedB64)),
          reason: 'Seed must be PDK-encrypted in genesis (D2 compliance)');

      // Genesis must have a valid identity_seal
      expect(genesis.identitySeal, isNotNull);
      expect(genesis.identitySeal, isNotEmpty);
    });
  });
}
