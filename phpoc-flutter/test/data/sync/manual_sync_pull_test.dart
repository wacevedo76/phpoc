import 'dart:convert' show json;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// F1 Manual "Sync Staging" Pull — Phase 2 (RED).
///
/// Blueprint: docs/planning/flutter/MANUAL_SYNC_PULL_F1_PHASE1.md
/// Group S1 (3 service-level assertions): the manual "Sync Staging" path must
/// be able to pull remote staging rows into an EMPTY local store. Today the
/// F1 read-only fast path short-circuits `checkAndSync()` to `ready` when the
/// local device has no pending uncommitted writes — so a phone's remote rows
/// are never fetched. `skipReadOnlyFastPath: true` forces past F1, but the
/// manual Sync button never forwards it.

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure (mirrors sync_service_row_level_test.dart)
// ═══════════════════════════════════════════════════════════════════

/// In-memory storage for SyncService's `storage` parameter.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Configurable transport spy: returns specific bytes per path,
/// records all pull paths/data so we can assert what was requested.
class _ConfigTransport extends HttpTransport {
  final Map<String, Uint8List?> _pullResponses = {};
  final Map<String, int> _pullStatusCodes = {};
  final List<String> pullPaths = [];
  bool _throwOnAll = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  void setPullResponse(String path, Uint8List? data, {int statusCode = 200}) {
    _pullResponses[path] = data;
    _pullStatusCodes[path] = statusCode;
  }

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
    return null; // default: no data
  }

  @override
  Future<void> push(String path, Uint8List data) async {}

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

/// Create a CryptoService with a cached master key.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

/// Build a SyncService wired with StagingStore + configurable transport.
///
/// Seeds a fresh, valid local cookie so `checkAndSync` reaches the cookie /
/// reconcile branch rather than bailing at the cookie gate. Staging starts
/// EMPTY (no local rows) — the exact manual-sync scenario.
Future<_PullHarness> _makeHarness({_ConfigTransport? transport}) async {
  final c = await _makeCrypto();
  final t = transport ?? _ConfigTransport();
  final storage = _FakeStorage();
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);

  await storage.set('cookie', {
    'device_specifier': 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
    'creation_time': DateTime.now().millisecondsSinceEpoch,
  });

  final svc = SyncService(
    storage: storage,
    crypto: c,
    transport: t,
    stagingStore: stagingStore,
  );

  return _PullHarness(svc, stagingStore, storage, t, db);
}

/// Bundles test artifacts.
class _PullHarness {
  final SyncService svc;
  final StagingStore stagingStore;
  final _FakeStorage storage;
  final _ConfigTransport transport;
  final AppDatabase db;

  _PullHarness(this.svc, this.stagingStore, this.storage, this.transport,
      this.db);

  /// Build an obfuscated staging/blob payload carrying the given rows.
  Future<Uint8List> makeObfuscatedBlob(List<Map<String, dynamic>> rows) async {
    final blobData = {
      'entries': rows,
      'device_id': 'remote-device',
      'device_proof': 'proof-string',
    };
    final c = CryptoService();
    await c.initialize();
    final mk =
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    return c.obfuscateBlob(json.encode(blobData), mk);
  }

  Future<void> close() async {
    svc.dispose();
    await db.close();
  }
}

void main() {
  group('S1: Manual sync pulls remote rows — empty local staging', () {
    // S1.1
    test(
        'S1.1: checkAndSync(skipReadOnlyFastPath: true) with empty local '
        'staging pulls the remote staging/blob row into the store', () async {
      final h = await _makeHarness();

      // Remote (phone) has one running activity; local is empty.
      final remoteRows = [
        {
          'activity_id': 'PHONE1',
          'activity_status': 'active',
          'activity': '{"title":"Phone Task"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse(
          StagingPaths.remoteRowLevelBlob, await h.makeObfuscatedBlob(remoteRows));
      final empty = await h.stagingStore.getAllRows();
      expect(empty, isEmpty, reason: 'Test precondition: local staging empty');

      // Forced pull (manual sync forwards skipReadOnlyFastPath).
      final result = await h.svc.checkAndSync(skipReadOnlyFastPath: true);
      expect(result, SyncCheckResult.ready);

      // The phone's row must have arrived into the empty local store.
      final rows = await h.stagingStore.getAllRows();
      final ids = rows.map((r) => r['activity_id'] as String).toSet();
      expect(ids, contains('PHONE1'),
          reason: 'Field fix: manual sync must pull remote rows even when '
              'local staging is empty');

      expect(h.transport.pullPaths, contains(StagingPaths.remoteRowLevelBlob),
          reason: 'The remote blob is the row source for the pull');

      await h.close();
    });

    // S1.2
    test(
        'S1.2: checkAndSync() WITHOUT the flag short-circuits to ready and '
        'does NOT pull staging/blob (F1 pinned as the bug)', () async {
      final h = await _makeHarness();

      final remoteRows = [
        {
          'activity_id': 'PHONE1',
          'activity_status': 'active',
          'activity': '{"title":"Phone Task"}',
          'updated_at': 5000,
        },
      ];
      h.transport.setPullResponse(
          StagingPaths.remoteRowLevelBlob, await h.makeObfuscatedBlob(remoteRows));

      // Default call (no flag) — what the Sync button does TODAY.
      final result = await h.svc.checkAndSync();
      expect(result, SyncCheckResult.ready);

      // F1 should have short-circuited BEFORE any remote blob fetch.
      expect(h.transport.pullPaths, isNot(contains(StagingPaths.remoteRowLevelBlob)),
          reason: 'F1 read-only fast path must not pull the remote blob when '
              'local staging is empty and no flag is passed');

      final localRows = await h.stagingStore.getAllRows();
      expect(localRows, isEmpty,
          reason: 'Without the forced flag, the phone row must remain un-pulled');

      await h.close();
    });

    // S1.3
    test(
        'S1.3: forced pull with absent remote staging/blob + empty local '
        'returns ready and fabricates no rows (fail-safe)', () async {
      final h = await _makeHarness();

      // Remote blob 404 / absent — the transport returns null for it.
      final result = await h.svc.checkAndSync(skipReadOnlyFastPath: true);
      expect(result, SyncCheckResult.ready,
          reason: 'Bare remote with forced path must still succeed cleanly');

      final localRows = await h.stagingStore.getAllRows();
      expect(localRows, isEmpty,
          reason: 'No rows may be fabricated when the remote blob is absent');

      await h.close();
    });
  });
}
