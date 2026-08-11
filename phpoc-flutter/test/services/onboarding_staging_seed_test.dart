import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// Regression tests for [OnboardingService._seedStagingFromImportedBlocks].
///
/// Group U: staging seeding from migrated (PHPSPEC full-map) ledger imports.
///
/// Root-cause bug: after onboarding a migrated ledger, the HistoryScreen
/// calendar showed no activities because `_seedStagingFromImportedBlocks`
/// decoded `data_enc` expecting a legacy entries-only ARRAY, but migrated
/// (post-0.4.0) blocks store the payload as a full canonical MAP with the
/// entries nested under the `entries` key. The cast failed → total skipped →
/// staging (which the calendar reads) stayed empty.
const validPassphrase = 'CorrectHorseBatteryStaple42!';
const testSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

class _InMemoryStorage {
  final Map<String, dynamic> _d = {};
  Future<dynamic> get(String key) async => _d[key];
  Future<void> set(String key, dynamic value) async => _d[key] = value;
  Future<void> remove(String key) async => _d.remove(key);
}

/// Build a migrated-format raw ledger (genesis + day blocks) whose day
/// blocks serialize to a full canonical MAP in `data_enc`. Each entry has an
/// MK-encrypted `startTime_enc` so the calendar's `start_epoch` resolves.
List<Map<String, dynamic>> _rawLedger(CryptoService crypto, int epochMs) {
  final mk = crypto.getMasterKey()!;
  final startEnc = crypto.encrypt('$epochMs', mk);
  final endEnc = crypto.encrypt('${epochMs + 3_600_000}', mk);
  final dayEntry = {
    'hash': 'b' * 64,
    'data': {
      'entry_id': 'aaaaaaaaaa',
      'title': 'Migrated task',
      'duration': 3600,
      'is_active': false,
      'startTime_enc': startEnc,
      'endTime_enc': endEnc,
      'pauses_enc': '',
    },
  };
  return [
    {
      'type': 'genesis',
      'day_index': 0,
      'date': '2026-06-01',
      'identity': {'username': 'testuser'},
      'prev_hash': '0' * 64,
      'entries': <dynamic>[],
      'block_hash': 'a' * 64,
      'original_hash': 'a' * 64,
    },
    {
      'type': 'day',
      'day_index': 1,
      'date': '2026-06-01',
      'prev_hash': 'a' * 64,
      'entries': [dayEntry],
      'day_hash': 'c' * 64,
      'original_hash': 'c' * 64,
    },
  ];
}

Future<OnboardingService> _makeOnboarding({
  required AppDatabase db,
  required CryptoService crypto,
  required StagingStore stagingStore,
}) async {
  final storage = _InMemoryStorage();
  final sync = SyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: stagingStore,
  );
  return OnboardingService(
    crypto: crypto,
    db: db,
    preferences: AppPreferences.testInstance(),
    securePreferences: SecurePreferences.testInstance(),
    syncService: sync,
  );
}

void main() {
  test(
      'U1: migrated-format raw chain import seeds completed ledger entries '
      'into the StagingStore for the History calendar', () async {
    final db = AppDatabase.inMemory();
    final crypto = CryptoService()..initialize();
    crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
    final stagingStore = StagingStore(db);
    final onboarding = await _makeOnboarding(
        db: db, crypto: crypto, stagingStore: stagingStore);

    final epoch = DateTime(2026, 6, 1).millisecondsSinceEpoch;
    final ledger = _rawLedger(crypto, epoch);
    final file = File(
        '${Directory.systemTemp.createTempSync('phpoc_U_').path}/ledger.json');
    await file.writeAsString(jsonEncode(ledger));

    await onboarding.importFromFile(
        file.path, testSeedB64, validPassphrase,
        wipeExisting: true);

    final rows = await stagingStore.getAllRows();
    expect(rows, isNotEmpty,
        reason: 'migrated full-map data_enc must seed completed entries so '
            'the History calendar shows committed ledger activities');

    final activity =
        jsonDecode(rows.first['activity'] as String) as Map<String, dynamic>;
    expect(rows.first['activity_status'], 'ended',
        reason: 'seeded completed entries must be ended (not active)');
    expect(activity['start_epoch'], epoch,
        reason: 'start_epoch must be decrypted from startTime_enc so the '
            'calendar date shows correctly');
    expect(activity['title'], 'Migrated task');
    expect(activity['committed'], true,
        reason: 'seeded ledger entries are committed by definition');
    expect(activity['duration'], 3600);
  });
}
