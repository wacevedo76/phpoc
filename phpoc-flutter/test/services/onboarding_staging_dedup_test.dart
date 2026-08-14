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

/// Group I: `OnboardingService._seedStagingFromImportedBlocks` dedup fix —
/// RED tests.
///
/// Blueprint: docs/planning/flutter/STAGING_SEED_DEDUP_FIX_PHASE1.md (I1–I5)
///
/// Mirrors Group S on the import path: a raw-chain / v2 import re-seeds
/// staging from the sealed ledger day-blocks. Because `_prepareEntries`
/// strips `entry_id`/`hash` while retaining `data['activity_id']`, the
/// import seed dedup (keyed only on entry_id/hash) mints a fresh
/// `generateActivityId()` for every committed block entry → duplicate rows.
const validPassphrase = 'CorrectHorseBatteryStaple42!';
const testSeedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

class _InMemoryStorage {
  final Map<String, dynamic> _d = {};
  Future<dynamic> get(String key) async => _d[key];
  Future<void> set(String key, dynamic value) async => _d[key] = value;
  Future<void> remove(String key) async => _d.remove(key);
}

/// A committed, seeded staging row shaped like an existing device-created
/// row: blob `entry_id`/`hash` empty (stripped at seal) but the row-level
/// `activity_id` column set.
Map<String, dynamic> _committedSeedRow(String activityId, String title) {
  return {
    'activity_id': activityId,
    'activity_status': 'ended',
    'activity': jsonEncode({
      'entry_id': '',
      'hash': '',
      'title': title,
      'start_epoch': 1_717_200_000_000,
      'end_epoch': 1_717_200_000_000,
      'duration': 0,
      'is_active': false,
      'is_paused': false,
      'pauses': <dynamic>[],
      'tags': <dynamic>[],
      'comment': '',
      'media': <dynamic>[],
      'device_uuid': '',
      'committed': true,
    }),
    'committed': true,
  };
}

/// Build a migrated-format raw ledger (genesis + one day block). The day
/// block entry carries a stable 10-char `activity_id` in its `data` and NO
/// `entry_id` / NO `hash`, with MK-encrypted time fields.
List<Map<String, dynamic>> _rawLedgerWithActivityId(
  CryptoService crypto, {
  required String activityId,
  String title = 'Imported committed task',
  int startEpoch = 1_717_200_000_000,
  int duration = 3_600_000,
}) {
  final mk = crypto.getMasterKey()!;
  return [
    {
      'type': 'genesis',
      'day_index': 0,
      'date': '2026-06-01',
      'identity': {'username': 'testuser'},
      'prev_hash': '0' * 64,
      'entries': <dynamic>[],
      'block_hash': 'a' * 64,
    },
    {
      'type': 'day',
      'day_index': 1,
      'date': '2026-06-01',
      'prev_hash': 'a' * 64,
      'entries': [
        {
          'hash': '',
          'data': {
            'activity_id': activityId,
            'title': title,
            'duration': duration,
            'startTime_enc': crypto.encrypt('$startEpoch', mk),
            'endTime_enc': crypto.encrypt('${startEpoch + duration}', mk),
            'pauses_enc': crypto.encrypt('[]', mk),
            'is_active': false,
            'is_paused': false,
          },
        },
      ],
      'day_hash': 'c' * 64,
    },
  ];
}

/// Build a raw ledger whose day entry carries BOTH entry_id and activity_id.
List<Map<String, dynamic>> _rawLedgerMixedId(
  CryptoService crypto, {
  required String activityId,
  required String entryId,
}) {
  final mk = crypto.getMasterKey()!;
  const startEpoch = 1_717_200_000_000;
  return [
    {
      'type': 'genesis',
      'day_index': 0,
      'date': '2026-06-01',
      'identity': {'username': 'testuser'},
      'prev_hash': '0' * 64,
      'entries': <dynamic>[],
      'block_hash': 'a' * 64,
    },
    {
      'type': 'day',
      'day_index': 1,
      'date': '2026-06-01',
      'prev_hash': 'a' * 64,
      'entries': [
        {
          'hash': 'beef',
          'data': {
            'activity_id': activityId,
            'entry_id': entryId,
            'title': 'Mixed-id task',
            'duration': 1_800_000,
            'startTime_enc': crypto.encrypt('$startEpoch', mk),
            'endTime_enc':
                crypto.encrypt('${startEpoch + 1_800_000}', mk),
            'pauses_enc': crypto.encrypt('[]', mk),
            'is_active': false,
            'is_paused': false,
          },
        },
      ],
      'day_hash': 'c' * 64,
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

/// Write [ledger] to a temp JSON file and import it via importFromFile.
Future<void> _seedByImport(
  OnboardingService onboarding,
  List<Map<String, dynamic>> ledger,
) async {
  final dir = Directory.systemTemp.createTempSync('phpoc_imp_seed_');
  final file = File('${dir.path}/ledger.json');
  await file.writeAsString(jsonEncode(ledger));
  await onboarding.importFromFile(file.path, testSeedB64, validPassphrase,
      wipeExisting: true);
}

void main() {
  // ── Group I: _seedStagingFromImportedBlocks dedup (OnboardingService) ──
  group('I: import re-seed dedup by activity_id', () {
    test(
        'I1: import re-seed skips a block activity already present by '
        'activity_id (no duplicate)', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
      final stagingStore = StagingStore(db);
      final onboarding = await _makeOnboarding(
          db: db, crypto: crypto, stagingStore: stagingStore);

      // Pre-existing committed row (device-created, keys by activity_id).
      await stagingStore.putRow(_committedSeedRow(activityId, 'Task A'));

      await _seedByImport(
          onboarding, _rawLedgerWithActivityId(crypto, activityId: activityId));

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1),
          reason:
              'I1: the import re-seed must skip a committed block activity '
              'whose data[activity_id] already exists in staging — the map '
              'mirrors the live phone duplication on the import path.');
    });

    test(
        'I2: activity_id present in block data is REUSED (not re-generated) '
        'on import', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
      final stagingStore = StagingStore(db);
      final onboarding = await _makeOnboarding(
          db: db, crypto: crypto, stagingStore: stagingStore);

      await _seedByImport(
          onboarding, _rawLedgerWithActivityId(crypto, activityId: activityId));

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['activity_id'], activityId,
          reason:
              'I2: a block entry that retains data[activity_id] must reuse '
              'that id after import instead of minting generateActivityId().');
    });

    test('I3: _seedStagingFromImportedBlocks is idempotent when run twice',
        () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
      final stagingStore = StagingStore(db);
      final onboarding = await _makeOnboarding(
          db: db, crypto: crypto, stagingStore: stagingStore);

      // Seed the raw chain once...
      final firstLedger =
          _rawLedgerWithActivityId(crypto, activityId: activityId);
      final dir1 = Directory.systemTemp.createTempSync('phpoc_i3_');
      final f1 = File('${dir1.path}/ledger.json');
      await f1.writeAsString(jsonEncode(firstLedger));
      await onboarding.importFromFile(f1.path, testSeedB64, validPassphrase,
          wipeExisting: true);

      final afterFirst = (await stagingStore.getAllRows()).length;

      // ...then seed again (importFromFile can run after an earlier seed).
      final dir2 = Directory.systemTemp.createTempSync('phpoc_i3b_');
      final f2 = File('${dir2.path}/ledger.json');
      await f2.writeAsString(jsonEncode(
          _rawLedgerWithActivityId(crypto, activityId: activityId)));
      await onboarding.importFromFile(f2.path, testSeedB64, validPassphrase,
          wipeExisting: true);

      final afterSecond = (await stagingStore.getAllRows()).length;
      expect(afterFirst, 1);
      expect(afterSecond, afterFirst,
          reason:
              'I3: running the import seed twice must not grow staging — the '
              're-seed must dedup by activity_id.');
    });

    test(
        'I4: mixed entry_id-vs-activity_id dedup across seed runs → single '
        'row', () async {
      const activityId = 'abcdefghij';
      const entryId = '00000000-0000-0000-0000-0000000000cd';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
      final stagingStore = StagingStore(db);
      final onboarding = await _makeOnboarding(
          db: db, crypto: crypto, stagingStore: stagingStore);

      // Run 1: existing row keyed by activity_id only.
      await stagingStore.putRow(_committedSeedRow(activityId, 'Task A'));

      // Run 2: a block entry carrying BOTH entry_id and activity_id.
      await _seedByImport(onboarding,
          _rawLedgerMixedId(crypto, activityId: activityId, entryId: entryId));

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1),
          reason:
              'I4: across seed runs that key differently (one by activity_id, '
              'one carrying a fresh entry_id) the existing activity_id must '
              'still win — no duplicate row.');
    });

    test(
        'I5: seeded row with original activity_id still carries committed:true '
        'and end_epoch', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(crypto.deriveMasterKey(testSeedB64));
      final stagingStore = StagingStore(db);
      final onboarding = await _makeOnboarding(
          db: db, crypto: crypto, stagingStore: stagingStore);

      const startEpoch = 1_717_200_000_000;
      const duration = 3_600_000;
      await _seedByImport(onboarding, _rawLedgerWithActivityId(
        crypto,
        activityId: activityId,
        startEpoch: startEpoch,
        duration: duration,
      ));

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1));
      final row = rows.single;
      expect(row['activity_id'], activityId);
      expect(row['activity_status'], 'ended');
      final blob =
          jsonDecode(row['activity'] as String) as Map<String, dynamic>;
      expect(blob['committed'], true,
          reason:
              'I5: a re-seeded committed row must stay committed (no orange '
              'border) so History shows the correct time span.');
      expect(blob['end_epoch'], startEpoch + duration,
          reason:
              'I5: the imported committed row must expose end_epoch so the '
              'History calendar renders its time span.');
    });
  });
}
