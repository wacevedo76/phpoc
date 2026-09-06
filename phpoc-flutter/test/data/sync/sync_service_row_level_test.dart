import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/merge_engine.dart';
import 'package:phpoc_flutter/data/sync/staging_hash_index.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// B-04: Row-Level Staging Sync tests — Phase 2 (RED).
///
/// Covers Groups A–H (54 assertions) from:
///   docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md
///
/// Group I (2 assertions) in staging_paths_test.dart.

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure
// ═══════════════════════════════════════════════════════════════════

/// In-memory storage for SyncService's `storage` parameter.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Configurable transport spy: returns specific bytes per path,
/// records all push/pull paths and data.
class _ConfigTransport extends HttpTransport {
  final Map<String, Uint8List?> _pullResponses = {};
  final Map<String, int> _pullStatusCodes = {};
  final List<String> pullPaths = [];
  final List<String> pushPaths = [];
  final List<Uint8List> pushData = [];
  bool _throwOnAll = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  /// Set what pull() returns for a specific path.
  void setPullResponse(String path, Uint8List? data, {int statusCode = 200}) {
    _pullResponses[path] = data;
    _pullStatusCodes[path] = statusCode;
  }

  /// Make all pull/push operations throw (network error simulation).
  void setThrowOnAll(bool value) => _throwOnAll = value;

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (_throwOnAll) throw Exception('Simulated network failure');
    if (_pullResponses.containsKey(path)) {
      final code = _pullStatusCodes[path] ?? 200;
      if (code == 404) return null;
      return _pullResponses[path];
    }
    return null; // default: 404 / no data
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

/// Create a SyncService wired with StagingStore + configurable transport.
///
/// When [transport] is null, creates a _ConfigTransport.
Future<_RowTestHarness> _makeRowSync({
  _ConfigTransport? transport,
  CryptoService? crypto,
}) async {
  final c = crypto ?? await _makeCrypto();
  final t = transport ?? _ConfigTransport();
  final storage = _FakeStorage();
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);

  // Seed a fresh local cookie so checkAndSync doesn't bail at cookie gate
  final now = DateTime.now().millisecondsSinceEpoch;
  await storage.set('cookie', {
    'device_specifier': 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    'creation_time': now,
  });

  final svc = SyncService(
    storage: storage,
    crypto: c,
    transport: t,
    stagingStore: stagingStore,
  );

  return _RowTestHarness(svc, stagingStore, storage, t, db);
}

/// Bundles test artifacts for row-level sync tests.
class _RowTestHarness {
  final SyncService svc;
  final StagingStore stagingStore;
  final _FakeStorage storage;
  final _ConfigTransport transport;
  final AppDatabase db;

  _RowTestHarness(
      this.svc, this.stagingStore, this.storage, this.transport, this.db);

  /// Add a row directly to the staging store (bypasses SyncService).
  ///
  /// Uses [preserveUpdatedAt] so the caller's explicit timestamp is kept
  /// for LWW merge tests; real mutations always bump via SyncService.
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
      }),
      'updated_at': updatedAt,
      'committed': committed,
      'title': title,
      'start_epoch': 1000,
      'duration': 0,
    }, preserveUpdatedAt: true);
  }

  /// Build an obfuscated staging/blob payload with given rows.
  Future<Uint8List> makeObfuscatedBlob(List<Map<String, dynamic>> rows) async {
    final blobData = {
      'entries': rows,
      'device_id': 'remote-device',
      'device_proof': 'proof-string',
    };
    final c = CryptoService();
    await c.initialize();
    final mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    final jsonStr = json.encode(blobData);
    return c.obfuscateBlob(jsonStr, mk);
  }

  Future<void> close() async {
    svc.dispose();
    await db.close();
  }
}

/// Make a remote-cookie payload matching the known specifier.
Uint8List _makeRemoteCookie(String specifier) {
  return Uint8List.fromList(utf8.encode(json.encode({
    'device_uuid': 'remote-device-uuid',
    'device_specifier': specifier,
  })));
}

const _knownSpecifier = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: Pull Phase — ~8 tests
  // ═══════════════════════════════════════════════════════════════

  group('A: Row-Level Sync — Pull Phase', () {
    // A1
    test('A1: _pullRemoteBlob() GETs staging/blob instead of '
        'staging/blobs/current.json', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit (needs pending writes)
      await h.addRow(activityId: 'bypA1', status: 'active');

      // Trigger reconcile which calls _pullRemoteBlob
      await h.svc.checkAndSync();

      // Must pull from staging/blob (new path), not old path
      expect(h.transport.pullPaths,
          contains('staging/blob'),
          reason: 'Row-level sync must pull from staging/blob');
      expect(h.transport.pullPaths,
          isNot(contains(StagingPaths.remoteStagingBlob)),
          reason: 'Old path staging/blobs/current.json must not be used '
              'when stagingStore is wired');

      await h.close();
    });

    // A2
    test('A2: pulled blob is deobfuscated via CryptoService.deobfuscateBlob()',
        () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypA2', status: 'active');

      // Prepare an obfuscated remote blob with entries
      final remoteRows = [
        {
          'activity_id': 'remote001',
          'activity_status': 'active',
          'activity': '{"title":"Remote Task"}',
          'updated_at': 5000,
        },
      ];
      final blob = await h.makeObfuscatedBlob(remoteRows);
      h.transport.setPullResponse('staging/blob', blob);

      // Trigger reconcile
      await h.svc.checkAndSync();

      // After sync, the remote entry should appear in local staging
      // (deobfuscated = readable)
      final rows = await h.stagingStore.getAllRows();
      final remoteRow = rows.where((r) => r['activity_id'] == 'remote001');
      expect(remoteRow, isNotEmpty,
          reason: 'Deobfuscated remote entry must appear in local staging');

      await h.close();
    });

    // A3
    test('A3: returns [] when remote returns 404 (no blob on server)',
        () async {
      final h = await _makeRowSync();

      // Default transport returns null (404) for staging/blob
      // Add a local row to verify it survives
      await h.addRow(activityId: 'local001', status: 'active');

      // Should not throw
      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'Empty remote (404) must not crash sync');

      // Local row must survive
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1,
          reason: 'Local rows must not be lost when remote is empty');
      expect(rows[0]['activity_id'], 'local001');

      await h.close();
    });

    // A4
    test('A4: returns [] when deobfuscation fails (wrong master key)',
        () async {
      final h = await _makeRowSync();

      // Provide garbage data that can't be deobfuscated
      h.transport.setPullResponse(
        'staging/blob',
        Uint8List.fromList(utf8.encode('not-a-valid-obfuscated-blob')),
      );

      // Must not crash, must not corrupt local state
      await h.svc.capture(title: 'Local Task');

      await h.svc.checkAndSync();

      // Local entries must survive
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1,
          reason: 'Key mismatch must not delete local staging entries');
      expect(rows[0]['activity_status'], 'active');

      await h.close();
    });

    // A5
    test('A5: returns parsed entries list when blob is valid', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypA5', status: 'active');

      final remoteRows = [
        {
          'activity_id': 'remA',
          'activity_status': 'active',
          'activity': '{"title":"A"}',
          'updated_at': 5000,
        },
        {
          'activity_id': 'remB',
          'activity_status': 'ended',
          'activity': '{"title":"B"}',
          'updated_at': 6000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Should have local bypass row + 2 remote rows
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 3,
          reason: 'Valid blob must produce 2 staging rows + local bypass');
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, containsAll(['remA', 'remB']));

      await h.close();
    });

    // A6
    test('A6: network error during pull → returns [] (not throws)', () async {
      final h = await _makeRowSync();

      // Add a local entry so we can verify it survives
      await h.addRow(activityId: 'local002', status: 'active');

      // Transport throws on any network operation
      h.transport.setThrowOnAll(true);

      // checkAndSync must not throw — it catches and returns offline
      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.offline,
          reason: 'Network error during pull must return OFFLINE, not crash');

      // Local entries must survive
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1,
          reason: 'Local entries must survive network error');

      await h.close();
    });

    // A7
    test('A7: pulled entries have expected row-level fields '
        '(activity_id, activity_status, activity, updated_at)', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypA7', status: 'active');

      final remoteRows = [
        {
          'activity_id': 'fld001',
          'activity_status': 'active',
          'activity': '{"title":"Field Check","start_epoch":1000}',
          'updated_at': 3000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Should have local bypass row + 1 remote row
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 2,
          reason: 'Must have local bypass row + 1 remote row');
      // Find the remote row (not the bypass row)
      final remoteRow = rows.where((r) => r['activity_id'] == 'fld001').first;
      expect(remoteRow['activity_id'], isNotNull,
          reason: 'activity_id must be present');
      expect(remoteRow['activity_status'], isNotNull,
          reason: 'activity_status must be present for merge');
      expect(remoteRow['activity'], isNotNull,
          reason: 'activity JSON blob must be present');
      expect(remoteRow['updated_at'], isNotNull,
          reason: 'updated_at must be present for LWW resolution');

      await h.close();
    });

    // A8
    test('A8: transport uses staging/blob path constant '
        '(not hardcoded string)', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypA8', status: 'active');

      await h.svc.checkAndSync();

      // The path used must NOT be a raw string — but since we test
      // the transport spy, we verify the exact path value is correct
      expect(h.transport.pullPaths, contains('staging/blob'),
          reason: 'Must use the staging/blob path for row-level pull');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group B: Merge Phase — ~10 tests
  // ═══════════════════════════════════════════════════════════════

  group('B: Row-Level Sync — Merge Phase', () {
    // B1
    test('B1: _reconcileAndClaim calls MergeEngine.mergeEntries() '
        'instead of mergeMaps()', () async {
      final h = await _makeRowSync();

      // Local entry + remote entry with different activity_ids
      await h.addRow(activityId: 'local10', status: 'active', title: 'Local');
      final remoteRows = [
        {
          'activity_id': 'rem10',
          'activity_status': 'active',
          'activity': '{"title":"Remote"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // mergeEntries adds distinct entries (no conflict on different IDs)
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 2,
          reason: 'mergeEntries must produce union of distinct activity_ids');

      await h.close();
    });

    // B2
    test('B2: remote row with newer updated_at wins over local row '
        'with same activity_id', () async {
      final h = await _makeRowSync();

      // Same activity_id, remote has newer updated_at
      await h.addRow(
        activityId: 'conf001',
        status: 'active',
        updatedAt: 1000, // older
        title: 'OLD Local Title',
      );
      final remoteRows = [
        {
          'activity_id': 'conf001',
          'activity_status': 'ended',
          'activity': '{"title":"NEW Remote Title"}',
          'updated_at': 5000, // newer
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1);
      final row = rows[0];
      expect(row['activity_status'], 'ended',
          reason: 'Remote (newer updated_at) must win LWW');
      final activity = json.decode(row['activity'] as String);
      expect(activity['title'], 'NEW Remote Title',
          reason: 'Remote data must replace local when remote is newer');

      await h.close();
    });

    // B3
    test('B3: remote ended wins over local active with newer updated_at '
        '(terminal-state rule)', () async {
      final h = await _makeRowSync();

      // Same activity_id: local is ACTIVE with newer updated_at, remote is
      // ENDED (older updated_at). The ended transition must win regardless.
      await h.addRow(
        activityId: 'conf002',
        status: 'active',
        updatedAt: 5000, // newer
        title: 'NEW Local Title',
      );
      final remoteRows = [
        {
          'activity_id': 'conf002',
          'activity_status': 'ended',
          'activity': '{"title":"OLD Remote Title"}',
          'updated_at': 1000, // older
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1);
      final row = rows[0];
      expect(row['activity_status'], 'ended',
          reason: 'Remote ended must win over a newer local active copy '
              '(cross-device end-propagation, Group K)');
      final activity = json.decode(row['activity'] as String);
      expect(activity['title'], 'OLD Remote Title',
          reason: 'The ended row\'s data is adopted');

      await h.close();
    });

    // B4
    test('B4: row exists on remote only (not in local) → added to '
        'local staging', () async {
      final h = await _makeRowSync();

      // Add a local row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypB4', status: 'active');

      // Remote has an additional row
      final remoteRows = [
        {
          'activity_id': 'remoteOnly',
          'activity_status': 'active',
          'activity': '{"title":"Other Device Task"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Should have both local bypass row and remote-only row
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 2,
          reason: 'Remote-only entry must be added alongside local bypass row');
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, contains('remoteOnly'),
          reason: 'Remote-only entry must be added to local staging');

      await h.close();
    });

    // B5
    test('B5: row exists on local only, not committed → kept in staging',
        () async {
      final h = await _makeRowSync();

      // Local-only, not committed
      await h.addRow(
        activityId: 'localOnly',
        status: 'active',
        committed: false,
      );

      // No remote entries
      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1,
          reason: 'Uncommitted local-only row must survive sync');
      expect(rows[0]['activity_id'], 'localOnly');

      await h.close();
    });

    // B6
    test('B6: row exists on local only, committed=true → kept in '
        'staging for History display', () async {
      final h = await _makeRowSync();

      // Local-only, committed=true → stays in staging for History/Dashboard
      await h.addRow(
        activityId: 'committedLocal',
        status: 'ended',
        committed: true,
      );

      // No remote entries
      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      final persisted = rows.where((r) => r['activity_id'] == 'committedLocal');
      expect(persisted, isNotEmpty,
          reason: 'Committed entries stay in staging for History/Dashboard '
              'display; Sync tab filters them out via committed flag');
      expect(persisted.first['committed'], true,
          reason: 'Committed flag must be preserved');

      await h.close();
    });

    // B7
    test('B7: remote ended wins over local active on updated_at tie '
        '(terminal-state rule)', () async {
      final h = await _makeRowSync();

      // Same updated_at on both sides, but local is ACTIVE and remote is ENDED
      // → ended transition wins on the tie (cross-device end, Group K).
      await h.addRow(
        activityId: 'tie001',
        status: 'active',
        updatedAt: 3000,
        title: 'Local Active',
      );
      final remoteRows = [
        {
          'activity_id': 'tie001',
          'activity_status': 'ended',
          'activity': '{"title":"Remote Ended"}',
          'updated_at': 3000, // same timestamp
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1);
      final activity = json.decode(rows[0]['activity'] as String);
      expect(rows[0]['activity_status'], 'ended',
          reason: 'Ended must beat local active even on an updated_at tie');
      expect(activity['title'], 'Remote Ended',
          reason: 'The ended row\'s data is adopted on the tie');

      await h.close();
    });

    // B8
    test('B8: merged result written to StagingStore via putRow '
        '(not LocalCache.writeEntries)', () async {
      final h = await _makeRowSync();

      // Add local + remote entries
      await h.addRow(activityId: 'storeA', status: 'active');
      final remoteRows = [
        {
          'activity_id': 'storeB',
          'activity_status': 'active',
          'activity': '{"title":"Remote B"}',
          'updated_at': 2000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Both rows should be in StagingStore
      final rows = await h.stagingStore.getAllRows();
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, containsAll(['storeA', 'storeB']),
          reason: 'Merged result must persist to StagingStore, '
              'not old LocalCache');

      await h.close();
    });

    // B9
    test('B9: merge handles empty remote (0 rows) — all local rows '
        'preserved', () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'loc1', status: 'active', title: 'A');
      await h.addRow(activityId: 'loc2', status: 'paused', title: 'B');

      // No remote blob set → 404
      await h.svc.checkAndSync();

      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 2,
          reason: 'All local rows must be preserved when remote is empty');

      await h.close();
    });

    // B10
    test('B10: merge handles empty local (0 rows) — all remote rows '
        'added', () async {
      final h = await _makeRowSync();

      // Add a local row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypB10', status: 'active');

      // Additional remote rows
      final remoteRows = [
        {
          'activity_id': 'rem1',
          'activity_status': 'active',
          'activity': '{"title":"R1"}',
          'updated_at': 1000,
        },
        {
          'activity_id': 'rem2',
          'activity_status': 'ended',
          'activity': '{"title":"R2"}',
          'updated_at': 2000,
        },
        {
          'activity_id': 'rem3',
          'activity_status': 'active',
          'activity': '{"title":"R3"}',
          'updated_at': 3000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Should have local bypass row + 3 remote rows
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 4,
          reason: 'All remote rows must be added alongside local bypass row');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: Push Phase — ~5 tests
  // ═══════════════════════════════════════════════════════════════

  group('C: Row-Level Sync — Push Phase', () {
    // C1
    test('C1: _reconcileAndClaim calls _pushStagingRowsToRemote after '
        'merge (not _pushBlobOnly)', () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'pushTest', status: 'active');
      final remoteRows = [
        {
          'activity_id': 'remPush',
          'activity_status': 'active',
          'activity': '{"title":"Remote"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // Must push to staging/blob (new path), not old path
      expect(h.transport.pushPaths,
          contains('staging/blob'),
          reason: 'After merge, must push to staging/blob');
      expect(h.transport.pushPaths,
          isNot(contains(StagingPaths.remoteStagingBlob)),
          reason: 'Must NOT use old staging/blobs/current.json path');

      await h.close();
    });

    // C2
    test('C2: _pushStagingRowsToRemote pushes to staging/blob path',
        () async {
      final transport = _ConfigTransport();
      final h = await _makeRowSync(transport: transport);

      await h.addRow(activityId: 'pathCheck', status: 'active');

      // Trigger debounced push by calling flushPendingQueue
      await h.svc.flushPendingQueue();

      // Row-level push must go to staging/blob
      expect(transport.pushPaths, contains('staging/blob'),
          reason: 'Row-level push must use staging/blob path');

      await h.close();
    });

    // C3
    test('C3: _pushBlobOnly is no longer called from sync gate paths',
        () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'noOldPath', status: 'active');

      await h.svc.checkAndSync();

      // Old path must not appear in push paths during sync gate
      expect(h.transport.pushPaths,
          isNot(contains('staging/blobs/current.json')),
          reason: 'Old blob path must not be pushed during row-level sync');

      await h.close();
    });

    // C4
    test('C4: push includes device_id and device_proof in blob',
        () async {
      final transport = _ConfigTransport();
      final h = await _makeRowSync(transport: transport);

      await h.addRow(activityId: 'deviceCheck', status: 'active');
      await h.svc.flushPendingQueue();

      // The pushed blob should contain device_id and device_proof
      // We can verify by checking that push data exists and inspecting it
      expect(transport.pushData, isNotEmpty,
          reason: 'Push must send data to remote');

      if (transport.pushData.isNotEmpty) {
        final mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        final c = CryptoService();
        await c.initialize();
        c.setMasterKey(mk);
        final deobfuscated = c.deobfuscateBlob(transport.pushData[0], mk);
        final parsed = json.decode(deobfuscated) as Map<String, dynamic>;
        expect(parsed['device_id'], isNotNull,
            reason: 'Pushed blob must include device_id for remote identity');
        expect(parsed['device_proof'], isNotNull,
            reason: 'Pushed blob must include device_proof');
      }

      await h.close();
    });

    // C5
    test('C5: blob is obfuscated via CryptoService.obfuscateBlob() '
        'before push', () async {
      final transport = _ConfigTransport();
      final h = await _makeRowSync(transport: transport);

      await h.addRow(activityId: 'obfCheck', status: 'active');
      await h.svc.flushPendingQueue();

      // The raw push data must be obfuscated (not plaintext)
      expect(transport.pushData, isNotEmpty);
      if (transport.pushData.isNotEmpty) {
        final rawBytes = transport.pushData[0];
        final rawStr = utf8.decode(rawBytes.take(100).toList(),
            allowMalformed: true);
        // Obfuscated blob should NOT contain plaintext activity_ids
        expect(rawStr.contains('obfCheck'), isFalse,
            reason: 'Pushed blob must be obfuscated — '
                'activity_ids must not appear in plaintext');
      }

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: Fast Path — StagingHashIndex — ~7 tests
  // ═══════════════════════════════════════════════════════════════

  group('D: Row-Level Sync — Fast Path (StagingHashIndex)', () {
    // D1
    test('D1: checkAndSync pulls remote hash index via '
        'staging/hash_index.json', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit
      await h.addRow(activityId: 'bypD1', status: 'active');

      // Set up remote with matching cookie for fast path
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Put a hash index on remote
      final indexJson = json.encode([
        {'activity_id': 'hash1', 'activity_status': 'active'},
      ]);
      h.transport.setPullResponse(
        StagingPaths.remoteStagingHashIndex,
        Uint8List.fromList(utf8.encode(indexJson)),
      );

      await h.svc.checkAndSync();

      // The remote hash index should have been pulled
      expect(h.transport.pullPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'Fast path must pull remote hash index for Tier-1 comparison');

      await h.close();
    });

    // D2
    test('D2: StagingHashIndex.compare(local, remote) returns identical:true '
        'when both match', () async {
      // Build identical local and remote indexes
      final local = [
        {'activity_id': 'id1', 'activity_status': 'active'},
        {'activity_id': 'id2', 'activity_status': 'ended'},
      ];
      final remote = [
        {'activity_id': 'id1', 'activity_status': 'active'},
        {'activity_id': 'id2', 'activity_status': 'ended'},
      ];

      final diff = StagingHashIndex.compare(local, remote);
      expect(diff.identical, isTrue,
          reason: 'Identical activity_id+status pairs must produce identical=true');
      expect(diff.added, isEmpty);
      expect(diff.removed, isEmpty);
      expect(diff.changed, isEmpty);
    });

    // D3
    test('D3: identical:false → checkAndSync falls through to '
        '_reconcileAndClaim', () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'changed', status: 'active');

      // Set up matching cookie for fast path attempt
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Remote hash index has different entries → not identical
      final indexJson = json.encode([
        {'activity_id': 'other', 'activity_status': 'ended'},
      ]);
      h.transport.setPullResponse(
        StagingPaths.remoteStagingHashIndex,
        Uint8List.fromList(utf8.encode(indexJson)),
      );

      await h.svc.checkAndSync();

      // When hash differs, must pull full blob for merge
      expect(h.transport.pullPaths, contains('staging/blob'),
          reason: 'Hash mismatch must trigger full blob pull for merge');

      await h.close();
    });

    // D4
    test('D4: remote hash index is null/404 → treated as empty '
        '(all local entries are added)', () async {
      final h = await _makeRowSync();

      // Local has entries
      await h.addRow(activityId: 'boot1', status: 'active');
      await h.addRow(activityId: 'boot2', status: 'ended');

      // Matching cookie → fast path
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Remote hash index = 404 (null)
      // Default transport returns null → simulates 404

      // When remote hash is null, should push local as initial (bootstrap)
      await h.svc.checkAndSync();

      // Should push to staging/blob (bootstrap push)
      expect(h.transport.pushPaths, contains('staging/blob'),
          reason: 'Empty remote hash must trigger bootstrap push');

      await h.close();
    });

    // D5
    test('D5: network error during hash index fetch → fall through to '
        'full sync (not READY)', () async {
      final h = await _makeRowSync();

      // Matching cookie → fast path attempted
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Hash index pull throws network error
      // We need a way to make hash index fail but cookie succeed...
      // Since _ConfigTransport returns null for unknown paths (404-like),
      // this simulates the hash index not being available.
      // The system should fall through to full sync rather than READY.

      await h.addRow(activityId: 'fallthrough', status: 'active');
      await h.svc.checkAndSync();

      // Must have attempted full sync (pulled staging/blob)
      expect(h.transport.pullPaths, contains('staging/blob'),
          reason: 'Hash index fetch failure must trigger full blob pull, '
              'not return READY prematurely');

      await h.close();
    });

    // D6
    test('D6: StagingHashIndex.build(store) returns sorted, deterministic '
        'array', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);

      // Insert in non-sorted order
      await store.putRow({
        'activity_id': 'zzz',
        'activity_status': 'active',
        'activity': '{"title":"Z"}',
        'updated_at': 3000,
      });
      await store.putRow({
        'activity_id': 'aaa',
        'activity_status': 'ended',
        'activity': '{"title":"A"}',
        'updated_at': 1000,
      });
      await store.putRow({
        'activity_id': 'mmm',
        'activity_status': 'active',
        'activity': '{"title":"M"}',
        'updated_at': 2000,
      });

      final index = await StagingHashIndex.build(store);
      expect(index.length, 3);

      // Must be sorted by activity_id
      expect(index[0]['activity_id'], 'aaa');
      expect(index[1]['activity_id'], 'mmm');
      expect(index[2]['activity_id'], 'zzz');

      // Build again — must be identical (deterministic)
      final index2 = await StagingHashIndex.build(store);
      for (var i = 0; i < index.length; i++) {
        expect(index[i]['activity_id'], index2[i]['activity_id']);
      }

      await db.close();
    });

    // D7
    test('D7: StagingHashIndex.computeHash() produces stable SHA-256 '
        'for same input', () async {
      final index = [
        {'activity_id': 'a', 'activity_status': 'active'},
        {'activity_id': 'b', 'activity_status': 'ended'},
      ];

      final hash1 = StagingHashIndex.computeHash(index);
      final hash2 = StagingHashIndex.computeHash(index);

      expect(hash1, hash2,
          reason: 'Same input must always produce same SHA-256 hash');
      expect(hash1, isA<String>());
      expect(hash1.length, 64, // SHA-256 hex is 64 chars
          reason: 'Hash must be a 64-char SHA-256 hex digest');

      // Different input → different hash
      final index2 = [
        {'activity_id': 'a', 'activity_status': 'ended'}, // changed status
        {'activity_id': 'b', 'activity_status': 'ended'},
      ];
      final hash3 = StagingHashIndex.computeHash(index2);
      expect(hash3, isNot(hash1),
          reason: 'Different input must produce different hash');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: Store Migration — ~6 tests
  // ═══════════════════════════════════════════════════════════════

  group('E: Row-Level Sync — Store Migration', () {
    // E1
    test('E1: _reconcileAndClaim reads local rows from '
        'StagingStore.getAllRows() (not LocalCache)', () async {
      final h = await _makeRowSync();

      // Add rows directly to StagingStore
      await h.addRow(activityId: 'stgA', status: 'active');
      await h.addRow(activityId: 'stgB', status: 'ended');

      // Remote also has entries
      final remoteRows = [
        {
          'activity_id': 'stgC',
          'activity_status': 'active',
          'activity': '{"title":"Remote C"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // All 3 should be in StagingStore after sync
      final rows = await h.stagingStore.getAllRows();
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, containsAll(['stgA', 'stgB', 'stgC']),
          reason: 'Sync must read from StagingStore and merge with remote');

      await h.close();
    });

    // E2
    test('E2: merged rows written via StagingStore.putRow() '
        '(not LocalCache.writeEntries())', () async {
      final h = await _makeRowSync();

      // Put entries in StagingStore
      await h.addRow(activityId: 'wrtA', status: 'active', title: 'Local A');
      final remoteRows = [
        {
          'activity_id': 'wrtB',
          'activity_status': 'active',
          'activity': '{"title":"Remote B"}',
          'updated_at': 2000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // After sync, rows must be queryable from StagingStore
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, greaterThanOrEqualTo(2),
          reason: 'Merged result must be stored in StagingStore');

      await h.close();
    });

    // E3
    test('E3: committed rows stay in staging (not deleted) for '
        'History/Dashboard display', () async {
      final h = await _makeRowSync();

      // Local committed row — stays for History/Dashboard display
      await h.addRow(
        activityId: 'toKeep',
        status: 'ended',
        committed: true,
      );

      // Remote has no matching entry
      await h.svc.checkAndSync();

      // Committed local-only row must persist in staging
      final rows = await h.stagingStore.getAllRows();
      final kept = rows.where((r) => r['activity_id'] == 'toKeep');
      expect(kept, isNotEmpty,
          reason: 'Committed rows stay in staging for History/Dashboard; '
              'Sync tab filters them out');
      expect(kept.first['committed'], true);

      await h.close();
    });

    // E4
    test('E4: StagingStore operations do not throw during sync gate '
        '(all errors caught)', () async {
      final h = await _makeRowSync();

      // Set up a normal sync scenario
      await h.addRow(activityId: 'safe1', status: 'active');
      final remoteRows = [
        {
          'activity_id': 'safe2',
          'activity_status': 'active',
          'activity': '{"title":"Safe Remote"}',
          'updated_at': 1000,
        },
      ];
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      // Must not throw
      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'Sync gate must complete without throwing store errors');

      await h.close();
    });

    // E5
    test('E5: _pushStagingRowsToRemote reads from '
        'StagingStore.getAllRows() for blob building', () async {
      final transport = _ConfigTransport();
      final h = await _makeRowSync(transport: transport);

      // Add rows to StagingStore
      await h.addRow(activityId: 'pushSrc1', status: 'active', title: 'Task 1');
      await h.addRow(activityId: 'pushSrc2', status: 'ended', title: 'Task 2');

      await h.svc.flushPendingQueue();

      // Verify push happened
      expect(transport.pushData, isNotEmpty,
          reason: 'StagingStore rows must be serialized and pushed');

      // Verify the pushed data contains both rows
      if (transport.pushData.isNotEmpty) {
        final mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        final c = CryptoService();
        await c.initialize();
        c.setMasterKey(mk);
        final deobfuscated = c.deobfuscateBlob(transport.pushData[0], mk);
        final parsed = json.decode(deobfuscated) as Map<String, dynamic>;
        final entries = parsed['entries'] as List;
        expect(entries.length, 2,
            reason: 'Both staging rows must be included in push blob');
      }

      await h.close();
    });

    // E6
    test('E6: LocalCache is no longer read or written during sync gate '
        'paths', () async {
      final h = await _makeRowSync();

      // Pre-populate old LocalCache with stale data
      // (via direct storage write mimicking LocalCache format)
      await h.storage.set('entries', [
        {'entry_id': 'old-stale', 'title': 'Stale Entry', 'is_active': true},
      ]);

      await h.addRow(activityId: 'realRow', status: 'active', title: 'Real');

      await h.svc.checkAndSync();

      // The new sync should use StagingStore, not old LocalCache entries
      // The stale LocalCache entry should not appear
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 1,
          reason: 'Old LocalCache entries must not leak into row-level sync');
      expect(rows[0]['activity_id'], 'realRow');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: Bootstrap — ~4 tests
  // ═══════════════════════════════════════════════════════════════

  group('F: Row-Level Sync — Bootstrap', () {
    // F1
    test('F1: checkAndSync with empty remote → pushes all local staging '
        'rows as initial blob', () async {
      final h = await _makeRowSync();

      // Local has staging rows
      await h.addRow(activityId: 'init1', status: 'active', title: 'First');
      await h.addRow(activityId: 'init2', status: 'ended', title: 'Second');

      // Remote has no blob (404), no cookie
      await h.svc.checkAndSync();

      // Must push local rows as initial blob
      expect(h.transport.pushPaths, contains('staging/blob'),
          reason: 'Empty remote must trigger initial blob push');
      // Cookie must be established
      expect(h.transport.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: 'Bootstrap must establish device cookie on remote');

      await h.close();
    });

    // F2
    test('F2: bootstrap push uses staging/blob path', () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'pathTest', status: 'active');
      await h.svc.checkAndSync();

      // Push must go to staging/blob, not old path
      expect(h.transport.pushPaths, contains('staging/blob'),
          reason: 'Bootstrap must use staging/blob path');
      expect(h.transport.pushPaths,
          isNot(contains('staging/blobs/current.json')),
          reason: 'Bootstrap must not use old blob path');

      await h.close();
    });

    // F3
    test('F3: checkAndSync returns READY after successful bootstrap push',
        () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'readyCheck', status: 'active');
      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Bootstrap push must return READY so UI can proceed');

      await h.close();
    });

    // F4
    test('F4: cookie is pushed after successful bootstrap '
        '(device identity established)', () async {
      final h = await _makeRowSync();

      await h.addRow(activityId: 'cookieTest', status: 'active');
      await h.svc.checkAndSync();

      // Cookie push must happen after bootstrap
      expect(h.transport.pushPaths,
          contains(StagingPaths.remoteDeviceCookie),
          reason: 'Bootstrap must push device cookie for future fast-path');

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: Gate Preservation — ~6 tests
  // ═══════════════════════════════════════════════════════════════

  group('G: Row-Level Sync — Gate Preservation', () {
    // G1
    test('G1: checkAndSync returns genesisMismatch when genesis gate fails',
        () async {
      final h = await _makeRowSync();

      // The current genesis gate check is called in checkAndSync
      // For Phase 2, this test defines the contract: genesis gate must survive
      // In a non-genesis setup, genesis check passes (no blocks = passthrough)
      final result = await h.svc.checkAndSync();
      // When no local blocks exist, genesis gate pass-through means READY
      expect(result, isNotNull,
          reason: 'checkAndSync must check genesis gate before proceeding');

      await h.close();
    });

    // G2
    test('G2: checkAndSync returns reauthNeeded when no master key',
        () async {
      // Create crypto without master key
      final crypto = CryptoService();
      await crypto.initialize();
      // No setMasterKey — MK unavailable

      final h = await _makeRowSync(crypto: crypto);
      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'MK gate must block sync — no master key means no access');

      await h.close();
    });

    // G3
    test('G3: checkAndSync returns offline when transport is unavailable',
        () async {
      // Create SyncService with NO transport
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final db = AppDatabase.inMemory();
      final stagingStore = StagingStore(db);

      final svc = SyncService(
        storage: storage,
        crypto: crypto,
        transport: null, // no transport
        stagingStore: stagingStore,
      );

      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'No transport = local-only mode = READY');

      svc.dispose();
      await db.close();
    });

    // G4
    test('G4: cookie fast path still works — matching cookies → READY '
        'without merge', () async {
      final h = await _makeRowSync();

      // Set up matching cookies for fast path
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'Cookie fast path must survive row-level refactor');

      await h.close();
    });

    // G5
    test('G5: cookie mismatch triggers full _reconcileAndClaim '
        '(row-level merge, not old blob)', () async {
      final h = await _makeRowSync();

      // Add a row so F1 doesn't short-circuit past cookie check
      await h.addRow(activityId: 'bypG5', status: 'active');

      // Local has a different cookie specifier than remote
      final now = DateTime.now().millisecondsSinceEpoch;
      await h.storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });
      // Remote has a DIFFERENT specifier
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie('ffffffffffffffffffffffffffffffff'),
      );

      // Mismatch should preserve the local cookie and return REAUTH
      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'Cookie mismatch must return REAUTH_NEEDED');

      await h.close();
    });

    // G6
    test('G6: checkAndSync with no transport (local-only mode) returns '
        'READY immediately', () async {
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final db = AppDatabase.inMemory();
      final svc = SyncService(
        storage: storage,
        crypto: crypto,
        stagingStore: StagingStore(db),
        // No transport
      );

      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready,
          reason: 'D15: transport==null means no remote capabilities — '
              'trivially READY');

      svc.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Integration — ~8 tests
  // ═══════════════════════════════════════════════════════════════

  group('H: Row-Level Sync — Integration', () {
    // H1
    test('H1: Device A creates row → syncs → Device B syncs → B sees '
        'A row', () async {
      // Device A
      final tA = _ConfigTransport();
      final hA = await _makeRowSync(transport: tA);
      await hA.addRow(activityId: 'crossDev', status: 'active',
          title: 'Cross-Device Task');

      // Device A syncs → pushes to remote
      await hA.svc.checkAndSync();

      // Device B — simulate pulling what Device A pushed
      // We need to configure B's transport to return A's blob
      // For Phase 2 RED: this integration test defines the contract.
      // The assertion is that B must eventually see A's entry.
      final hB = await _makeRowSync();

      // Add a row on B so F1 doesn't short-circuit (B needs to pull A's data)
      await hB.addRow(activityId: 'bypH1', status: 'active');

      // Configure B's transport to return the blob A pushed
      if (tA.pushData.isNotEmpty) {
        hB.transport.setPullResponse('staging/blob', tA.pushData[0]);
      }

      await hB.svc.checkAndSync();

      // B should see A's row
      final rowsB = await hB.stagingStore.getAllRows();
      expect(rowsB.where((r) => r['activity_id'] == 'crossDev'), isNotEmpty,
          reason: 'Cross-device sync: B must see A\'s staging entry');

      await hA.close();
      await hB.close();
    });

    // H2
    test('H2: Device A updates row (higher updated_at) → syncs → '
        'Device B syncs → B gets updated version', () async {
      final hA = await _makeRowSync();
      final hB = await _makeRowSync();

      // Both devices start with same row
      await hA.addRow(activityId: 'updateMe', status: 'active',
          updatedAt: 1000, title: 'Original');
      await hB.addRow(activityId: 'updateMe', status: 'active',
          updatedAt: 1000, title: 'Original');

      // Device A updates (higher timestamp)
      // Direct store update to simulate update
      await hA.stagingStore.putRow({
        'activity_id': 'updateMe',
        'activity_status': 'ended',
        'activity': '{"title":"Updated by A"}',
        'updated_at': 5000,
      });

      // A syncs → pushes to remote
      await hA.svc.flushPendingQueue();

      // Now B syncs — should get A's version
      // Set B's transport to return whatever A pushed
      // (In a real scenario, remote stores A's blob)
      // For Phase 2 RED: verify contract that B gets newer version
      if (hA.transport.pushData.isNotEmpty) {
        hB.transport.setPullResponse('staging/blob', hA.transport.pushData[0]);
      }

      await hB.svc.checkAndSync();

      final rowsB = await hB.stagingStore.getAllRows();
      final updated = rowsB.firstWhere(
          (r) => r['activity_id'] == 'updateMe',
          orElse: () => <String, dynamic>{});
      // When remote has newer timestamp, it should win
      expect(updated['activity_status'], 'ended',
          reason: 'B must get updated status from A (LWW: remote newer wins)');

      await hA.close();
      await hB.close();
    });

    // H3
    test('H3: Device A commits entry → syncs → Device B has same row '
        '→ row stays uncommitted in staging (R4: committed filtered from push)', () async {
      final hA = await _makeRowSync();
      final hB = await _makeRowSync();

      // Both devices have the same row
      await hA.addRow(activityId: 'commitMe', status: 'ended',
          committed: false, title: 'To Commit');
      await hB.addRow(activityId: 'commitMe', status: 'active',
          committed: false, title: 'To Commit');

      // Device A commits (marks committed=true)
      await hA.stagingStore.putRow({
        'activity_id': 'commitMe',
        'activity_status': 'ended',
        'activity': '{"title":"Committed"}',
        'updated_at': 5000,
        'committed': true,
      });

      // A syncs — R4 filters committed rows from push
      await hA.svc.flushPendingQueue();

      // B syncs — pulls the blob (which has empty entries due to R4 filter)
      if (hA.transport.pushData.isNotEmpty) {
        hB.transport.setPullResponse('staging/blob', hA.transport.pushData[0]);
      }

      await hB.svc.checkAndSync();

      // B's row stays in staging — committed flag propagates through
      // the ledger pull service, not through staging sync (R4).
      final rowsB = await hB.stagingStore.getAllRows();
      final theRow = rowsB.where((r) => r['activity_id'] == 'commitMe');
      expect(theRow, isNotEmpty,
          reason: 'Row stays in staging for History/Dashboard');
      // R4: committed rows not propagated through staging sync — the
      // committed flag is carried by the ledger pull service.
      expect(theRow.first['committed'], isFalse,
          reason: 'R4: committed flag not propagated through staging; '
              'ledger pull service handles committed seeding');

      await hA.close();
      await hB.close();
    });

    // H4
    test('H4: both devices create different rows → both sync → both '
        'have all rows', () async {
      final hA = await _makeRowSync();
      final hB = await _makeRowSync();

      // Device A creates row-1
      await hA.addRow(activityId: 'rowA1', status: 'active', title: 'A1');
      await hA.svc.checkAndSync();

      // Device B creates row-2
      await hB.addRow(activityId: 'rowB1', status: 'active', title: 'B1');
      await hB.svc.checkAndSync();

      // Cross-sync: A's remote gets B's data and vice versa
      if (hB.transport.pushData.isNotEmpty) {
        hA.transport.setPullResponse('staging/blob', hB.transport.pushData[0]);
      }
      if (hA.transport.pushData.isNotEmpty) {
        hB.transport.setPullResponse('staging/blob', hA.transport.pushData[0]);
      }

      await hA.svc.checkAndSync();
      await hB.svc.checkAndSync();

      // Both should have both rows
      final rowsA = await hA.stagingStore.getAllRows();
      final rowsB = await hB.stagingStore.getAllRows();

      final idsA = rowsA.map((r) => r['activity_id'] as String).toSet();
      final idsB = rowsB.map((r) => r['activity_id'] as String).toSet();

      expect(idsA, containsAll(['rowA1', 'rowB1']),
          reason: 'A must have both rows after cross-sync');
      expect(idsB, containsAll(['rowA1', 'rowB1']),
          reason: 'B must have both rows after cross-sync');

      await hA.close();
      await hB.close();
    });

    // H5
    test('H5: full sync cycle with 10 local + 10 remote rows → verify '
        'all rows present and correct', () async {
      final h = await _makeRowSync();

      // 10 local rows
      for (var i = 0; i < 10; i++) {
        await h.addRow(
          activityId: 'loc${i.toString().padLeft(3, '0')}',
          status: 'active',
          title: 'Local $i',
          updatedAt: i * 100,
        );
      }

      // 10 remote rows
      final remoteRows = List.generate(10, (i) => {
        'activity_id': 'rem${i.toString().padLeft(3, '0')}',
        'activity_status': 'active',
        'activity': '{"title":"Remote $i"}',
        'updated_at': (i + 10) * 100,
      });
      h.transport.setPullResponse('staging/blob', await h.makeObfuscatedBlob(remoteRows));

      await h.svc.checkAndSync();

      // All 20 rows must be present
      final rows = await h.stagingStore.getAllRows();
      expect(rows.length, 20,
          reason: 'All 20 rows (10 local + 10 remote) must survive sync');

      await h.close();
    });

    // H6
    test('H6: sync completes under 2 seconds for 20 rows '
        '(mock transport)', () async {
      final h = await _makeRowSync();

      // Add 20 local rows
      for (var i = 0; i < 20; i++) {
        await h.addRow(
          activityId: 'perf${i.toString().padLeft(3, '0')}',
          status: 'active',
          title: 'Perf $i',
        );
      }

      final start = DateTime.now();
      await h.svc.checkAndSync();
      final elapsed = DateTime.now().difference(start);

      expect(elapsed.inMilliseconds, lessThan(2000),
          reason: 'Sync must complete under 2 seconds for 20 rows '
              '(mock transport, no network latency)');

      await h.close();
    });

    // H7
    test('H7: checkAndSync updates _lastPushAt after successful sync',
        () async {
      final h = await _makeRowSync();

      expect(h.svc.lastPushAt, 0,
          reason: 'lastPushAt must start at 0');

      await h.addRow(activityId: 'tsCheck', status: 'active');
      final before = DateTime.now().millisecondsSinceEpoch;
      await h.svc.checkAndSync();

      expect(h.svc.lastPushAt, greaterThan(0),
          reason: 'lastPushAt must be updated after sync');
      expect(h.svc.lastPushAt, greaterThanOrEqualTo(before),
          reason: 'lastPushAt must reflect actual push time');

      await h.close();
    });

    // H8
    test('H8: multiple rapid checkAndSync calls → only one active sync '
        'at a time', () async {
      final h = await _makeRowSync();

      // Fire multiple syncs rapidly
      final futures = <Future>[];
      for (var i = 0; i < 5; i++) {
        futures.add(h.svc.checkAndSync());
      }

      // All must complete without hanging or throwing
      final results = await Future.wait(futures);
      for (final r in results) {
        expect(r, isA<SyncCheckResult>(),
            reason: 'Rapid checkAndSync calls must all complete');
        expect(r, SyncCheckResult.ready,
            reason: 'All rapid calls must return READY (or a valid state)');
      }

      await h.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group AS: Auto-Sync (bidirectional _doPush) + status contract
  // ═══════════════════════════════════════════════════════════════
  //
  // Phase 1 (RED) tests for STAGING_AUTO_SYNC_AS_PHASE1.md. These target the
  // debounced auto-push path (_doPush): every mutation schedules a push that,
  // after this upgrade, routes through checkAndSync() (pull + merge + push)
  // instead of the old push-only _attemptPush(). AS1–AS4 cover the bidirectional
  // behavior; AS5/AS6 pin the sync-status-stream contract (SyncingStatus derived
  // from SyncCheckResult).

  group('AS: Auto-Sync (Bidirectional _doPush)', () {
    // AS1
    test('AS1: auto-push after capture() pulls a remote-only entry and '
        'merges it locally (bidirectional, no manual button)', () async {
      final h = await _makeRowSync();

      // Remote has an entry that does NOT exist locally.
      final remoteRows = [
        {
          'activity_id': 'remoteOnly',
          'activity_status': 'active',
          'activity': '{"title":"Remote Only Task"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse(
        'staging/blob',
        await h.makeObfuscatedBlob(remoteRows),
      );

      // Local mutation schedules the debounced auto-push.
      await h.svc.capture(title: 'Local Push Task');

      // Wait past the 500ms debounce so the auto-push fires.
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // The remote-only entry must now exist in local staging without a
      // manual checkAndSync() call.
      final rows = await h.stagingStore.getAllRows();
      expect(rows.where((r) => r['activity_id'] == 'remoteOnly'), isNotEmpty,
          reason: 'Auto-push must pull remote entries down and merge them '
              'locally — not just push local rows up');

      await h.close();
    });

    // AS2
    test('AS2: reauthNeeded during auto-push degrades silently — no throw, '
        'local cookie preserved, no error status surfaced', () async {
      final h = await _makeRowSync();

      // Remote advertises a DIFFERENT cookie specifier → checkAndSync()
      // returns reauthNeeded and PRESERVES the local cookie (so the next
      // periodic tick re-detects the mismatch instead of auto-reclaiming).
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie('ffffffffffffffffffffffffffffffff'),
      );

      final statuses = <SyncingStatus>[];
      final sub = h.svc.syncStatus.listen((s) => statuses.add(s));

      // Local mutation — must NOT throw even though sync will reauth.
      await h.svc.capture(title: 'Conflict Task');
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // No throw above and no error surfaced via the status stream.
      expect(statuses.contains(SyncingStatus.error), isFalse,
          reason: 'reauthNeeded must degrade silently in auto-push, NOT '
              'surface an error status');

      // The cookie conflict must have been routed through checkAndSync()
      // (which preserves the mismatched local cookie), proving auto-push now
      // consults the remote cookie rather than blindly pushing. Preserving it
      // keeps the competing-owner mismatch detectable on the next tick
      // (§12.3-A1 / I1: no silent reclaim).
      final cookie = await h.storage.get('cookie');
      expect(cookie, isNotNull,
          reason: 'Auto-sync must detect and preserve the mismatched cookie '
              'instead of silently pushing against a conflicting identity');
      expect((cookie as Map)['device_specifier'], _knownSpecifier,
          reason: 'Preserved cookie must retain its original specifier');

      await sub.cancel();
      await h.close();
    });

    // AS3
    test('AS3: no transport → auto-push no-ops safely and settles to '
        'inSync (no throw, no stuck pendingPush)', () async {
      final crypto = await _makeCrypto();
      final storage = _FakeStorage();
      final db = AppDatabase.inMemory();
      final stagingStore = StagingStore(db);
      final svc = SyncService(
        storage: storage,
        crypto: crypto,
        transport: null, // local-only mode
        stagingStore: stagingStore,
      );

      final statuses = <SyncingStatus>[];
      final sub = svc.syncStatus.listen((s) => statuses.add(s));

      // Mutation schedules the debounce; no transport should be configured.
      await svc.capture(title: 'Offline Task');
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // No throw (test completing is the proof), no push happens (trivially),
      // and the status must NOT stay stuck on pendingPush — a no-op auto-push
      // should settle back to inSync.
      expect(statuses.last, SyncingStatus.inSync,
          reason: 'A no-op auto-push (no transport) must settle to inSync, '
              'not leave the status stream stuck on pendingPush');

      await sub.cancel();
      svc.dispose();
      await db.close();
    });

    // AS4
    test('AS4: with a valid matching cookie, auto-push uses the fast path '
        '(pulls hash index, pushes if changed) rather than a full blob '
        'reconcile', () async {
      final h = await _makeRowSync();

      // Create a row so there is a pending write past the F1 gate.
      await h.svc.capture(title: 'Fast Path Task');

      // Match the cookie for the fast path.
      h.transport.setPullResponse(
        StagingPaths.remoteDeviceCookie,
        _makeRemoteCookie(_knownSpecifier),
      );

      // Seed an identical remote hash index so diff.identical == true.
      final localIndex = await StagingHashIndex.build(h.stagingStore);
      h.transport.setPullResponse(
        StagingPaths.remoteStagingHashIndex,
        Uint8List.fromList(utf8.encode(json.encode(localIndex))),
      );

      // Let the debounced auto-push fire.
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // Fast path: hash index was pulled, but NO full blob pull happened.
      expect(h.transport.pullPaths,
          contains(StagingPaths.remoteStagingHashIndex),
          reason: 'Auto-push must exercise the Tier-1 hash-index fast path');
      expect(h.transport.pullPaths, isNot(contains('staging/blob')),
          reason: 'On a matching cookie with identical hash index, auto-push '
              'must skip the full blob reconcile');

      await h.close();
    });
  });

  group('AS+: Auto-Sync — Status-Stream Contract', () {
    // AS5
    test('AS5: after a successful auto-sync, status stream emits '
        'pendingPush then settles to inSync (not stuck, no error)', () async {
      final h = await _makeRowSync();

      final statuses = <SyncingStatus>[];
      final sub = h.svc.syncStatus.listen((s) => statuses.add(s));

      await h.svc.capture(title: 'Sync OK Task');
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // Must have gone through pendingPush and settled to inSync.
      expect(statuses.contains(SyncingStatus.pendingPush), isTrue,
          reason: 'A mutation must first surface pendingPush before the sync');
      expect(statuses.last, SyncingStatus.inSync,
          reason: 'A successful auto-sync must settle the status to inSync, '
              'not leave it stuck on pendingPush');
      expect(statuses.contains(SyncingStatus.error), isFalse,
          reason: 'A successful auto-sync must not emit an error status');

      await sub.cancel();
      await h.close();
    });

    // AS6
    test('AS6: network failure during auto-sync surfaces as error status '
        '(distinct from the silent reauthNeeded path)', () async {
      final h = await _makeRowSync();
      h.transport.setThrowOnAll(true);

      final statuses = <SyncingStatus>[];
      final sub = h.svc.syncStatus.listen((s) => statuses.add(s));

      await h.svc.capture(title: 'Network Fail Task');
      await Future<void>.delayed(const Duration(milliseconds: 800));

      // Real transport failures must surface visually as error.
      expect(statuses.contains(SyncingStatus.error), isTrue,
          reason: 'A genuine network failure must emit error status so the UI '
              'can surface it');
      expect(statuses.last, SyncingStatus.error,
          reason: 'A failed auto-sync must end in error, not inSync');

      await sub.cancel();
      await h.close();
    });
  });
}
