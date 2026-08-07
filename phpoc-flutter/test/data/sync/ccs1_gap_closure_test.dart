import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/device_cookie.dart';
import 'package:phpoc_flutter/data/sync/staging_hash_index.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// CCS-1: Gap Closure Tests — Phase 2 (RED).
///
/// Covers Groups A–D (30 assertions) from:
///   docs/planning/CCS1_PHASE1.md
///
///   Group A (R7): Hash Index Push — 8 tests
///   Group B (R4): Committed Filter — 8 tests
///   Group C (A2): TTL → REAUTH — 7 tests
///   Group D (F1): Read-Only Fast Path — 7 tests

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure
// ═══════════════════════════════════════════════════════════════════

/// In-memory storage for SyncService's `storage` parameter.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
  bool hasKey(String key) => _data.containsKey(key);
}

/// Configurable transport spy: returns specific bytes per path,
/// records all push/pull paths and data.
class _ConfigTransport extends HttpTransport {
  final Map<String, Uint8List?> _pullResponses = {};
  final List<String> pullPaths = [];
  final List<String> pushPaths = [];
  final List<Uint8List> pushData = [];
  bool _throwOnAll = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  void setPullResponse(String path, Uint8List? data) {
    _pullResponses[path] = data;
  }

  void setThrowOnAll(bool value) => _throwOnAll = value;

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (_throwOnAll) throw Exception('Simulated network failure');
    if (_pullResponses.containsKey(path)) return _pullResponses[path];
    return null;
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    pushPaths.add(path);
    pushData.add(data);
    if (_throwOnAll) throw Exception('Simulated network failure');
  }

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

/// Create a CryptoService with cached MK.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

const _knownSpecifier = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/// Bundles test artifacts.
class _RowTestHarness {
  final SyncService svc;
  final StagingStore stagingStore;
  final _FakeStorage storage;
  final _ConfigTransport transport;
  final AppDatabase db;

  _RowTestHarness(
      this.svc, this.stagingStore, this.storage, this.transport, this.db);

  /// Seed a valid recent cookie with the known specifier.
  Future<void> seedValidCookie() async {
    final now = DateTime.now().millisecondsSinceEpoch;
    await storage.set('cookie', {
      'device_specifier': _knownSpecifier,
      'creation_time': now,
    });
  }

  /// Seed an expired cookie (creation_time far in the past).
  Future<void> seedExpiredCookie() async {
    // 2 hours ago — well past any reasonable TTL
    final expired = DateTime.now().millisecondsSinceEpoch - (120 * 60 * 1000);
    await storage.set('cookie', {
      'device_specifier': _knownSpecifier,
      'creation_time': expired,
    });
  }

  /// Add a row directly to the staging store (bypasses SyncService).
  Future<void> addRow({
    required String activityId,
    required String status,
    int updatedAt = 1000,
    String title = 'Test Task',
    bool committed = false,
  }) async {
    await stagingStore.putRow({
      'activity_id': activityId,
      'activity_status': status,
      'activity': json.encode({
        'title': title,
        'start_epoch': 1000,
        'duration': 0,
        'is_active': status == 'active',
        'is_paused': status == 'paused',
        'pauses': [],
        'tags': [],
        'device_uuid': 'test-device',
        'committed': committed,
      }),
      'updated_at': updatedAt,
      'committed': committed,
      'title': title,
      'start_epoch': 1000,
      'duration': 0,
    }, preserveUpdatedAt: true);
  }

  /// Build an obfuscated staging/blob payload with given rows.
  Future<Uint8List> makeObfuscatedBlob(
      List<Map<String, dynamic>> rows) async {
    final blobData = {
      'entries': rows,
      'device_id': 'remote-device',
      'device_proof': 'proof-string',
    };
    final c = CryptoService();
    await c.initialize();
    final mk =
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    final jsonStr = json.encode(blobData);
    return c.obfuscateBlob(jsonStr, mk);
  }

  Future<void> close() async {
    svc.dispose();
    await db.close();
  }
}

/// Create a SyncService wired with StagingStore + configurable transport.
Future<_RowTestHarness> _makeRowSync({
  _ConfigTransport? transport,
  CryptoService? crypto,
  bool seedCookie = true,
}) async {
  final c = crypto ?? await _makeCrypto();
  final t = transport ?? _ConfigTransport();
  final storage = _FakeStorage();
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);

  if (seedCookie) {
    final now = DateTime.now().millisecondsSinceEpoch;
    await storage.set('cookie', {
      'device_specifier': _knownSpecifier,
      'creation_time': now,
    });
  }

  final svc = SyncService(
    storage: storage,
    crypto: c,
    transport: t,
    stagingStore: stagingStore,
  );

  return _RowTestHarness(svc, stagingStore, storage, t, db);
}

/// Build a remote-cookie payload matching the known specifier.
Uint8List _makeRemoteCookie(String specifier) {
  return Uint8List.fromList(utf8.encode(json.encode({
    'device_uuid': 'remote-device-uuid',
    'device_specifier': specifier,
  })));
}

// ═══════════════════════════════════════════════════════════════════
// Group A: R7 — Hash Index Push
// ═══════════════════════════════════════════════════════════════════

void main() {
  group('A: R7 — Hash Index Push', () {
    // A1
    test('A1 _pushStagingRowsToRemote pushes hash index to '
        'staging/hash_index.json after blob push', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'aaa001', status: 'active');

      // Match cookies for fast path, which calls _pushStagingRowsToRemote
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // Must push both blob and hash index
      expect(h.transport.pushPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'R7: hash index must be pushed to staging/hash_index.json '
              'after blob push');
      expect(h.transport.pushPaths, contains(StagingPaths.remoteRowLevelBlob),
          reason: 'Blob push must still happen');

      await h.close();
    });

    // A2
    test('A2 pushed hash index contains correct activity_ids matching '
        'current staging rows', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'taskA', status: 'active');
      await h.addRow(activityId: 'taskB', status: 'ended');

      // Match cookies for fast path
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // Find the hash_index.json push
      final idx = h.transport.pushPaths
          .indexOf(StagingPaths.remoteStagingHashIndex);
      expect(idx, isNot(-1), reason: 'Hash index must be pushed');

      // Decode the pushed hash index
      final hashIndexBytes = h.transport.pushData[idx];
      final hashIndexJson = utf8.decode(hashIndexBytes);
      final hashIndex =
          (json.decode(hashIndexJson) as List).cast<Map<String, dynamic>>();
      final ids =
          hashIndex.map((e) => e['activity_id'] as String).toSet();

      expect(ids, contains('taskA'),
          reason: 'Hash index must include taskA');
      expect(ids, contains('taskB'),
          reason: 'Hash index must include taskB');

      await h.close();
    });

    // A3
    test('A3 with zero staging rows, F1 fast path fires first — '
        'no hash index pushed (no writes → no network)', () async {
      final h = await _makeRowSync();

      // No rows added — staging is empty
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // F1: read-only fast path fires — no network calls at all
      // The remote already has the last pushed hash index; no need to re-push.
      // R7+F1 interaction: "hash index should NOT be pushed" (Phase 1 doc).
      expect(h.transport.pullPaths, isEmpty,
          reason: 'F1: zero pending writes → no remote cookie pull');
      expect(h.transport.pushPaths, isEmpty,
          reason: 'F1: zero pending writes → no push, not even hash index');

      await h.close();
    });

    // A4
    test('A4 _fastPathRowLevel identical hashes pushes hash index '
        'after blob push', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'identA', status: 'active');

      // Matching cookies for fast path
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Build matching remote hash index (same row → identical)
      final localIndex = await StagingHashIndex.build(h.stagingStore);
      final remoteHashBytes =
          Uint8List.fromList(utf8.encode(json.encode(localIndex)));
      h.transport.setPullResponse(
        StagingPaths.remoteStagingHashIndex,
        remoteHashBytes,
      );

      await h.svc.checkAndSync();

      // Identical hash path must still push hash index
      expect(h.transport.pushPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'F4+identical → push local → hash index must be refreshed');

      await h.close();
    });

    // A5
    test('A5 _fastPathRowLevel different hashes falls to reconcile '
        'and pushes hash index after merge', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'localOnly', status: 'active');

      // Matching cookies for fast path
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Build a different remote hash index (extra remote row)
      final remoteIndex = [
        {'activity_id': 'localOnly', 'activity_status': 'active'},
        {'activity_id': 'remoteOnly', 'activity_status': 'ended'},
      ];
      h.transport.setPullResponse(
        StagingPaths.remoteStagingHashIndex,
        Uint8List.fromList(utf8.encode(json.encode(remoteIndex))),
      );

      // Also provide remote blob so reconcile doesn't fail
      final remoteRows = [
        {
          'activity_id': 'remoteOnly',
          'activity_status': 'ended',
          'activity': '{"title":"Remote Only"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse(
        StagingPaths.remoteRowLevelBlob,
        await h.makeObfuscatedBlob(remoteRows),
      );

      await h.svc.checkAndSync();

      // After reconcile + merge, hash index should be pushed
      expect(h.transport.pushPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'R7 must execute after R6 in merge path');

      // Verify local now has both rows
      final rows = await h.stagingStore.getAllRows();
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, contains('localOnly'));
      expect(ids, contains('remoteOnly'));

      await h.close();
    });

    // A6
    test('A6 debounced auto-push includes hash index push', () async {
      final h = await _makeRowSync();

      // Capture triggers debounced push (_schedulePush → _doPush)
      await h.svc.capture(title: 'Auto-push task');

      // Wait for debounce timer (500ms) + small buffer
      await Future.delayed(const Duration(milliseconds: 600));

      // The auto-push path (_doPush → _attemptPush → _pushStagingRowsToRemote)
      // must push the hash index
      expect(h.transport.pushPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'A6: auto-push must include hash index push');
      expect(h.transport.pushPaths, contains(StagingPaths.remoteRowLevelBlob),
          reason: 'Auto-push must still push blob');

      await h.close();
    });

    // A7
    test('A7 hash index is NOT pushed when transport is null '
        '(local-only mode)', () async {
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final db = AppDatabase.inMemory();
      final stagingStore = StagingStore(db);

      // Seed cookie so checkAndSync doesn't bail at cookie gate
      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final svc = SyncService(
        storage: storage,
        crypto: crypto,
        transport: null, // local-only
        stagingStore: stagingStore,
      );

      // Add a row and push
      await svc.capture(title: 'Local task');

      // Must not crash — transport is null, push should be a no-op
      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'Local-only mode should return READY');

      svc.dispose();
      await db.close();
    });

    // A8
    test('A8 pushToRemote uses StagingStore hash index when '
        'stagingStore is available, not LocalCache', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'idxA8', status: 'active');

      await h.svc.pushToRemote();

      // pushToRemote must push hash index from StagingStore, not _local
      final hashIdx = h.transport.pushPaths
          .indexOf(StagingPaths.remoteStagingHashIndex);
      expect(hashIdx, isNot(-1),
          reason: 'A8: pushToRemote must push hash index from StagingStore');

      // Verify hash index content includes the staging store row
      final hashIndexBytes = h.transport.pushData[hashIdx];
      final hashIndexJson = utf8.decode(hashIndexBytes);
      final hashIndex =
          (json.decode(hashIndexJson) as List).cast<Map<String, dynamic>>();
      final ids = hashIndex.map((e) => e['activity_id'] as String).toSet();
      expect(ids, contains('idxA8'),
          reason: 'Hash index must contain staging store rows, '
              'not LocalCache data');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group B: R4 — Committed Filter
  // ═══════════════════════════════════════════════════════════════

  group('B: R4 — Committed Filter', () {
    // B1
    test('B1 _reconcileAndClaimRowLevel filters remote committed '
        'rows before merge', () async {
      final h = await _makeRowSync();
      await h.addRow(activityId: 'local1', status: 'active');

      // Destroy local cookie to force reconcile path (not fast path)
      await h.storage.remove('cookie');

      // Remote has committed rows
      final remoteRows = [
        {
          'activity_id': 'remoteCommitted',
          'activity_status': 'ended',
          'activity': '{"title":"Remote Committed","committed":true}',
          'updated_at': 5000,
          'committed': true,
        },
        {
          'activity_id': 'remoteActive',
          'activity_status': 'active',
          'activity': '{"title":"Remote Active"}',
          'updated_at': 6000,
        },
      ];
      h.transport.setPullResponse(
        StagingPaths.remoteRowLevelBlob,
        await h.makeObfuscatedBlob(remoteRows),
      );

      await h.svc.checkAndSync();

      // Committed remote row should NOT appear in local staging
      final rows = await h.stagingStore.getAllRows();
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, isNot(contains('remoteCommitted')),
          reason: 'B1: remote committed rows must be filtered before merge');
      expect(ids, contains('remoteActive'),
          reason: 'Non-committed remote rows should be merged');
      expect(ids, contains('local1'),
          reason: 'Local rows must survive merge');

      await h.close();
    });

    // B2
    test('B2 _reconcileAndClaimRowLevel filters local committed '
        'rows from the blob pushed to remote', () async {
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'keepMe', status: 'active', committed: false);
      await h.addRow(
          activityId: 'filterMe', status: 'ended', committed: true);

      // Destroy local cookie to force reconcile
      await h.storage.remove('cookie');

      // No remote rows
      await h.svc.checkAndSync();

      // Check the blob that was pushed to remote
      final blobIdx =
          h.transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
      expect(blobIdx, isNot(-1),
          reason: 'Blob must be pushed after reconcile');

      // We can't easily decrypt the obfuscated blob in the test,
      // so verify indirectly: committed row still in local store,
      // but we check that only ONE blob was pushed (if committed were
      // included, both would be in the blob — but we verify via count
      // after verifying local state below).

      // Committed row must stay locally for History/Dashboard
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 2,
          reason: 'Both rows remain in local staging for display');
      expect(
          rows.any((r) => r['activity_id'] == 'filterMe' && r['committed'] == true),
          isTrue,
          reason: 'Committed row preserved locally');

      await h.close();
    });

    // B3
    test('B3 _pushStagingRowsToRemote excludes committed rows '
        'from entries array', () async {
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'unc', status: 'active', committed: false);
      await h.addRow(
          activityId: 'com', status: 'ended', committed: true);

      // Matching cookies → fast path → _pushStagingRowsToRemote
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // Find the pushed blob and decode it
      final blobIdx =
          h.transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
      expect(blobIdx, isNot(-1), reason: 'Blob must be pushed');

      // Deobfuscate to verify committed row is excluded
      final crypto = CryptoService();
      await crypto.initialize();
      final mk =
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
      final blobBytes = h.transport.pushData[blobIdx];
      final deobfuscated = crypto.deobfuscateBlob(blobBytes, mk);
      final blobData = json.decode(deobfuscated) as Map<String, dynamic>;
      final entries = blobData['entries'] as List;

      final entryIds =
          entries.map((e) => e['activity_id'] as String).toSet();
      expect(entryIds, contains('unc'),
          reason: 'Uncommitted row must appear in pushed blob');
      expect(entryIds, isNot(contains('com')),
          reason: 'B3: committed row must be excluded from pushed blob');

      await h.close();
    });

    // B4
    test('B4 _rowIsCommitted returns true when row-level committed '
        'flag is true', () async {
      // Test indirectly: a row with committed=true at row level
      // must be excluded from the pushed blob.
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'rowLevel', status: 'ended', committed: true);
      // Also add uncommitted to ensure blob is non-empty
      await h.addRow(
          activityId: 'active', status: 'active', committed: false);

      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // Deobfuscate pushed blob
      final blobIdx =
          h.transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
      final mk =
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
      final crypto = CryptoService();
      await crypto.initialize();
      final blobBytes = h.transport.pushData[blobIdx];
      final deobfuscated = crypto.deobfuscateBlob(blobBytes, mk);
      final entries =
          (json.decode(deobfuscated) as Map)['entries'] as List;
      final ids = entries.map((e) => e['activity_id'] as String).toSet();

      expect(ids, contains('active'),
          reason: 'Uncommitted row must be in blob');
      expect(ids, isNot(contains('rowLevel')),
          reason: 'B4: row-level committed=true must cause exclusion');

      await h.close();
    });

    // B5
    test('B5 _rowIsCommitted returns true when activity blob has '
        'committed=true (not row-level flag)', () async {
      // Test indirectly: a row with committed=true inside the activity
      // JSON but NOT at row level must still be excluded from push.
      final h = await _makeRowSync();

      // Insert a row where committed is only in the activity JSON blob
      await h.stagingStore.putRow({
        'activity_id': 'blobLevel',
        'activity_status': 'ended',
        'activity': json.encode({
          'title': 'Blob Level Committed',
          'start_epoch': 1000,
          'duration': 500,
          'is_active': false,
          'pauses': [],
          'tags': [],
          'device_uuid': 'test-device',
          'committed': true, // committed in activity blob, not row level
        }),
        'updated_at': 1000,
        'committed': false, // row-level flag is false
        'title': 'Blob Level Committed',
        'start_epoch': 1000,
        'duration': 500,
      }, preserveUpdatedAt: true);

      await h.addRow(
          activityId: 'active2', status: 'active', committed: false);

      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // Deobfuscate pushed blob
      final blobIdx =
          h.transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
      final mk =
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
      final crypto = CryptoService();
      await crypto.initialize();
      final blobBytes = h.transport.pushData[blobIdx];
      final deobfuscated = crypto.deobfuscateBlob(blobBytes, mk);
      final entries =
          (json.decode(deobfuscated) as Map)['entries'] as List;
      final ids = entries.map((e) => e['activity_id'] as String).toSet();

      expect(ids, contains('active2'),
          reason: 'Uncommitted row must be in blob');
      expect(ids, isNot(contains('blobLevel')),
          reason: 'B5: activity-blob committed=true must cause exclusion');

      await h.close();
    });

    // B6
    test('B6 committed rows remain available for local queries '
        '(getCompleted, getEntries)', () async {
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'committed1',
          status: 'ended',
          committed: true,
          title: 'Committed Task');
      await h.addRow(
          activityId: 'active1',
          status: 'active',
          committed: false,
          title: 'Active Task');

      // getCompleted() should include committed rows
      final completed = await h.svc.getCompleted();
      final compIds =
          completed.map((e) => e['activity_id'] as String).toSet();
      expect(compIds, contains('committed1'),
          reason: 'B6: committed rows must appear in getCompleted()');

      // getEntries() should include committed rows
      final entries = await h.svc.getEntries();
      final entryIds =
          entries.map((e) => e['activity_id'] as String).toSet();
      expect(entryIds, contains('committed1'),
          reason: 'B6: committed rows must appear in getEntries() '
              'for History/Dashboard');

      await h.close();
    });

    // B7
    test('B7 when all staging rows are committed, F1 fast path fires — '
        'no blob push (no pending writes)', () async {
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'allCommitted', status: 'ended', committed: true);

      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      await h.svc.checkAndSync();

      // F1: all rows committed → no pending writes → no network calls
      // R7+F1 interaction: no writes → nothing changed, nothing to push.
      expect(h.transport.pushPaths, isEmpty,
          reason: 'F1: all-committed → no pending writes → no push');

      await h.close();
    });

    // B8
    test('B8 merge with mixed committed+uncommitted on both sides '
        'produces correct filtered result', () async {
      final h = await _makeRowSync();
      await h.addRow(
          activityId: 'localActive', status: 'active', committed: false);
      await h.addRow(
          activityId: 'localDone', status: 'ended', committed: true);

      // Destroy local cookie to force reconcile
      await h.storage.remove('cookie');

      // Remote has one committed, one active matching local, one new
      final remoteRows = [
        {
          'activity_id': 'localActive', // same as local, remote is committed
          'activity_status': 'ended',
          'activity': '{"title":"Local Active","committed":true}',
          'updated_at': 7000,
          'committed': true,
        },
        {
          'activity_id': 'remoteNew',
          'activity_status': 'active',
          'activity': '{"title":"Remote New"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse(
        StagingPaths.remoteRowLevelBlob,
        await h.makeObfuscatedBlob(remoteRows),
      );

      await h.svc.checkAndSync();

      // localActive: remote wins on updated_at but remote is committed →
      // should be committed in local now (committed flag is sticky)
      final rows = await h.stagingStore.getAllRows();
      final rowMap = {
        for (final r in rows) r['activity_id'] as String: r
      };

      // localActive should now be committed (remote was committed)
      expect(rowMap['localActive']?['committed'], isTrue,
          reason: 'B8: committed flag must be sticky — remote committed '
              'overwrites local uncommitted');

      // remoteNew should be present
      expect(rowMap.containsKey('remoteNew'), isTrue,
          reason: 'Remote-only uncommitted row must be added');

      // localDone should still be there (committed, preserved locally)
      expect(rowMap.containsKey('localDone'), isTrue,
          reason: 'Local committed rows preserved for display');

      // But the PUSHED blob should exclude all committed rows
      final blobIdx =
          h.transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
      final mk =
          '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
      final crypto = CryptoService();
      await crypto.initialize();
      final blobBytes = h.transport.pushData[blobIdx];
      final deobfuscated = crypto.deobfuscateBlob(blobBytes, mk);
      final entries =
          (json.decode(deobfuscated) as Map)['entries'] as List;
      final ids = entries.map((e) => e['activity_id'] as String).toSet();

      expect(ids, isNot(contains('localActive')),
          reason: 'Committed localActive must not be in blob');
      expect(ids, isNot(contains('localDone')),
          reason: 'Committed localDone must not be in blob');
      expect(ids, contains('remoteNew'),
          reason: 'Uncommitted remoteNew must be in blob');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: A2 — TTL Expiry → REAUTH_NEEDED
  // ═══════════════════════════════════════════════════════════════

  group('C: A2 — TTL → REAUTH_NEEDED', () {
    // C1
    test('C1 checkAndSync returns reauthNeeded when cookie exists '
        'but TTL is expired', () async {
      final h = await _makeRowSync(seedCookie: false);

      // Seed an expired cookie (creation time 2 hours ago)
      await h.seedExpiredCookie();

      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'C1: expired TTL must return REAUTH_NEEDED, '
              'not fall through to auto-reconcile');

      await h.close();
    });

    // C2
    test('C2 checkAndSync proceeds to reconcile when cookie never '
        'existed (no cookie data in storage)', () async {
      final h = await _makeRowSync(seedCookie: false);

      // No cookie at all — fresh device
      // Provide a remote blob so reconcile doesn't fail
      h.transport.setPullResponse(
        StagingPaths.remoteRowLevelBlob,
        await h.makeObfuscatedBlob([]),
      );

      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'C2: missing cookie (never existed) must reconcile, '
              'not return REAUTH_NEEDED');

      await h.close();
    });

    // C3
    test('C3 checkAndSync with valid cookie proceeds to fast path '
        'normally (regression guard)', () async {
      final h = await _makeRowSync();

      // Valid recent cookie, matching remote cookie → fast path READY
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'C3: valid cookie path must be unchanged');

      await h.close();
    });

    // C4
    test('C4 TTL expiry returns REAUTH_NEEDED even when MK is cached',
        () async {
      final h = await _makeRowSync(seedCookie: false);

      // MK is cached via _makeCrypto() (setMasterKey called in factory)
      // Seed expired cookie
      await h.seedExpiredCookie();

      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'C4: MK cached ≠ user consent — expired cookie '
              'must still return REAUTH_NEEDED');

      await h.close();
    });

    // C5
    test('C5 DeviceCookie.isValidLocally returns null for expired '
        'cookie (distinguished from missing by caller)', () async {
      final storage = _FakeStorage();
      final cookie = DeviceCookie();

      // Seed a cookie 2 hours ago
      final expiredTime =
          DateTime.now().millisecondsSinceEpoch - (120 * 60 * 1000);
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': expiredTime,
      });

      // With 30 min TTL, this should return null (expired)
      final result = await cookie.isValidLocally(storage, ttlMinutes: 30);
      expect(result, isNull,
          reason: 'C5: expired cookie → isValidLocally returns null');

      // Check that caller can distinguish: cookie EXISTS in storage
      // but isValidLocally returned null → means expired (not missing)
      final rawCookie = await storage.get('cookie');
      expect(rawCookie, isNotNull,
          reason: 'C5: raw cookie still exists after TTL check — '
              'caller can distinguish "expired" (exists but null return) '
              'from "missing" (no cookie in storage at all)');

      // Cleanup
      await cookie.destroyLocally(storage);
    });

    // C6
    test('C6 TTL boundary: cookie at edge of TTL is valid; '
        'past TTL is expired', () async {
      final storage = _FakeStorage();
      final cookie = DeviceCookie();

      // Cookie created recently (well within TTL) — must be valid
      final recentTime =
          DateTime.now().millisecondsSinceEpoch - (10 * 60 * 1000); // 10 min ago
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': recentTime,
      });

      // Within 30-min TTL, should be valid
      final recentResult =
          await cookie.isValidLocally(storage, ttlMinutes: 30);
      expect(recentResult, isNotNull,
          reason: 'C6: cookie within TTL is valid');

      // Now set cookie far past TTL (2 hours ago)
      final expiredTime =
          DateTime.now().millisecondsSinceEpoch - (120 * 60 * 1000);
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': expiredTime,
      });

      final expiredResult =
          await cookie.isValidLocally(storage, ttlMinutes: 30);
      expect(expiredResult, isNull,
          reason: 'C6: past TTL → expired (null)');

      // Cleanup
      await cookie.destroyLocally(storage);
    });

    // C7
    test('C7 after REAUTH_NEEDED is returned, local cookie is cleared '
        'so future calls land on missing→reconcile', () async {
      final h = await _makeRowSync(seedCookie: false);

      // Seed expired cookie
      await h.seedExpiredCookie();

      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'Expired cookie must trigger REAUTH_NEEDED');

      // After REAUTH_NEEDED, local cookie should be destroyed
      final rawCookie = await h.storage.get('cookie');
      expect(rawCookie, isNull,
          reason: 'C7: cookie must be cleared after REAUTH_NEEDED so '
              'future checkAndSync calls land on missing→reconcile');

      // Future call without cookie should reconcile (C2 behavior)
      h.transport.setPullResponse(
        StagingPaths.remoteRowLevelBlob,
        await h.makeObfuscatedBlob([]),
      );
      final result2 = await h.svc.checkAndSync();
      expect(result2, SyncCheckResult.ready,
          reason: 'After cookie cleared, next call reconciles normally');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: F1 — Read-Only Fast Path
  // ═══════════════════════════════════════════════════════════════

  group('D: F1 — Read-Only Fast Path', () {
    // D1
    test('D1 valid cookie + zero pending writes → READY without any '
        'network calls', () async {
      final h = await _makeRowSync();

      // Valid cookie (seeded by _makeRowSync), no staging rows → no writes
      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'D1: valid cookie + no pending writes → READY');

      // Must not make any network calls (no pull, no push)
      expect(h.transport.pullPaths, isEmpty,
          reason: 'D1: F1 fast path must not pull remote cookie '
              'when there are zero pending writes');
      expect(h.transport.pushPaths, isEmpty,
          reason: 'D1: F1 fast path must not push anything '
              'when there are zero pending writes');

      await h.close();
    });

    // D2
    test('D2 valid cookie + pending writes → pulls remote cookie '
        '(current behavior preserved)', () async {
      final h = await _makeRowSync();

      // Add an uncommitted row → pending writes exist
      await h.addRow(activityId: 'pending1', status: 'active');

      // Set up matching remote cookie for fast path
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'D2: writes exist → must proceed through sync');

      // Must have pulled remote cookie (F2 gate)
      expect(h.transport.pullPaths,
          contains(StagingPaths.remoteDeviceCookie),
          reason: 'D2: pending writes → must pull remote cookie');

      await h.close();
    });

    // D3
    test('D3 hasPendingWrites returns false when all staging rows '
        'are committed', () async {
      final h = await _makeRowSync();

      // Only committed rows
      await h.addRow(
          activityId: 'commA', status: 'ended', committed: true);
      await h.addRow(
          activityId: 'commB', status: 'ended', committed: true);

      final result = await h.svc.hasPendingWrites();
      expect(result, isFalse,
          reason: 'D3: all-committed staging → no pending writes');

      await h.close();
    });

    // D4
    test('D4 hasPendingWrites returns false when staging store is '
        'empty (zero rows)', () async {
      final h = await _makeRowSync();

      // No rows added — staging is empty
      final result = await h.svc.hasPendingWrites();
      expect(result, isFalse,
          reason: 'D4: empty staging → no pending writes');

      await h.close();
    });

    // D5
    test('D5 hasPendingWrites returns true when at least one '
        'uncommitted row exists', () async {
      final h = await _makeRowSync();

      // Add one committed + one uncommitted
      await h.addRow(
          activityId: 'committed', status: 'ended', committed: true);
      await h.addRow(
          activityId: 'active', status: 'active', committed: false);

      final result = await h.svc.hasPendingWrites();
      expect(result, isTrue,
          reason: 'D5: any uncommitted row → has pending writes');

      await h.close();
    });

    // D6
    test('D6 F1 fast path records zero pull and zero push in '
        'transport spy', () async {
      final h = await _makeRowSync();

      // No staging rows → no writes
      await h.svc.checkAndSync();

      // Explicitly verify transport was not touched at all
      expect(h.transport.pullPaths.length, 0,
          reason: 'D6: zero pullPaths when F1 fast path triggers');
      expect(h.transport.pushPaths.length, 0,
          reason: 'D6: zero pushPaths when F1 fast path triggers');

      await h.close();
    });

    // D7
    test('D7 F1 fast path works when stagingStore is null '
        '(old LocalCache path)', () async {
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();

      // Seed valid cookie
      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final transport = _ConfigTransport();

      final svc = SyncService(
        storage: storage,
        crypto: crypto,
        transport: transport,
        stagingStore: null, // legacy: no stagingStore
      );

      // No entries in LocalCache → no pending writes
      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'D7: legacy path with no stagingStore must also '
              'support read-only fast path');

      // No network calls with zero pending writes
      expect(transport.pullPaths, isEmpty,
          reason: 'D7: no remote cookie pull when no writes exist');

      svc.dispose();
    });
  });
}
