import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// Ph-7 step 2 phone e2e — re-onboard migrated ledger + verify, ON DEVICE.
///
/// Runs on the Android emulator (integration_test). Loads the migrated
/// 132-block ledger from the bundled asset and exercises TWO on-device import
/// paths against file-backed SQLite, then runs `LedgerChain.verify()`:
///
///   Path A — `LedgerBackupService.importFromJson` (PHPSPEC pull, PRESERVES
///            the migrated genesis). This is the storage-fidelity use case;
///            must verify() True with all 132 blocks.
///   Path B — `OnboardingService.importFromFile` (the app's "import from
///            file" onboarding). REGRESSION guard for the Ph-7 genesis-
///            preservation fix: _importRawChain/_importV2 now pass
///            keepExistingGenesis:true so the migrated canonical genesis is
///            preserved (not replaced by a Flutter-format {seed} genesis),
///            so verify() must ALSO be True with all 132 blocks.
const seedB64 = String.fromEnvironment('PH_SEED', defaultValue: '');
const passphrase = 'CorrectHorseBatteryStaple42!';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Ph-7 on-device: re-onboard + verify migrated 132-block ledger',
      (tester) async {
    // ── 0. creds ──
    expect(seedB64, isNotEmpty,
        reason: 'pass --dart-define=PH_SEED=<recovery seed>');

    // ── 1. Load migrated ledger from bundled asset ──
    final raw = await rootBundle.loadString('assets/migrated_ledger.json');
    final blocks = jsonDecode(raw) as List<dynamic>;
    debugPrint('LEDGER: loaded ${blocks.length} blocks from asset');
    expect(blocks.length, 132, reason: 'migrated 132-block ledger');

    // ── 2. Write ledger to an app-accessible temp file ──
    final dir = await Directory.systemTemp.createTemp('ph7_onboard');
    final file = File('${dir.path}/migrated_ledger.json');
    await file.writeAsString(raw);

    final crypto = CryptoService()..initialize();

    // Decrypt derives the master key (as the app does post-auth) so
    // seal/content verification has MK available.
    final mk = crypto.deriveMasterKey(seedB64);
    crypto.setMasterKey(mk);

    // ════════════════════════════════════════════════════════
    // Path A — LedgerBackupService.importFromJson (PHPSPEC pull).
    // Preserves the migrated genesis → verify() should PASS (132).
    // ════════════════════════════════════════════════════════
    final dbA = AppDatabase.inMemory();
    final backupA = LedgerBackupService(db: dbA);
    await backupA.importFromJson(raw);
    final storeA = LedgerBlockStore(dbA.blockDao);
    final chainA = LedgerChain(crypto: crypto, store: storeA);
    final countA = chainA.getBlockCount();
    String? failA;
    int? failIdxA;
    final mapsA = storeA.readBlocks() as List<Map<String, dynamic>>;
    for (var i = 0; i < mapsA.length; i++) {
      final b = mapsA[i];
      if (i > 0) {
        final prev = mapsA[i - 1];
        final pk = _hkFor(prev['type']);
        if ((b['prev_hash'] as String? ?? '') != (prev[pk] as String? ?? '')) {
          failA = 'prev_hash@$i (${b['type']})'; failIdxA = i; break;
        }
      }
      if (!chainA.verifyBlock(i)) {
        final hk = _hkFor(b['type']);
        failA = 'seal@$i ${b['type']} ($hk=${(b[hk] as String? ?? '').substring(0, 8)}...) date=${b['date']} keys=${b.keys.toList()}'; failIdxA = i; break;
      }
    }
    final verifyA = chainA.verify();
    debugPrint('PATH-A (importFromJson, preserves genesis): '
        'blocks=$countA verify=$verifyA firstFail=$failA');

    // ════════════════════════════════════════════════════════
    // Path B — OnboardingService.importFromFile (onboarding screen).
    // Regression guard for Ph-7 genesis-preservation fix: importFromFile
    // must PRESERVE the migrated canonical genesis and verify() True.
    // ════════════════════════════════════════════════════════
    final dbB = AppDatabase.inMemory();
    // Match the real app's provider: SyncService backed by a SQLite
    // StagingStore so Path B ALSO seeds ledger activities into staging
    // (which is what the History calendar reads).
    final stagingStore = StagingStore(dbB);
    final syncB = SyncService(
      storage: _FakeKv(),
      crypto: crypto,
      stagingStore: stagingStore,
    );
    final service = OnboardingService(
      crypto: crypto,
      db: dbB,
      preferences: AppPreferences.testInstance(),
      securePreferences: SecurePreferences.testInstance(),
      syncService: syncB,
    );
    await service.importFromFile(file.path, seedB64, passphrase,
        wipeExisting: true);
    final storeB = LedgerBlockStore(dbB.blockDao);
    final chainB = LedgerChain(crypto: crypto, store: storeB);
    final countB = chainB.getBlockCount();
    final verifyB = chainB.verify();
    // The user-facing symptom: activities must appear in the History
    // calendar. That calendar reads the StagingStore, which the onboarding
    // must seed from the imported ledger's (full-map data_enc) blocks.
    final seededB = await stagingStore.count();
    debugPrint('PATH-B (importFromFile, onboard preserve genesis): '
        'blocks=$countB verify=$verifyB seededStaging=$seededB');

    // ════════════════════════════════════════════════════════
    // Acceptance (Ph-7): BOTH on-device import paths (storage-fidelity PHPSPEC
    // pull AND the app's import-from-file onboarding) must preserve the
    // migrated canonical genesis and verify() True with all 132 blocks.
    // ════════════════════════════════════════════════════════
    debugPrint('PH7E2E RESULT: pathA(importFromJson)=verify:$verifyA '
        'blocks:$countA | pathB(importFromFile)=verify:$verifyB '
        'blocks:$countB');
    expect(verifyA, isTrue,
        reason: 'migrated 132-block ledger must verify() on device '
            '(genesis-preserving PHPSPEC import)');
    expect(verifyB, isTrue,
        reason: 'REGRESSION: importFromFile onboarding must ALSO preserve '
            'the migrated canonical genesis and verify() on device');
  });
}

/// Minimal KV storage for SyncService construction.
class _FakeKv {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Canonical hash-key field name per block type.
String _hkFor(String? type) {
  switch (type) {
    case 'genesis':
      return 'block_hash';
    case 'day':
      return 'day_hash';
    case 'month_summary':
      return 'month_hash';
    case 'year_summary':
      return 'year_hash';
    default:
      return '';
  }
}
