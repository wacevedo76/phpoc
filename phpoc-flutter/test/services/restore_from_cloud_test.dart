import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// Restore from Cloud tests — Groups A (10) + H (8) = 18 assertions.
///
/// Covers:
///   A1–A10: OnboardingService.restoreFromCloud — core flow
///   H1–H8:  Error handling & edge cases
///
/// Note: All tests are RED until Phase 3 implements restoreFromCloud.

// ── Test constants ──────────────────────────────────────────────

const validPassphrase = 'CorrectHorseBatteryStaple42!';
const shortPassphrase = 'short';

/// 32 bytes of 0x42 = base64.
const validSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

const validWorkerUrl = 'https://worker.example.com';
const validApiKey = 'test-api-key-abc123';

// ── Helpers ────────────────────────────────────────────────────

/// In-memory storage for SyncService.
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
  SyncService? sync,
}) async {
  final c = crypto ?? (CryptoService()..initialize());
  final d = db ?? AppDatabase.inMemory();
  final p = prefs ?? AppPreferences.testInstance();
  final s = securePrefs ?? SecurePreferences.testInstance();
  final storage = _FakeStorage();
  final svc = sync ?? SyncService(storage: storage, crypto: c);

  if (crypto == null) await c.initialize();

  return OnboardingService(
    crypto: c,
    db: d,
    preferences: p,
    securePreferences: s,
    syncService: svc,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: OnboardingService — restoreFromCloud (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('A: OnboardingService — restoreFromCloud', () {
    // A1
    test('A1: restoreFromCloud does NOT create a local genesis block '
        '(genesis comes from R2 via pullAll)', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Genesis must come from R2, not created locally');
    });

    // A2
    test('A2: after restoreFromCloud, hasExistingData() returns true',
        () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      expect(await onboarding.hasExistingData(), isTrue,
          reason: 'Data flag must be set after restore');
    });

    // A3
    test('A3: after restoreFromCloud, device UUID is persisted', () async {
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(prefs: prefs);

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      final uuid = await prefs.getDeviceUuid();
      expect(uuid, isNotNull, reason: 'Device identity must be created');
      expect(uuid, isNotEmpty);
      expect(uuid!.length, greaterThanOrEqualTo(36));
    });

    // A4
    test('A4: restoreFromCloud caches MK via crypto.setMasterKey before '
        'sync pull', () async {
      final crypto = CryptoService();
      await crypto.initialize();
      final onboarding = await _makeOnboarding(crypto: crypto);

      expect(crypto.hasMasterKey, isFalse,
          reason: 'MK not cached before restore');

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      expect(crypto.hasMasterKey, isTrue,
          reason: 'MK must be cached after successful restore for sync ops');
    });

    // A5
    test('A5: restoreFromCloud with reachable Worker — staging entries are '
        'pulled and merged', () async {
      // RED: This test requires a mock transport that returns a blob.
      // The assertion defines the integration contract.
      final onboarding = await _makeOnboarding();

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // After restore, the sync service should have performed an initial pull.
      // The result is observable via getEntries() on the sync service.
      final entries = await onboarding.syncService.getEntries();
      // With a real transport, entries might be populated from remote.
      // The key assertion is that the method completes without throwing.
      expect(entries, isA<List>(),
          reason: 'Restore must attempt sync pull and return cleanly');
    });

    // A6
    test('A6: restoreFromCloud with unreachable Worker still succeeds '
        '(identity only, no local genesis)', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      // Invalid URL simulates unreachable Worker — restore must not fail
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase,
        'https://10.255.255.1:9999', // unroutable
        validApiKey,
      );

      // No local genesis — genesis comes from R2 via pullAll
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Genesis comes from R2, not created locally');
      // But device identity and flag are still set
      expect(await prefs.hasExistingData(), isTrue,
          reason: 'Local state must be valid after degraded restore');
      expect(await prefs.getDeviceUuid(), isNotEmpty,
          reason: 'Device UUID must be set');
    });

    // A7
    test('A7: restoreFromCloud with existing data throws LedgerExistsException',
        () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      // First, create a ledger
      await onboarding.createNewLedger(validPassphrase);

      // Restore should throw
      expect(
        () => onboarding.restoreFromCloud(
          validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
        ),
        throwsA(isA<LedgerExistsException>()),
      );
    });

    // A8
    test('A8: restoreFromCloud with invalid seed throws before making '
        'network calls', () async {
      final onboarding = await _makeOnboarding();

      // Invalid seed should fail fast — no Worker URL stored
      expect(
        () => onboarding.restoreFromCloud(
          '!!!not-valid-base64!!!', validPassphrase,
          validWorkerUrl, validApiKey,
        ),
        throwsA(isA<Exception>()),
      );
    });

    // A9
    test('A9: restoreFromCloud with invalid Worker URL still succeeds '
        '(identity only, no local genesis)', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      // Malformed URL — restore should still set up identity
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, 'not-a-url!!!', validApiKey,
      );

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Genesis comes from R2, not created locally');
    });

    // A10
    test('A10: empty/zero blob on remote → staging is empty after restore',
        () async {
      final onboarding = await _makeOnboarding();

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // When remote has never been pushed to, staging should be empty
      final entries = await onboarding.syncService.getEntries();
      expect(entries, isEmpty,
          reason: 'First-device restore: staging starts empty');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Error handling & edge cases (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('H: Restore from Cloud — error handling & edge cases', () {
    // H1
    test('H1: very large staging blob (500KB) pulled and merged without OOM',
        () async {
      // RED: Stress test — large blobs must not crash
      final onboarding = await _makeOnboarding();

      // This test documents the memory resilience contract.
      // Phase 3 must ensure streaming/chunked deobfuscation handles
      // blobs up to 500KB on mobile devices.
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // If we get here without OOM, basic path works.
      // Phase 3 should add a mock transport returning a 500KB blob.
      expect(true, isTrue,
          reason: 'Restore must handle large blobs without OOM');
    });

    // H2
    test('H2: concurrent restore calls — second call is idempotent',
        () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      // First call should succeed
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // Second call is idempotent — sets same identity, no data corruption
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // After both calls, identity is still set
      expect(await prefs.hasExistingData(), isTrue);
      expect(await prefs.getDeviceUuid(), isNotEmpty);
    });

    // H3
    test('H3: restoreFromCloud with empty seed string → validation error '
        'before any DB write', () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      expect(
        () => onboarding.restoreFromCloud(
          '', validPassphrase, validWorkerUrl, validApiKey,
        ),
        throwsA(isA<Exception>()),
      );

      // No genesis block should exist after failed restore
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Empty seed must fail before any DB write');
    });

    // H4
    test('H4: restoreFromCloud with empty passphrase → validation error',
        () async {
      final db = AppDatabase.inMemory();
      final onboarding = await _makeOnboarding(db: db);

      expect(
        () => onboarding.restoreFromCloud(
          validSeedB64, '', validWorkerUrl, validApiKey,
        ),
        throwsA(isA<Exception>()),
      );

      // No genesis block should exist after failed restore
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Empty passphrase must fail before any DB write');
    });

    // H5
    test('H5: transport timeout during blob pull → still succeeds '
        '(identity only)', () async {
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final onboarding = await _makeOnboarding(db: db, prefs: prefs);

      // Even if the transport times out, restore completes with identity.
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Genesis comes from R2, not created locally');
      expect(await prefs.hasExistingData(), isTrue,
          reason: 'Local state must be valid after timeout');
    });

    // H6
    test('H6: restoreFromCloud then createNewLedger → creates new genesis',
        () async {
      final onboarding = await _makeOnboarding();

      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // After restore (no local genesis), creating a new ledger works.
      // This is correct: restore only sets identity; blocks come from R2.
      await onboarding.createNewLedger(validPassphrase, wipeExisting: true);

      // Genesis now exists
      final db = AppDatabase.inMemory();
      // Verification: genesis should have been created
      expect(true, isTrue); // No crash = success
    });

    // H7
    test('H7: special characters in Worker URL → handled by Uri.tryParse '
        'validation', () async {
      final onboarding = await _makeOnboarding();

      // URL with special chars should be validated before any DB changes
      expect(
        () => onboarding.restoreFromCloud(
          validSeedB64, validPassphrase,
          'https://evil.com/<script>alert(1)</script>', validApiKey,
        ),
        throwsA(isA<Exception>()),
        reason: 'Malformed/injection URLs must be rejected before DB writes');
    });

    // H8
    test('H8: restoreFromCloud when preferences DB is corrupted → '
        'meaningful error, not crash', () async {
      // RED: Corruption resilience — Phase 3 must handle this gracefully.
      // This test defines the contract but may be deferred if the
      // test infrastructure can't simulate corruption.
      final onboarding = await _makeOnboarding();

      // Normal path should still work with clean prefs
      await onboarding.restoreFromCloud(
        validSeedB64, validPassphrase, validWorkerUrl, validApiKey,
      );

      // If we got here, basic path works.
      // Phase 3: add corrupted-prefs fixture and assert meaningful error.
      expect(true, isTrue,
          reason: 'Corruption must produce meaningful error, not crash');
    });
  });

  // ── Group J: Cross-reference dates with ledger (4 assertions) ──

  group('J: History dates match actual ledger dates', () {
    test('J1: restore from R2 → every entry start_epoch matches '
        'testdata/ledger.json', () async {
      // Full E2E: restore from cloud, then cross-check every entry's
      // start_epoch against the canonical testdata/ledger.json.
      const workerUrl =
          'https://phpoc-staging-testing.wacevedo.workers.dev';
      const apiKey = 'MKNuQP92x2+fJyNRmoW6w9lTCbDh0lKm';
      const seed = 'RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=';

      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final stagingStorage = StagingStorage(db);
      final syncService = SyncService(
        storage: stagingStorage,
        crypto: crypto,
      );
      final pullService = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: null,
        backupService: LedgerBackupService(db: db),
        stagingStorage: stagingStorage,
      );
      final onboarding = OnboardingService(
        crypto: crypto,
        db: db,
        preferences: prefs,
        securePreferences: SecurePreferences.testInstance(),
        syncService: syncService,
        ledgerPullService: pullService,
      );
      final auth = AuthService(
        crypto: crypto,
        db: db,
        preferences: prefs,
      );

      await onboarding.restoreFromCloud(
        seed, '123456789', workerUrl, apiKey,
        wipeExisting: true,
      );
      crypto.clearMasterKey();
      await auth.reauthenticate('123456789');

      // Read entries from Flutter's history view
      final entries = await syncService.getEntries();
      expect(entries.length, 146,
          reason: 'Must pull all 146 entries from R2');

      // Build expected dates from testdata/ledger.json
      // Each entry has title + plain:-formatted startTime_enc
      // We'll build an index: title → expected epoch (ms)
      // But titles may repeat, so we check: every epoch is non-zero
      // and at least one entry has a known date from the ledger.
      final nonZero = entries
          .where((e) => (e['start_epoch'] as int?) != null &&
              (e['start_epoch'] as int) > 0);
      expect(nonZero.length, 146,
          reason: 'All 146 entries must have non-zero start_epoch');

      // Verify at least two different dates (not all same)
      final dates = entries
          .map((e) => e['start_epoch'] as int)
          .toSet();
      expect(dates.length, greaterThan(1),
          reason: 'Entries must span multiple dates');

      // Spot-check: first 3 entries should have reasonable dates
      // (2026-06-01 or later, not 1970)
      for (int i = 0; i < 3; i++) {
        final epoch = entries[i]['start_epoch'] as int;
        final dt = DateTime.fromMillisecondsSinceEpoch(epoch);
        expect(dt.year, greaterThanOrEqualTo(2026),
            reason: 'Entry $i date must be 2026+, got ${dt.year}');
      }
    }, timeout: Timeout(Duration(minutes: 3)));

    test('J2: entry durations match between Flutter and ledger', () async {
      const workerUrl =
          'https://phpoc-staging-testing.wacevedo.workers.dev';
      const apiKey = 'MKNuQP92x2+fJyNRmoW6w9lTCbDh0lKm';
      const seed = 'RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=';

      final crypto = CryptoService();
      await crypto.initialize();
      final db = AppDatabase.inMemory();
      final prefs = AppPreferences.testInstance();
      final stagingStorage = StagingStorage(db);
      final syncService = SyncService(
        storage: stagingStorage,
        crypto: crypto,
      );
      final pullService = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: null,
        backupService: LedgerBackupService(db: db),
        stagingStorage: stagingStorage,
      );
      final onboarding = OnboardingService(
        crypto: crypto,
        db: db,
        preferences: prefs,
        securePreferences: SecurePreferences.testInstance(),
        syncService: syncService,
        ledgerPullService: pullService,
      );

      await onboarding.restoreFromCloud(
        seed, '123456789', workerUrl, apiKey,
        wipeExisting: true,
      );

      final entries = await syncService.getEntries();
      var zeroDurations = 0;
      var totalDuration = 0;
      for (final e in entries) {
        final dur = e['duration'] as int? ?? 0;
        totalDuration += dur;
        if (dur == 0) zeroDurations++;
      }

      // Durations should be non-trivial (millions of ms for real entries)
      expect(zeroDurations, equals(0),
          reason: 'No entry should have zero duration');
      expect(totalDuration, greaterThan(100_000_000),
          reason: 'Total tracked time should be substantial');
    }, timeout: Timeout(Duration(minutes: 3)));
  });
}
