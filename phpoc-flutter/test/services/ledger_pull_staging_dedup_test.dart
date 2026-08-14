import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show computeEntryHash;
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';

/// Group S: `LedgerPullService._seedStagingFromBlocks` dedup fix — RED tests.
///
/// Blueprint: docs/planning/flutter/STAGING_SEED_DEDUP_FIX_PHASE1.md (S1–S6)
///
/// Root-cause bug reproduced here: `_seedStagingFromBlocks` dedups only by
/// a block entry's `entry_id`/`hash`, but `LedgerEngine._prepareEntries`
/// strips those before sealing while **retaining `data['activity_id']`**.
/// So a committed block entry that carries only `activity_id` is re-seeded
/// with a fresh `generateActivityId()` → a second duplicate staging row.
///
/// The fix (Phase 3) must (P1) dedup by `activity_id` too and (P2) reuse
/// `data['activity_id']` instead of minting a new id. All S-tests are
/// written against the public `pullAll()` entry point.
const testMkHex =
    'abababababababababababababababababababababababababababababababab';

/// A committed, seeded staging row shaped EXACTLY as
/// `_seedStagingFromBlocks` writes today: the `activity` blob carries an
/// empty `entry_id` and empty `hash` (both stripped by `_prepareEntries`),
/// but the row-level `activity_id` column is set. This is the canonical
/// "device-created committed row" the dedup fix must detect.
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

/// Build a day-block `{hash, data}` entry whose data has a stable 10-char
/// `activity_id` and NO `entry_id` / NO `hash`-field in data (exactly what a
/// sealed committed block carries after `_prepareEntries` strips those
/// staging-only fields). The outer entry `hash` is a valid computed hash so
/// `_validateImportedChain`/verifyEntryHashTwoWay accepts the block.
Map<String, dynamic> _activityIdOnlyEntry(
  CryptoService crypto,
  String activityId, {
  String title = 'Committed task',
  int startEpoch = 1_717_200_000_000,
  int duration = 3_600_000,
}) {
  final mk = crypto.getMasterKey()!;
  final data = <String, dynamic>{
    'activity_id': activityId,
    'title': title,
    'duration': duration,
    'startTime_enc': crypto.encrypt('$startEpoch', mk),
    'endTime_enc': crypto.encrypt('${startEpoch + duration}', mk),
    'pauses_enc': crypto.encrypt('[]', mk),
    'is_active': false,
    'is_paused': false,
  };
  return {'hash': computeEntryHash(data), 'data': data};
}

/// Day-block entry that drops `activity_id` entirely (legacy/foreign
/// blocks that carry neither `entry_id` nor `activity_id`).
Map<String, dynamic> _anchorlessEntry(CryptoService crypto,
    {int startEpoch = 1_717_200_000_000}) {
  final mk = crypto.getMasterKey()!;
  final data = <String, dynamic>{
    'title': 'Legacy entry',
    'duration': 900_000,
    'startTime_enc': crypto.encrypt('$startEpoch', mk),
    'endTime_enc': crypto.encrypt('${startEpoch + 900_000}', mk),
    'pauses_enc': crypto.encrypt('[]', mk),
    'is_active': false,
    'is_paused': false,
  };
  return {'hash': computeEntryHash(data), 'data': data};
}

/// Minimal genesis block JSON.
Map<String, dynamic> _genesisBlock() => {
      'type': 'genesis',
      'day_index': 0,
      'date': '2026-06-01',
      'prev_hash': '0' * 64,
      'entries': <dynamic>[],
      'block_hash': 'genesis-hash',
    };

/// A single day block holding [entries], keyed by a fixed hash so the pull
/// is deterministic.
Map<String, dynamic> _dayBlock(List<Map<String, dynamic>> entries) => {
      'type': 'day',
      'day_index': 1,
      'date': '2026-06-02',
      'prev_hash': 'genesis-hash',
      'block_hash': 'day-hash',
      'entries': entries,
    };

class _FakePullTransport implements HttpTransport {
  @override
  final String baseUrl = 'https://test-worker.example.com';
  @override
  final String apiKey = 'fake-api-key';
  final Map<String, Uint8List> blockStore = {};
  String? hashIndexJson;

  @override
  Future<Uint8List?> pull(String path) async {
    if (path == 'ledger/hash_index.json' && hashIndexJson != null) {
      return Uint8List.fromList(utf8.encode(hashIndexJson!));
    }
    return blockStore[path]; // null = 404
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    blockStore[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    // Match the real Worker ?prefix= API: return entries relative to the
    // prefix so the pull's index parser can extract 000000/000001 etc.
    return blockStore.keys
        .where((k) => k.startsWith(prefix))
        .map((k) => k.substring(prefix.length))
        .toList();
  }

  @override
  Future<void> healthCheck() async {}

  @override
  Future<void> delete(String path) async {
    blockStore.remove(path);
  }
}


void main() {
  // ── Group S: _seedStagingFromBlocks dedup (LedgerPullService) ──
  group('S: pull re-seed dedup by activity_id', () {
    test(
        'S1: block entry whose data[activity_id] already exists in staging '
        'is NOT re-seeded (no duplicate row)', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      // Pre-existing committed row — the original device-created activity.
      await stagingStore.putRow(_committedSeedRow(activityId, 'Task A'));

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            _activityIdOnlyEntry(crypto, activityId),
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );
      await service.pullAll();

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1),
          reason:
              'S1: a committed block entry whose data[activity_id] is already '
              'in staging must be skipped — entry_id/hash are stripped by '
              '_prepareEntries, so activity_id is the only stable key. A '
              'duplicate would reproduce the live phone bug (8 exact dup '
              'pairs).');
    });

    test(
        'S2: block entry WITH data[activity_id] re-seeds using that same '
        'id (not generateActivityId())', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            _activityIdOnlyEntry(crypto, activityId, title: 'Task B'),
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );
      await service.pullAll();

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['activity_id'], activityId,
          reason:
              'S2: when the sealed block data retains data[activity_id], the '
              're-seed must reuse it instead of minting a fresh '
              'generateActivityId() — otherwise the same activity gets a '
              'second row with a different id.');
    });

    test(
        'S3: block entry with NO activity_id and NO entry_id still seeds '
        '(backward compatibility fallback)', () async {
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            _anchorlessEntry(crypto),
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );
      await service.pullAll();

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1),
          reason:
              'S3: a legacy/foreign block entry carrying neither activity_id '
              'nor entry_id must still surface in History via '
              'generateActivityId() fallback.');
    });

    test(
        'S4: when both entry_id and activity_id present, dedup honors EITHER '
        'identifier (skip if activity_id matches)', () async {
      const activityId = 'abcdefghij';
      const entryId = '00000000-0000-0000-0000-0000000000ab';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      // Existing row keyed by activity_id only (its blob entry_id is empty).
      await stagingStore.putRow(_committedSeedRow(activityId, 'Task A'));

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      // Data carrying BOTH activity_id and entry_id, outer hash valid.
      final s4Data = <String, dynamic>{
        ..._activityIdOnlyEntry(crypto, activityId)['data']! as Map,
        'entry_id': entryId,
      };
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            {'hash': computeEntryHash(s4Data), 'data': s4Data},
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );
      await service.pullAll();

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1),
          reason:
              'S4: a block entry carrying both entry_id and activity_id must '
              'dedup if EITHER matches a pre-existing row. The existing row '
              'keyed by activity_id must win — mixed-identifier seeds across '
              'pull sources must not duplicate.');
    });

    test(
        'S5: re-seeding the SAME block set twice yields NO extra rows '
        '(idempotence)', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            _activityIdOnlyEntry(crypto, activityId),
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );

      await service.pullAll();
      final afterFirst = (await stagingStore.getAllRows()).length;
      await service.pullAll();
      final afterSecond = (await stagingStore.getAllRows()).length;

      expect(afterFirst, 1);
      expect(afterSecond, afterFirst,
          reason:
              'S5: pullAll() runs on every restore/poll, so re-running it '
              'against the same committed block set must be idempotent — '
              'no extra staging rows.');
    });

    test(
        'S6: re-seeded/kept row preserves committed:true and updated_at '
        're-stamped after a dedup pull', () async {
      const activityId = 'abcdefghij';
      final db = AppDatabase.inMemory();
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      final stagingStore = StagingStore(db);

      // Pre-existing committed row (device-created, end_device_uuid set).
      await stagingStore.putRow(_committedSeedRow(activityId, 'Task A'));

      final transport = _FakePullTransport();
      transport.blockStore['ledger/blocks/000000.json'] =
          crypto.obfuscateBlob(jsonEncode(_genesisBlock()), testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = crypto.obfuscateBlob(
          jsonEncode(_dayBlock([
            _activityIdOnlyEntry(crypto, activityId),
          ])),
          testMkHex);
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: LedgerBackupService(db: db),
        stagingStorage: StagingStorage(db),
        stagingStore: stagingStore,
      );
      await service.pullAll();

      final rows = await stagingStore.getAllRows();
      expect(rows, hasLength(1));
      expect(rows.single['committed'], true,
          reason:
              'S6: after the dedup fix the kept committed row must stay a '
              'committed display row (no orange border). A re-seed copy '
              'created via re-add activities would otherwise lose '
              'end_device_uuid and flip committed semantics.');
      final blob =
          jsonDecode(rows.single['activity'] as String) as Map<String, dynamic>;
      expect(blob['committed'], true);
      expect(rows.single['updated_at'], isNotNull);
    });
  });
}
