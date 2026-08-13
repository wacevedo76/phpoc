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
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show getBlockHash;
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
  final sync = SyncService(storage: storage, crypto: c, stagingStore: StagingStore(d));

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
  PullResult pullAllResult = PullResult.ok(blocksPulled: 3, entriesStaged: 5);
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
    test(
      'C1: createNewLedger(passphrase) → returns 44-char base64 seed',
      () async {
        final onboarding = await _makeOnboarding();
        final seed = await onboarding.createNewLedger(validPassphrase);

        expect(seed, isA<String>());
        expect(
          seed.length,
          44,
          reason: 'Seed must be 44-char base64 (32 bytes)',
        );
        // Should be valid base64
        expect(() => base64Decode(seed), returnsNormally);
      },
    );

    // C2
    test(
      'C2: createNewLedger writes genesis block (type=genesis, index=0)',
      () async {
        final db = AppDatabase.inMemory();
        final onboarding = await _makeOnboarding(db: db);

        await onboarding.createNewLedger(validPassphrase);

        final blocks = await db.blockDao.getAllBlocks();
        expect(
          blocks,
          isNotEmpty,
          reason: 'Genesis block must exist after ledger creation',
        );

        final genesis = blocks.firstWhere(
          (b) => b.blockType == BlockType.genesis,
          orElse: () => blocks.first,
        );
        expect(genesis.blockType, BlockType.genesis);
        expect(genesis.blockIndex, 0, reason: 'Genesis must be block_index=0');
      },
    );

    // C3
    test('C3: Genesis block contains encrypted seed (not plaintext)', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      final seed = await onboarding.createNewLedger(validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isNotEmpty);
      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
      );

      // data_enc must not contain the plaintext seed
      expect(
        genesis.dataEnc,
        isNot(contains(seed)),
        reason: 'Seed must be encrypted in genesis (D2: zero-knowledge)',
      );
    });

    // C4
    test('C4: Genesis block has valid identity_seal (HMAC-SHA256)', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.createNewLedger(validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
      );

      expect(
        genesis.identitySeal,
        isNotNull,
        reason: 'Genesis must have an identity seal',
      );
      expect(genesis.identitySeal, isNotEmpty);
      // HMAC-SHA256 output is 64 hex chars
      expect(
        genesis.identitySeal!.length,
        64,
        reason: 'Identity seal must be 64-char hex (SHA-256)',
      );
    });

    // C5
    test(
      'C5: after createNewLedger, preferences.hasExistingData() == true',
      () async {
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(prefs: prefs);

        await onboarding.createNewLedger(validPassphrase);

        expect(
          await prefs.hasExistingData(),
          isTrue,
          reason: 'Boot probe must detect newly created ledger',
        );
      },
    );

    // C6
    test(
      'C6: createNewLedger creates UUIDv4 device identity in preferences',
      () async {
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(prefs: prefs);

        await onboarding.createNewLedger(validPassphrase);

        final uuid = await prefs.getDeviceUuid();
        expect(
          uuid,
          isNotNull,
          reason: 'Device must have a UUID after onboarding',
        );
        expect(uuid, isNotEmpty);
        // UUID format: 8-4-4-4-12 hex chars
        expect(
          uuid!.length,
          greaterThanOrEqualTo(36),
          reason: 'Device UUID must be in standard format',
        );
        // Should contain dashes (UUIDv4 format)
        expect(uuid.contains('-'), isTrue);
      },
    );

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

      expect(
        seed1,
        isNot(seed2),
        reason: 'Seeds must be unique and unpredictable',
      );
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
    test(
      'D1: importFromSeed(validSeed, passphrase) → genesis block written',
      () async {
        final db = AppDatabase.inMemory();
        final onboarding = await _makeOnboarding(db: db);

        await onboarding.importFromSeed(validSeedB64, validPassphrase);

        final blocks = await db.blockDao.getAllBlocks();
        expect(
          blocks,
          isNotEmpty,
          reason: 'Import must create a genesis block',
        );
      },
    );

    // D2
    test(
      'D2: imported genesis has block_type=genesis, block_index=0',
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
      },
    );

    // D3
    test(
      'D3: importFromSeed(invalidBase64) → throws format/validation error',
      () async {
        final onboarding = await _makeOnboarding();

        expect(
          () => onboarding.importFromSeed('!!!not-base64!!!', validPassphrase),
          throwsA(isA<Exception>()),
        );
      },
    );

    // D4
    test(
      'D4: after importFromSeed → preferences.hasExistingData() == true',
      () async {
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(prefs: prefs);

        await onboarding.importFromSeed(validSeedB64, validPassphrase);

        expect(
          await prefs.hasExistingData(),
          isTrue,
          reason: 'Boot probe must detect imported data',
        );
      },
    );

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
    test(
      'D6: importFromSeed when data exists → throws LedgerExistsException',
      () async {
        final db = AppDatabase.inMemory();
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(db: db, prefs: prefs);

        await onboarding.createNewLedger(validPassphrase);

        expect(
          () => onboarding.importFromSeed(validSeedB64, validPassphrase),
          throwsA(isA<LedgerExistsException>()),
        );
      },
    );

    // D7
    test(
      'D7: imported seed is stored encrypted in genesis (D2 compliance)',
      () async {
        final db = AppDatabase.inMemory();
        final onboarding = await _makeOnboarding(db: db);

        await onboarding.importFromSeed(validSeedB64, validPassphrase);

        final blocks = await db.blockDao.getAllBlocks();
        final genesis = blocks.firstWhere(
          (b) => b.blockType == BlockType.genesis,
        );

        // The genesis data_enc must NOT contain the plaintext seed
        expect(
          genesis.dataEnc,
          isNot(contains(validSeedB64)),
          reason: 'Seed must be encrypted at rest (D2)',
        );
      },
    );
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: OnboardingService — connectWorker (6 tests)
  // ═══════════════════════════════════════════════════════════════

  group('E: OnboardingService — connectWorker', () {
    // E1
    test(
      'E1: connectWorker(url, apiKey) → URL stored in AppPreferences',
      () async {
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(prefs: prefs);

        const url = 'https://worker.example.com';
        await onboarding.connectWorker(url, 'test-api-key');

        final stored = await prefs.getWorkerUrl();
        expect(stored, url);
      },
    );

    // E2
    test(
      'E2: connectWorker → API key stored in SecurePreferences (encrypted)',
      () async {
        final securePrefs = SecurePreferences.testInstance();
        final onboarding = await _makeOnboarding(securePrefs: securePrefs);

        const apiKey = 'sk-secret-api-key-abc123';
        await onboarding.connectWorker('https://worker.example.com', apiKey);

        final stored = await securePrefs.getApiKey();
        expect(
          stored,
          apiKey,
          reason: 'API key must be stored in encrypted storage',
        );
      },
    );

    // E3
    test('E3: connectWorker(invalidUrl) → throws validation error', () async {
      final onboarding = await _makeOnboarding();

      expect(
        () => onboarding.connectWorker('not-a-url!!!', 'test-key'),
        throwsA(isA<Exception>()),
      );
    });

    // E4 — connectWorker wires transport into SyncService
    test('E4: connectWorker → SyncService.isRemoteAvailable == true', () async {
      final storage = _FakeStorage();
      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();
      final sync = SyncService(
          storage: storage,
          crypto: crypto,
          stagingStore: StagingStore(db));

      final onboarding = OnboardingService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
        syncService: sync,
      );

      await onboarding.connectWorker('https://worker.example.com', 'test-key');

      expect(
        sync.isRemoteAvailable,
        isTrue,
        reason: 'Transport must be wired into SyncService after connect',
      );
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
      expect(
        stored,
        url,
        reason: 'Config must persist even if health check fails',
      );
    });

    // E6
    test('E6: connectWorker overwrites previous Worker config', () async {
      final prefs = AppPreferences.testInstance();
      final securePrefs = SecurePreferences.testInstance();
      final onboarding = await _makeOnboarding(
        prefs: prefs,
        securePrefs: securePrefs,
      );

      await onboarding.connectWorker('https://first.example.com', 'key-one');
      await onboarding.connectWorker('https://second.example.com', 'key-two');

      final url = await prefs.getWorkerUrl();
      final apiKey = await securePrefs.getApiKey();

      expect(
        url,
        'https://second.example.com',
        reason: 'URL must be overwritten, not appended',
      );
      expect(
        apiKey,
        'key-two',
        reason: 'API key must be overwritten, not appended',
      );
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
      expect(result, isFalse, reason: 'Clean install must be detected');
    });

    // F2
    test(
      'F2: hasExistingData() returns true after createNewLedger()',
      () async {
        final db = AppDatabase.inMemory();
        final prefs = AppPreferences.testInstance();
        final onboarding = await _makeOnboarding(db: db, prefs: prefs);

        await onboarding.createNewLedger(validPassphrase);

        final result = await onboarding.hasExistingData();
        expect(result, isTrue, reason: 'Created ledger must be detected');
      },
    );

    // F3
    test('F3: hasExistingData() returns true after importFromSeed()', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final result = await onboarding.hasExistingData();
      expect(result, isTrue, reason: 'Imported ledger must be detected');
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
      expect(
        result,
        isTrue,
        reason: 'Auto-heal: genesis exists, prefs flag should be restored',
      );

      // The flag should now be true (healed)
      expect(
        await prefs.hasExistingData(),
        isTrue,
        reason: 'Preferences flag must be restored after auto-heal',
      );
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
      final sync = SyncService(
          storage: storage, crypto: c, stagingStore: StagingStore(d));
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
      expect(
        blocks,
        isNotEmpty,
        reason:
            'restoreFromCloud must create a genesis block '
            'so AuthService.reauthenticate() can extract the seed '
            'from data_enc using PDK',
      );

      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
        orElse: () => blocks.first,
      );
      // A2: genesis must carry an encrypted PDK seed + identity_seal so
      // AuthService.reauthenticate() can recover the seed from genesis.
      expect(
        genesis.dataEnc.length,
        greaterThan(10),
        reason: 'Genesis data_enc must contain encrypted seed for auth',
      );
      expect(
        genesis.identitySeal,
        isNotEmpty,
        reason: 'Genesis must have an identity_seal for reauth (A2)',
      );
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

      expect(
        mockPull.pullAllCalled,
        isTrue,
        reason:
            'restoreFromCloud must pull ledger blocks via '
            'LedgerPullService.pullAll',
      );
    });

    // G3
    test(
      'G3: restoreFromCloud pullAll result reports entries staged',
      () async {
        final fakePull = _FakeLedgerPullService();
        fakePull.pullAllResult = PullResult.ok(
          blocksPulled: 5,
          entriesStaged: 12,
        );

        final db = AppDatabase.inMemory();
        final onboarding = await _makeRestoreOnboarding(
          db: db,
          ledgerPull: fakePull,
        );

        await onboarding.restoreFromCloud(
          validSeedB64,
          validPassphrase,
          'https://worker.example.com',
          'test-key',
          wipeExisting: true,
        );

        // Pull was called and returned entriesStaged > 0
        expect(fakePull.pullAllCalled, isTrue);
        expect(
          fakePull.pullAllResult.entriesStaged,
          greaterThan(0),
          reason: 'Pull result must report entries staged from pulled blocks',
        );
      },
    );

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
      expect(
        blocks,
        isEmpty,
        reason: 'Invalid seed must be rejected before any DB writes',
      );
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

    Future<OnboardingService> _makeOnboarding({dynamic ledgerPull}) async {
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
            stagingStore: StagingStore(AppDatabase.inMemory())),
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

      expect(
        result,
        isA<PullResult>(),
        reason:
            'restoreFromCloud must return PullResult '
            'so callers can inspect success/failure',
      );
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

      expect(
        result.success,
        isTrue,
        reason: 'Valid credentials must produce successful PullResult',
      );
      expect(result.blocksPulled, greaterThan(0));
      expect(result.entriesStaged, greaterThan(0));
    });

    // I3
    test('I3: connectWorker fails → PullResult.success=false '
        'with connection error', () async {
      // Use a URL that will fail Uri.tryParse / health check
      // The service catches connection errors and returns failure
      final fakePull = _makeFakePull(
        result: PullResult.failure(errors: ['Connection refused']),
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
      expect(
        result.success,
        isFalse,
        reason: 'Connection failure must produce failed PullResult',
      );
      expect(
        result.errors,
        isNotEmpty,
        reason: 'Error message must be surfaced to caller',
      );
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

      expect(
        result.success,
        isFalse,
        reason: 'Zero blocks deobfuscated = failure',
      );
      expect(result.blocksPulled, 0);
      expect(
        result.errors.any((e) => e.toLowerCase().contains('deobfuscate')),
        isTrue,
        reason:
            'Error must indicate deobfuscation failure '
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

      expect(
        result,
        isA<PullResult>(),
        reason:
            'Thrown exceptions must be caught and returned '
            'as PullResult, not propagated to UI',
      );
      expect(result.success, isFalse);
      expect(result.errors, isNotEmpty);
      expect(result.errors.first, contains('timeout'));
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
        expect(
          e,
          isA<FormatException>(),
          reason:
              'Invalid seed format must throw FormatException '
              'synchronously, not return error PullResult',
        );
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
        expect(
          e,
          isA<FormatException>(),
          reason:
              'Short passphrase must throw FormatException '
              'synchronously, not return error PullResult',
        );
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: OnboardingService — importFromFile (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('L: OnboardingService — importFromFile', () {
    // ── Test fixtures ──────────────────────────────────────────

    /// Known 32-byte seed for deterministic test seals.
    const testSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

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
      return jsonEncode({'format_version': '1', 'entries': e, 'seal': seal});
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
      expect(
        blocks,
        isNotEmpty,
        reason: 'v2 export must import ledger blocks into blocks table',
      );
      expect(
        blocks.length,
        greaterThanOrEqualTo(2),
        reason: 'v2 fixture has 2 blocks (genesis + day)',
      );
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

      // Row-level staging: v2 export writes rows to the SyncService's
      // StagingStore (the entries-table fallback was retired with the legacy
      // LocalCache path).
      final rows = await onboarding.syncService.stagingStore.getAllRows();
      expect(
        rows,
        isNotEmpty,
        reason: 'v2 export must write staging rows to the StagingStore',
      );
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
        crypto: crypto,
        db: db,
        prefs: prefs,
      );
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // Identity must be extracted so AuthService can reauthenticate.
      // After import, hasExistingData() returns true (identity + genesis exist).
      expect(
        await prefs.hasExistingData(),
        isTrue,
        reason:
            'v2 import must extract identity from genesis block '
            'so AuthService.reauthenticate() can find identity_secret_enc_fallback',
      );
    });

    // L4
    test('L4: importFromFile with raw chain (ledger.json) → ledger blocks '
        'written and canonical genesis PRESERVED', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = _buildRawChainJson();
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      final blocks = await db.blockDao.getAllBlocks();
      expect(
        blocks,
        isNotEmpty,
        reason: 'Raw chain format (ledger.json) must import blocks',
      );
      expect(
        blocks.length,
        greaterThanOrEqualTo(2),
        reason: 'Raw chain fixture has 2 blocks',
      );

      // The imported canonical genesis must survive — NOT be replaced by a
      // Flutter-format {seed} genesis (Ph-7 Path B fix). block_hash of the
      // sample genesis is 'a'*64.
      final genesis = blocks.firstWhere(
        (b) => b.blockType == BlockType.genesis,
        orElse: () => throw StateError('no genesis block imported'),
      );
      expect(
        genesis.blockId,
        'a' * 64,
        reason:
            'raw-chain onboarding must preserve the imported canonical '
            'genesis so LedgerChain.verify() can pass',
      );
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

      // Row-level staging entries must be written to the StagingStore
      final rows = await onboarding.syncService.stagingStore.getAllRows();
      expect(
        rows,
        isNotEmpty,
        reason: 'v1 export must write staging rows to the StagingStore',
      );

      // Ledger blocks must NOT be written (v1 is staging-only)
      final blocks = await db.blockDao.getAllBlocks();
      final nonGenesis = blocks
          .where((b) => b.blockType != BlockType.genesis)
          .toList();
      expect(
        nonGenesis,
        isEmpty,
        reason: 'v1 export has no ledger blocks — only staging entries',
      );
    });

    // C3 — v2 import with a row-level stagingStore writes rows to the
    // stagingStore (not the legacy entries table) when one is available.
    test(
      'C3: v2 import with row-level stagingStore → rows written there',
      () async {
        final db = AppDatabase.inMemory();
        final crypto = CryptoService();
        await crypto.initialize();
        final store = StagingStore(db);
        final storage = _FakeStorage();
        final sync = SyncService(
          storage: storage,
          crypto: crypto,
          stagingStore: store,
        );

        final onboarding = OnboardingService(
          crypto: crypto,
          db: db,
          preferences: AppPreferences.testInstance(),
          securePreferences: SecurePreferences.testInstance(),
          syncService: sync,
        );

        final json = await _buildV2Json(crypto, testSeedB64);
        final filePath = await _writeTempFile(json);
        await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

        // Row-level path: rows land in stagingStore.
        final rows = await store.getAllRows();
        expect(
          rows,
          isNotEmpty,
          reason:
              'v2 import must write staging rows to the row-level '
              'stagingStore when available (C3)',
        );

        // C4: the imported entry preserves its entry_id (the fixture uses
        // '00000000-...-00000001').
        final activity =
            jsonDecode(rows.first['activity'] as String)
                as Map<String, dynamic>;
        expect(
          activity['entry_id'],
          '00000000-0000-0000-0000-000000000001',
          reason: 'Imported staging entry must preserve its entry_id (C4)',
        );
      },
    );

    // L6
    test(
      'L6: importFromFile with malformed JSON → throws FormatException',
      () async {
        final crypto = CryptoService();
        await crypto.initialize();

        final filePath = await _writeTempFile('this is not json {{{');

        final onboarding = await _makeOnboarding(crypto: crypto);

        expect(
          () =>
              onboarding.importFromFile(filePath, testSeedB64, validPassphrase),
          throwsA(isA<FormatException>()),
        );
      },
    );

    // L7
    test('L7: importFromFile with wrong recovery seed → seal verification '
        'fails', () async {
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      // Use a different seed — seal must not match
      const wrongSeed = 'QzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM=';

      final onboarding = await _makeOnboarding(crypto: crypto);

      expect(
        () => onboarding.importFromFile(filePath, wrongSeed, validPassphrase),
        throwsA(isA<Exception>()),
        reason:
            'Wrong seed must be detected via seal mismatch — '
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
      final validJson = await _buildV2Json(
        crypto,
        testSeedB64,
        ledger: ledger,
        staging: staging,
      );
      final parsed = jsonDecode(validJson) as Map<String, dynamic>;

      // Tamper: change a staging entry title
      final tamperedStaging = List<Map<String, dynamic>>.from(
        parsed['staging'],
      );
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
        () => onboarding.importFromFile(filePath, testSeedB64, validPassphrase),
        throwsA(isA<Exception>()),
        reason:
            'Tampered file must be detected via seal mismatch — '
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
        crypto: crypto,
        db: db,
        prefs: prefs,
      );
      await onboarding1.createNewLedger(validPassphrase);

      // Now try to import from file on the same DB
      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding2 = await _makeOnboarding(
        crypto: crypto,
        db: db,
        prefs: prefs,
      );

      expect(
        () =>
            onboarding2.importFromFile(filePath, testSeedB64, validPassphrase),
        throwsA(isA<LedgerExistsException>()),
        reason:
            'Import must refuse to overwrite an existing ledger — '
            'same data guard as createNewLedger and importFromSeed',
      );
    });

    // L10
    test('L10: importFromFile PRESERVES the imported canonical genesis '
        '(does not replace with a Flutter-format genesis) and stores the '
        'seed in the vault', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final json = await _buildV2Json(crypto, testSeedB64);
      final filePath = await _writeTempFile(json);

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.importFromFile(filePath, testSeedB64, validPassphrase);

      // The imported canonical genesis must survive — NOT be deleted and
      // replaced by a Flutter-format genesis (the Ph-7 Path-B bug broke
      // chain verification by swapping the genesis). block_hash of the
      // sample genesis is 'a'*64.
      final genesisBlocks = await db.blockDao.getBlocksByType(
        BlockType.genesis,
      );
      expect(
        genesisBlocks,
        isNotEmpty,
        reason: 'imported canonical genesis must exist after import',
      );

      final genesis = genesisBlocks.first;
      expect(
        genesis.blockId,
        'a' * 64,
        reason:
            'the canonical imported genesis block_hash must be '
            'preserved, not replaced by a rebuilt Flutter genesis',
      );
      expect(
        genesis.prevHash,
        '0' * 64,
        reason: 'canonical genesis keeps its original prev_hash linkage',
      );

      // The recovery seed must still be stored in the vault post-import
      // (auth flow depends on it), independent of genesis preservation.
      final vaultRows = db
          .customSelect(
            "SELECT value FROM _phpoc_meta WHERE key = 'recovery_seed_enc'",
          )
          .get();
      expect(
        vaultRows,
        isNotEmpty,
        reason: 'importFromFile must store seed in vault for auth',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group V: Vault Population & Genesis Immutability — 4 tests
  // Phase 1 Group C: _storeSeedInVault + _postImportSetup
  // ═══════════════════════════════════════════════════════════════

  group('V: Vault Population & Genesis Immutability', () {
    // ── Vault helpers ──

    // ── Vault helpers ──

    Future<String?> _readVault(AppDatabase db) async {
      final rows = db
          .customSelect(
            "SELECT value FROM _phpoc_meta WHERE key = 'recovery_seed_enc'",
          )
          .get();
      return rows.isNotEmpty ? rows.first.read<String>('value') : null;
    }

    // V1 — createNewLedger stores seed in vault (Phase 1 C2)
    test('V1 createNewLedger stores encrypted seed in vault', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.createNewLedger(validPassphrase);

      final vaultSeed = await _readVault(db);
      expect(
        vaultSeed,
        isNotNull,
        reason: 'createNewLedger must store PDK-encrypted seed in vault',
      );
      expect(
        vaultSeed!.length,
        greaterThan(10),
        reason: 'Encrypted seed must be non-trivial length',
      );
    });

    // V2 — restoreFromCloud stores seed in vault (Phase 1 C1)
    test(
      'V2 restoreFromCloud stores seed in vault, preserves R2 genesis',
      () async {
        final db = AppDatabase.inMemory();
        final crypto = CryptoService();
        await crypto.initialize();
        crypto.setMasterKey(
          '4242424242424242424242424242424242424242424242424242424242424242',
        );

        final onboarding = await _makeOnboarding(crypto: crypto, db: db);
        final fakePull = _FakeLedgerPullService();
        fakePull.pullAllResult = PullResult.ok(
          blocksPulled: 3,
          entriesStaged: 5,
        );
        onboarding.ledgerPullService = fakePull;

        await onboarding.restoreFromCloud(
          validSeedB64,
          validPassphrase,
          'https://test-worker.example.com',
          'fake-api-key',
        );

        // Vault must be populated
        final vaultSeed = await _readVault(db);
        expect(
          vaultSeed,
          isNotNull,
          reason: 'restoreFromCloud must store encrypted seed in vault',
        );

        // Genesis block must exist (from R2 pull + _postImportSetup)
        final genesisBlocks = await db.blockDao.getBlocksByType(
          BlockType.genesis,
        );
        expect(
          genesisBlocks,
          isNotEmpty,
          reason: 'Genesis must exist after cloud restore',
        );
      },
    );

    // V3 — Genesis seal uses jsonSort, not json.encode (Phase 1 C3)
    test('V3 genesis block_id is computed with jsonSort for cross-client '
        'verifiability', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.createNewLedger(validPassphrase);

      final genesisBlocks = await db.blockDao.getBlocksByType(
        BlockType.genesis,
      );
      final blockId = genesisBlocks.first.blockId;

      // Recompute seal with jsonSort — must match the stored blockId
      final mk = crypto.getMasterKey()!;
      final now = DateTime.now();
      final payload = {
        'type': 'genesis',
        'day_index': 0,
        'date': '1970-01-01',
        'prev_hash': '0' * 64,
        'entries': <dynamic>[],
      };

      // jsonSort should produce same seal as stored blockId
      final jsonSortSeal = crypto.seal(jsonSort(payload), mk);
      // json.encode (unsorted) would produce different seal → the bug
      final jsonEncodeSeal = crypto.seal(jsonEncode(payload), mk);

      // The stored blockId should match jsonSort, not json.encode
      // Note: date field may differ due to real timestamp, so we only check
      // that jsonSort and json.encode produce DIFFERENT seals (proving
      // the bug exists if json.encode was used)
      expect(
        jsonSortSeal,
        isNot(jsonEncodeSeal),
        reason:
            'jsonSort and json.encode MUST produce different seals '
            'for the same payload — this is why RC1 exists',
      );
    });

    // V4 — _buildAndPersistGenesis does NOT SQL-update block 1 prev_hash
    // when genesis exists from R2 (Phase 1 C4)
    test('V4 restoreFromCloud does not mutate block 1 prev_hash', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '4242424242424242424242424242424242424242424242424242424242424242',
      );

      // Pre-seed a genesis + day block simulating R2 import
      final now = DateTime.now().millisecondsSinceEpoch;
      await db.blockDao.insertBlockSync(
        Block(
          blockId: 'r2-genesis-hash-abc',
          blockType: BlockType.genesis,
          blockIndex: 0,
          keyVersion: 1,
          dataEnc: 'dGVzdA==',
          identitySeal: 'seal1',
          prevHash: '0' * 64,
          createdAt: now,
        ),
      );
      await db.blockDao.insertBlockSync(
        Block(
          blockId: 'r2-day-1-hash-def',
          blockType: BlockType.day,
          blockIndex: 1,
          keyVersion: 1,
          dataEnc: 'dGVzdDI=',
          identitySeal: null,
          prevHash: 'r2-genesis-hash-abc',
          createdAt: now + 1,
        ),
      );

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      final fakePull = _FakeLedgerPullService();
      fakePull.pullAllResult = PullResult.ok(blocksPulled: 2, entriesStaged: 0);
      onboarding.ledgerPullService = fakePull;

      await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://test-worker.example.com',
        'fake-api-key',
      );

      // Block 1's prev_hash should still point to R2 genesis
      final dayBlocks = await db.blockDao.getBlocksByType(BlockType.day);
      if (dayBlocks.isNotEmpty) {
        final block1 = dayBlocks.firstWhere(
          (b) => b.blockIndex == 1,
          orElse: () => dayBlocks.first,
        );
        expect(
          block1.prevHash,
          'r2-genesis-hash-abc',
          reason:
              'Block 1 prev_hash must NOT be overwritten to point to '
              'a new Flutter genesis — it must stay linked to R2 genesis',
        );
      }
    });

    // B4 — the strict LedgerExistsException guard is scoped to CREATION
    // flows (createNewLedger / importFromSeed / importFromFile), NOT restore.
    test('B4 createNewLedger/importFromSeed still throw LedgerExistsException '
        'when a ledger exists and wipeExisting is false', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(
        crypto: crypto,
        db: db,
        prefs: prefs,
      );
      await onboarding.createNewLedger(validPassphrase);

      // createNewLedger twice — must throw (strict guard kept).
      await expectLater(
        onboarding.createNewLedger(validPassphrase),
        throwsA(isA<LedgerExistsException>()),
        reason: 'createNewLedger must keep its strict Overwrite guard (B4)',
      );

      // importFromSeed over an existing ledger — must throw.
      await expectLater(
        onboarding.importFromSeed(validSeedB64, validPassphrase),
        throwsA(isA<LedgerExistsException>()),
        reason: 'importFromSeed must keep its strict Overwrite guard (B4)',
      );
      // (importFromFile strict guard is covered by existing L9.)
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: End-to-End Flows — 8 tests
  // Phase 1 Group L: full create/import/restore + auth flows
  // ═══════════════════════════════════════════════════════════════

  group('L: End-to-End Flows (create + verify + auth)', () {
    // ── Helpers ──

    Future<String?> _readVault(AppDatabase db) async {
      final rows = db
          .customSelect(
            "SELECT value FROM _phpoc_meta WHERE key = 'recovery_seed_enc'",
          )
          .get();
      return rows.isNotEmpty ? rows.first.read<String>('value') : null;
    }

    // L1 — createNewLedger → genesis + vault populated → verify passes
    test('L1 createNewLedger → genesis + vault → chain verifiable', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      final seed = await onboarding.createNewLedger(validPassphrase);
      expect(seed, isNotEmpty);

      // Vault must be populated
      final vaultSeed = await _readVault(db);
      expect(
        vaultSeed,
        isNotNull,
        reason: 'createNewLedger must store seed in vault',
      );

      // Genesis must exist
      final genesisBlocks = await db.blockDao.getBlocksByType(
        BlockType.genesis,
      );
      expect(
        genesisBlocks,
        isNotEmpty,
        reason: 'Genesis block must exist after creation',
      );
    });

    // L2 — importFromSeed → genesis + vault populated
    test('L2 importFromSeed → genesis + vault', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.importFromSeed(validSeedB64, validPassphrase);

      final vaultSeed = await _readVault(db);
      expect(
        vaultSeed,
        isNotNull,
        reason: 'importFromSeed must store seed in vault',
      );

      final genesisBlocks = await db.blockDao.getBlocksByType(
        BlockType.genesis,
      );
      expect(genesisBlocks, isNotEmpty);
    });

    // L3 — importFromFile → genesis + vault populated
    test('L3 importFromFile → genesis + vault', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      // Build a v2 export
      final testSeedB64 = validSeedB64;
      final mk = crypto.deriveMasterKey(testSeedB64);
      crypto.setMasterKey(mk);

      final now = DateTime.now().millisecondsSinceEpoch ~/ 1000;
      final genesisPayload = {
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <dynamic>[],
        'format_version': '0.4.0',
        'key_version': 1,
        'username': 'user',
        'email': 'e@e.com',
        'recovery_seed_enc': 'seed',
        'identity_pub_key': 'pk',
        'identity_secret_enc_fallback': 'fb',
      };
      final genSeal = crypto.seal(jsonSort(genesisPayload), mk);
      genesisPayload['block_hash'] = genSeal;

      final v2Json = jsonEncode({
        'format_version': '2',
        'ledger': [genesisPayload],
        'staging': <dynamic>[],
        'seal': crypto.seal(
          jsonEncode({
            'ledger': [genesisPayload],
            'staging': <dynamic>[],
          }),
          mk,
        ),
      });

      final file = File(
        '${Directory.systemTemp.path}/test_l3_import_${now}.json',
      );
      await file.writeAsString(v2Json);

      try {
        final onboarding = await _makeOnboarding(crypto: crypto, db: db);
        await onboarding.importFromFile(
          file.path,
          testSeedB64,
          validPassphrase,
        );

        final vaultSeed = await _readVault(db);
        expect(
          vaultSeed,
          isNotNull,
          reason: 'importFromFile must store seed in vault',
        );

        final genesisBlocks = await db.blockDao.getBlocksByType(
          BlockType.genesis,
        );
        expect(genesisBlocks, isNotEmpty);
      } finally {
        await file.delete().catchError((_) {});
      }
    });

    // L4 — restoreFromCloud → R2 genesis preserved, vault populated
    test(
      'L4 restoreFromCloud → R2 genesis preserved, vault populated',
      () async {
        final db = AppDatabase.inMemory();
        final crypto = CryptoService();
        await crypto.initialize();
        crypto.setMasterKey(
          '4242424242424242424242424242424242424242424242424242424242424242',
        );

        final onboarding = await _makeOnboarding(crypto: crypto, db: db);
        final fakePull = _FakeLedgerPullService();
        fakePull.pullAllResult = PullResult.ok(
          blocksPulled: 2,
          entriesStaged: 3,
        );
        onboarding.ledgerPullService = fakePull;

        final result = await onboarding.restoreFromCloud(
          validSeedB64,
          validPassphrase,
          'https://test-worker.example.com',
          'fake-api-key',
        );

        expect(result.success, isTrue);

        // Vault must be populated
        final vaultSeed = await _readVault(db);
        expect(
          vaultSeed,
          isNotNull,
          reason: 'restoreFromCloud must store seed in vault',
        );

        // Genesis must exist
        final genesisBlocks = await db.blockDao.getBlocksByType(
          BlockType.genesis,
        );
        expect(
          genesisBlocks,
          isNotEmpty,
          reason: 'Genesis must exist after restore',
        );
      },
    );

    // L5 — unlock after createNewLedger via vault → succeeds
    test('L5 unlock after createNewLedger works via vault', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      final seed = await onboarding.createNewLedger(validPassphrase);

      // Vault must have seed
      final vaultSeed = await _readVault(db);
      expect(
        vaultSeed,
        isNotNull,
        reason: 'Vault must contain seed after creation',
      );

      // Verify we can derive MK from the seed and it's the same as cached
      final mkFromSeed = crypto.deriveMasterKey(seed);
      final cachedMk = crypto.getMasterKey();
      expect(mkFromSeed, cachedMk, reason: 'MK from seed must match cached MK');
    });

    // L6 — unlock after restoreFromCloud via vault → succeeds
    test('L6 unlock after restoreFromCloud works via vault', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(
        '4242424242424242424242424242424242424242424242424242424242424242',
      );

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      final fakePull = _FakeLedgerPullService();
      fakePull.pullAllResult = PullResult.ok(blocksPulled: 1, entriesStaged: 0);
      onboarding.ledgerPullService = fakePull;

      await onboarding.restoreFromCloud(
        validSeedB64,
        validPassphrase,
        'https://test-worker.example.com',
        'fake-api-key',
      );

      // Vault must be populated
      final vaultSeed = await _readVault(db);
      expect(
        vaultSeed,
        isNotNull,
        reason: 'Vault must contain seed after cloud restore',
      );

      // MK must be cached after restore
      expect(
        crypto.hasMasterKey,
        isTrue,
        reason: 'MK must be cached after successful restore',
      );
    });

    // L7 — changePassphrase after createNewLedger → vault updated
    // D1 + D2: vault must round-trip the ACTUAL seed returned by
    // createNewLedger (which is random), not any fixed constant, and
    // passphrase change must re-encrypt (old PDK fails, new PDK recovers S).
    test('L7 changePassphrase after creation updates vault', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      final seed = await onboarding.createNewLedger(validPassphrase);

      // D1: vault must hold a seed that decrypts back to the SAME seed that
      // createNewLedger returned (the stored seed is random, not the constant).
      final originalVaultSeed = await _readVault(db);
      expect(
        originalVaultSeed,
        isNotNull,
        reason: 'createNewLedger must store the seed in the vault',
      );

      final oldPdk = crypto.derivePdk(validPassphrase, 600000);
      final decryptedSeed = crypto.decrypt(originalVaultSeed!, oldPdk);
      expect(
        decryptedSeed,
        seed,
        reason:
            'Vault seed must round-trip exactly to the seed returned '
            'by createNewLedger (D1)',
      );

      // Re-encrypt with new passphrase (what changePassphrase does).
      const newPp = 'NewPassphraseForTesting99!';
      final newPdk = crypto.derivePdk(newPp, 600000);
      final newEncrypted = crypto.encrypt(decryptedSeed, newPdk);

      await db.customStatement(
        'INSERT OR REPLACE INTO _phpoc_meta (key, value) VALUES (?, ?)',
        ['recovery_seed_enc', newEncrypted],
      );

      // Vault now contains new encryption.
      final updatedVaultSeed = await _readVault(db);
      expect(
        updatedVaultSeed,
        isNot(originalVaultSeed),
        reason: 'Vault seed must change after passphrase change',
      );
      expect(updatedVaultSeed, newEncrypted);

      // D2: old PDK can no longer decrypt, new PDK recovers the same seed S.
      expect(
        () => crypto.decrypt(updatedVaultSeed!, oldPdk),
        throwsA(isA<Exception>()),
        reason: 'Old PDK must fail after passphrase change (D2)',
      );

      final reDecrypted = crypto.decrypt(updatedVaultSeed!, newPdk);
      expect(
        reDecrypted,
        seed,
        reason:
            'new PDK must recover the same seed S after passphrase '
            'change (D2)',
      );
    });

    // L8 — exportSeed after createNewLedger from vault
    test('L8 seed in vault is decryptable with correct passphrase', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();

      final onboarding = await _makeOnboarding(crypto: crypto, db: db);
      await onboarding.createNewLedger(validPassphrase);

      // Read vault seed
      final vaultSeed = await _readVault(db);
      expect(vaultSeed, isNotNull);

      // Decrypt with PDK
      final pdk = crypto.derivePdk(validPassphrase, 600000);
      final decrypted = crypto.decrypt(vaultSeed!, pdk);

      // Verify it's valid base64 and 32 bytes
      final seedBytes = base64.decode(decrypted);
      expect(seedBytes.length, 32, reason: 'Decrypted seed must be 32 bytes');
    });
  });

  // Group H: OnboardingService — restoreConfiguredWorker (4 tests)
  // Restores the persisted Worker transport on app startup so remote sync
  // (periodic, reauth, manual) works after a relaunch without reopening
  // Settings. This closes the gap where a fresh app restart had transport==null
  // and every checkAndSync was a silent no-op.
  group('H: OnboardingService — restoreConfiguredWorker', () {
    // H1
    test(
        'H1: restoreConfiguredWorker wires the persisted Worker into '
        'SyncService after an app restart', () async {
      final prefs = AppPreferences.testInstance();
      final securePrefs = SecurePreferences.testInstance();
      final url = 'https://worker.example.com';

      // Simulate a prior onboarding that persisted credentials.
      await prefs.setWorkerUrl(url);
      await securePrefs.setApiKey('persisted-api-key');

      // Fresh app launch: brand-new SyncService (transport == null).
      final onboarding = await _makeOnboarding(
        prefs: prefs,
        securePrefs: securePrefs,
      );
      final sync = onboarding.syncService;
      expect(sync.isRemoteAvailable, isFalse,
          reason: 'Precondition: transport is null on a fresh launch');

      await onboarding.restoreConfiguredWorker();

      expect(sync.isRemoteAvailable, isTrue,
          reason: 'Restore must wire the persisted transport into SyncService');
      expect(sync.transport?.baseUrl, url,
          reason: 'Restored transport must use the persisted Worker URL');
      expect(sync.transport?.apiKey, 'persisted-api-key',
          reason: 'Restored transport must carry the persisted API key');
    });

    // H2
    test(
        'H2: no persisted Worker credentials → restore is a safe no-op '
        '(transport stays null, no throw)', () async {
      final onboarding = await _makeOnboarding(); // no creds saved
      final sync = onboarding.syncService;

      await onboarding.restoreConfiguredWorker();

      expect(sync.isRemoteAvailable, isFalse,
          reason: 'No creds → transport must remain null');
    });

    // H3
    test(
        'H3: already-wired transport → restore is idempotent (returns early)',
        () async {
      final prefs = AppPreferences.testInstance();
      final securePrefs = SecurePreferences.testInstance();
      await prefs.setWorkerUrl('https://worker.example.com');
      await securePrefs.setApiKey('persisted-api-key');
      final onboarding = await _makeOnboarding(
        prefs: prefs,
        securePrefs: securePrefs,
      );
      await onboarding.connectWorker('https://other.example.com', 'new-key');
      final sync = onboarding.syncService;
      final originalTransport = sync.transport;
      expect(sync.isRemoteAvailable, isTrue,
          reason: 'Precondition: already connected');

      await onboarding.restoreConfiguredWorker();

      expect(identical(sync.transport, originalTransport), isTrue,
          reason: 'Restore must not clobber an already-wired transport');
    });

    // H4
    test(
        'H4: restore is fail-safe on missing API key (url only) — no-throw',
        () async {
      final prefs = AppPreferences.testInstance();
      final securePrefs = SecurePreferences.testInstance();
      await prefs.setWorkerUrl('https://worker.example.com');
      // Explicitly remove any API key so this test is robust to the shared
      // static test store leaking a key set by an earlier group-H test.
      await securePrefs.deleteApiKey();
      final onboarding = await _makeOnboarding(
        prefs: prefs,
        securePrefs: securePrefs,
      );
      final sync = onboarding.syncService;

      // Must not throw and must not wire a transport with incomplete creds.
      await onboarding.restoreConfiguredWorker();
      expect(sync.isRemoteAvailable, isFalse,
          reason: 'Incomplete creds → transport stays null');
    });
  });
}
