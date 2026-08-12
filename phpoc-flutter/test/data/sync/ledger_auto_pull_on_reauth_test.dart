import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/merge_engine.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// Ledger Auto-Pull on Ownership-Handoff Reauth — Group L1–L4 (Phase 2 RED).
///
/// Blueprint: docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md (test groups)
/// ADR:       docs/design/ARCHITECTURAL_DECISIONS.md §ADR-030
///
/// These tests define the Phase 3 target interface and are expected to FAIL
/// (RED) until the implementation lands:
///   Group L1 — ownership-handoff ledger pull (when NOT to pull too)
///   Group L2 — block-count freshness detector
///   Group L3 — Scenario-5/6 staging cleanup (ledger-aware)
///   Group L4 — commit → auto-push ledger + wipe staging (D11 move)

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure
// ═══════════════════════════════════════════════════════════════════

const mkHex =
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const _specA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/// In-memory storage for SyncService's `storage` parameter AND the
/// LedgerEngine block store (shared bag: cookie / index / blocks keys).
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);

  // LedgerEngine block-store interface
  dynamic readIndex() => _data['index'];
  void writeIndex(dynamic data) => _data['index'] = data;
  List<Map<String, dynamic>> readBlocks() =>
      (_data['blocks'] as List?)?.cast<Map<String, dynamic>>() ?? [];
  void appendBlocks(List blocks) {
    _data.putIfAbsent('blocks', () => []);
    (_data['blocks'] as List).addAll(blocks);
  }
  List truncate(int keepCount) {
    final blocks = (_data['blocks'] as List?) ?? [];
    final removed = List.from(blocks.sublist(keepCount));
    _data['blocks'] = List.from(blocks.sublist(0, keepCount));
    return removed;
  }
  int getBlockCount() => (_data['blocks'] as List?)?.length ?? 0;
  Map<String, dynamic>? getLastBlock() {
    final blocks = _data['blocks'] as List?;
    if (blocks == null || blocks.isEmpty) return null;
    return blocks.last as Map<String, dynamic>;
  }
}

/// Transport spy that records every pull/push path and serves preselected
/// content per path. `ledger/hash_index.json` is plaintext JSON; block
/// indices are served from `_blockBytes`.
class _ConfigTransport extends HttpTransport {
  final Map<String, Uint8List?> _pullResponses = {};
  final List<String> pullPaths = [];
  final List<String> pushPaths = [];
  final List<Uint8List> pushData = [];

  /// Remote block files keyed by full path, e.g. 'ledger/blocks/000003.json'.
  final Map<String, Uint8List> blockFiles = {};
  bool _throwOnAll = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  /// Serve an arbitrary plaintext response for [path]. Use raw utf8 bytes.
  void serveText(String path, String data) {
    _pullResponses[path] = Uint8List.fromList(utf8.encode(data));
  }

  /// Serve the plaintext ledger/hash_index.json payload.
  void serveHashIndex(List<String> hashes) {
    serveText('ledger/hash_index.json', json.encode(hashes));
  }

  /// Make all operations throw (network simulation).
  void setThrowOnAll() => _throwOnAll = true;

  /// Was the ledger pull path ever consulted?
  bool get consultedLedgerHashIndex =>
      pullPaths.contains(StagingPaths.remoteHashIndex);

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (_throwOnAll) throw HttpTransportException('simulated', 0);
    if (_pullResponses.containsKey(path)) return _pullResponses[path];
    if (blockFiles.containsKey(path)) return blockFiles[path];
    if (path.endsWith('?list') || path.contains('?prefix=')) {
      // listFiles fallback (rarely used here)
      return Uint8List.fromList(utf8.encode(json.encode(<String>[])));
    }
    return null;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    if (_throwOnAll) throw HttpTransportException('simulated', 0);
    return blockFiles.keys
        .where((k) => k.startsWith(prefix))
        .map((k) => k.substring(prefix.length))
        .toList();
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    pushPaths.add(path);
    pushData.add(data);
    if (_throwOnAll) throw HttpTransportException('simulated', 0);
    blockFiles[path] = data;
  }

  @override
  Future<void> delete(String path) async {}
}

/// Full harness wiring a real SyncService together with a real StagingStore,
/// LedgerEngine, LedgerPullService and LedgerPushService over one shared
/// transport and database — the Phase 3 target wiring.
class _Harness {
  final AppDatabase db;
  final CryptoService crypto;
  final _FakeStorage storage;
  final StagingStore stagingStore;
  final _ConfigTransport transport;
  final LedgerPullService pullSvc;
  final LedgerPushService pushSvc;
  final LedgerEngine engine;
  final SyncService svc;

  _Harness._(
    this.db,
    this.crypto,
    this.storage,
    this.stagingStore,
    this.transport,
    this.pullSvc,
    this.pushSvc,
    this.engine,
    this.svc,
  );

  /// Build a fresh harness. When [seedCookie] is null no local cookie is
  /// written; otherwise the given specifier is stored with now timestamp.
  static Future<_Harness> build({String? seedCookie}) async {
    final c = CryptoService();
    await c.initialize();
    c.setMasterKey(mkHex);

    final db = AppDatabase.inMemory();
    final store = StagingStore(db);
    final storage = _FakeStorage();
    final t = _ConfigTransport();

    if (seedCookie != null) {
      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': seedCookie,
        'creation_time': now,
      });
    }

    final stagingStorage = StagingStorage(db);
    final backup = LedgerBackupService(db: db);
    final pullSvc = LedgerPullService(
      db: db,
      crypto: c,
      transport: t,
      backupService: backup,
      stagingStorage: stagingStorage,
      stagingStore: store,
    );
    final pushSvc = LedgerPushService(db: db, crypto: c, transport: t);
    final engine = LedgerEngine(
      crypto: c,
      store: storage,
      indexStore: storage,
      stagingStore: store,
    );
    final svc = SyncService(
      storage: storage,
      crypto: c,
      transport: t,
      stagingStore: store,
      ledgerEngine: engine,
      ledgerPull: pullSvc,
      ledgerPush: pushSvc,
    );

    return _Harness._(
        db, c, storage, store, t, pullSvc, pushSvc, engine, svc);
  }

  /// Add a staging row with status [status] and a title. The row-level
  /// `start_epoch` is required for commit (positive int).
  Future<void> addRow({
    required String activityId,
    String status = 'ended',
    String title = 'Test Task',
    int startEpoch = 1700000000000,
    bool committed = false,
  }) async {
    await stagingStore.putRow({
      'activity_id': activityId,
      'activity_status': status,
      'activity': json.encode({
        'title': title,
        'start_epoch': startEpoch,
        'duration': 3600000,
        'is_active': status == 'active',
        'is_paused': status == 'paused',
        'pauses': [],
        'tags': [],
        'committed': committed,
      }),
      'updated_at': startEpoch,
      'committed': committed,
      'title': title,
      'start_epoch': startEpoch,
      'duration': 3600000,
    }, preserveUpdatedAt: true);
  }

  /// Make a remote device cookie with the given specifier (plaintext).
  Uint8List remoteCookie(String specifier) => Uint8List.fromList(
        utf8.encode(json.encode({
          'device_uuid': 'remote-device-uuid',
          'device_specifier': specifier,
        })),
      );

  Future<void> close() async {
    svc.dispose();
    await db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Group L2 — Block-Count Freshness (LedgerPullService.pullIfRemoteHasMore)
// ═══════════════════════════════════════════════════════════════════
// Written directly against the Phase 3 target method.

void _groupL2() {
  group('L2: Block-Count Freshness — pullIfRemoteHasMore', () {
    // L2.1 — Remote hash_index length == local count → no block download
    test('L2.1: remote hash_index length == local block count → no download',
        () async {
      final h = await _Harness.build();
      // Remote ledger has 2 blocks, local also has 2 blocks.
      h.transport.serveHashIndex(['hash0', 'hash1']);

      final result =
          await h.pullSvc.pullIfRemoteHasMore(localBlockCount: 2);

      // Contract: no new blocks pulled, ok result, no ledger download.
      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
      expect(result.entriesStaged, 0);
      await h.close();
    });

    // L2.2 — Remote greater → pull the missing blocks
    test('L2.2: remote hash_index > local block count → pulls missing blocks',
        () async {
      final h = await _Harness.build();
      // Remote ledger has 3 blocks, local has 1 → 2 are missing.
      h.transport.serveHashIndex(['hash0', 'hash1', 'hash2']);
      // Seed one local block so the local count is 1.
      h.engine.commit([
        {
          'title': 'A',
          'start_epoch': 1700000000000,
          'duration': 1000,
        }
      ]);

      final result =
          await h.pullSvc.pullIfRemoteHasMore(localBlockCount: 1);

      // RED: stub ok(0). Phase 3 must pull the 2 missing blocks.
      expect(result.success, isTrue);
      expect(result.blocksPulled, greaterThan(0));
      await h.close();
    });

    // L2.3 — Remote hash_index absent/empty → treat as no change
    test('L2.3: remote hash_index absent/empty → no download', () async {
      final h = await _Harness.build();
      // No hash_index served; transport returns null for it.
      // Local block count 0 — nothing to download.

      final result =
          await h.pullSvc.pullIfRemoteHasMore(localBlockCount: 0);

      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
      await h.close();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Group L3 — Scenario-5/6 Staging Cleanup (MergeEngine.dropLedgerCommitted)
// ═══════════════════════════════════════════════════════════════════

void _groupL3() {
  group('L3: Scenario-5/6 Staging Cleanup — dropLedgerCommitted', () {
    Map<String, dynamic> row(String id, String title) => {
          'activity_id': id,
          'activity_status': 'ended',
          'activity': json.encode({
            'title': title,
            'start_epoch': 1700000000000,
            'duration': 0,
          }),
          'updated_at': 1000,
          'committed': false,
          'title': title,
          'start_epoch': 1700000000000,
        };

    // L3.1 — Local-only row, ID in ledger → dropped
    test(
        'L3.1: local-only row whose activity_id is in the ledger → dropped '
        'from staging', () {
      final ledgerIds = {'aaa0000001', 'bbb0000002'};
      final local = [
        row('aaa0000001', 'Sealed task'),
        row('ccc0000003', 'Unsealed scratch'),
      ];

      final result =
          MergeEngine.dropLedgerCommitted(local, ledgerIds);

      // RED: stub returns all rows unchanged. Phase 3 drops 'aaa0000001'.
      final remainingIds =
          result.map((r) => r['activity_id']).toList();
      expect(remainingIds, isNot(contains('aaa0000001')));
      expect(remainingIds, contains('ccc0000003'));
    });

    // L3.2 — Local-only row, ID NOT in ledger → kept (pushed)
    test('L3.2: local-only row NOT in ledger → kept', () {
      final ledgerIds = {'aaa0000001'};
      final local = [
        row('ccc0000003', 'Unsealed scratch'),
      ];

      final result =
          MergeEngine.dropLedgerCommitted(local, ledgerIds);

      expect(result.length, 1);
      expect(result.single['activity_id'], 'ccc0000003');
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Group L1 — Ownership-Handoff Ledger Pull
// ═══════════════════════════════════════════════════════════════════

void _groupL1() {
  group('L1: Ownership-Handoff Ledger Pull', () {
    // L1.2 — Fresh no-cookie reconcile-and-claim → pulls remote ledger
    test(
        'L1.2: fresh no-cookie claim runs reconcile and pulls the ledger',
        () async {
      final h = await _Harness.build(); // no seedCookie
      // Remote staging blob empty, remote ledger has a hash_index.
      h.transport.serveHashIndex(['hash0', 'hash1']);

      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.ready);
      // RED: checkAndSync never consults the ledger on a fresh claim.
      expect(h.transport.consultedLedgerHashIndex, isTrue);
      await h.close();
    });

    // L1.4 — Valid-cookie fast path (matches specifier) → does NOT pull ledger
    test(
        'L1.4: valid-cookie fast path does NOT pull the ledger',
        () async {
      final h = await _Harness.build(seedCookie: _specA);
      await _serveRemoteCookie(h, _specA);

      // No pending writes and fast path enabled → should stay local.
      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.ready);
      // Ledger must NOT be consulted on a same-device fast path.
      expect(h.transport.consultedLedgerHashIndex, isFalse);
      await h.close();
    });

    // L1.3 — TTL-expiry with unchanged specifier → does NOT pull ledger
    test(
        'L1.3: TTL-expiry with unchanged specifier does NOT pull ledger',
        () async {
      final h = await _Harness.build(seedCookie: _specA);
      // Expire the cookie by back-dating creation_time beyond TTL (30 min).
      await _expireCookie(h);
      // Remote cookie still carries the SAME specifier (device aged out).
      await _serveRemoteCookie(h, _specA);

      final result = await h.svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded);
      // Ledger must NOT be pulled for same-device TTL expiry.
      expect(h.transport.consultedLedgerHashIndex, isFalse);
      await h.close();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Group L4 — Commit → Auto-Push Ledger + Wipe Staging (D11 move)
// ═══════════════════════════════════════════════════════════════════

void _groupL4() {
  group('L4: Commit → Auto-Push Ledger + Wipe Staging', () {
    // L4.1 — User commit seals a new block
    test('L4.1: commit seals a new ledger block', () async {
      final h = await _Harness.build();
      await h.addRow(activityId: 'aaa0000001', title: 'Sealed task');

      final before = h.engine.getBlockCount();
      final hashPrefix = await h.svc.commitAndSync();
      final after = h.engine.getBlockCount();

      expect(hashPrefix, isNotNull);
      expect(after, greaterThan(before));
      await h.close();
    });

    // L4.2 — User commit auto-pushes the new ledger blocks to Remote
    test(
        'L4.2: commit auto-pushes new ledger blocks to Remote',
        () async {
      final h = await _Harness.build();
      await h.addRow(activityId: 'aaa0000001', title: 'Sealed task');

      await h.svc.commitAndSync();

      // RED: commitAndSync does not yet push ledger blocks to Remote.
      final ledgerPushed = h.transport.pushPaths.any(
        (p) => p.startsWith('ledger/blocks/'),
      );
      final hashIndexPushed =
          h.transport.pushPaths.contains('ledger/hash_index.json');
      expect(ledgerPushed, isTrue);
      expect(hashIndexPushed, isTrue);
      await h.close();
    });

    // L4.3 — Commit removes committed rows from local staging (moved, not kept)
    test(
        'L4.3: commit removes committed rows from local staging',
        () async {
      final h = await _Harness.build();
      await h.addRow(activityId: 'aaa0000001', title: 'Sealed task');

      await h.svc.commitAndSync();

      final rows = await h.stagingStore.getAllRows();
      // RED: rows stay (marked committed) until the D11 move lands.
      expect(rows, isEmpty);
      await h.close();
    });

    // L4.4 — Commit propagates remote staging cleanup so stale devices reconcile away
    test(
        'L4.4: remote staging excludes the committed rows after commit',
        () async {
      final h = await _Harness.build();
      await h.addRow(activityId: 'aaa0000001', title: 'Sealed task');

      await h.svc.commitAndSync();

      // Inspect the last pushed staging blob; it must not contain the row.
      final blobIndex = h.transport.pushPaths.lastIndexOf(
        StagingPaths.remoteRowLevelBlob,
      );
      expect(blobIndex, greaterThanOrEqualTo(0), reason: 'pushed a staging blob');
      final blob = h.transport.pushData[blobIndex];
      final decoded = h.crypto.deobfuscateBlob(
        blob,
        h.crypto.getMasterKey()!,
      );
      final payload = json.decode(decoded) as Map<String, dynamic>;
      final entries = payload['entries'] as List<dynamic>;
      final ids = entries.map((e) => (e as Map)['activity_id']).toList();
      expect(ids, isNot(contains('aaa0000001')));
      await h.close();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Helpers for cookie expiration / remote-cookie serving
// ═══════════════════════════════════════════════════════════════════

/// Back-date the local cookie so it is beyond the default 30-minute TTL.
Future<void> _expireCookie(_Harness h) async {
  final expiredAt = DateTime.now()
      .millisecondsSinceEpoch -
      40 * 60 * 1000; // 40 min ago
  await h.storage.set('cookie', {
    'device_specifier': _specA,
    'creation_time': expiredAt,
  });
}

/// Serve a plaintext remote device-cookie payload for the given specifier.
Future<void> _serveRemoteCookie(_Harness h, String specifier) async {
  h.transport.serveText(
    StagingPaths.remoteDeviceCookie,
    json.encode({
      'device_uuid': 'remote-device-uuid',
      'device_specifier': specifier,
    }),
  );
}

void main() {
  _groupL1();
  _groupL2();
  _groupL3();
  _groupL4();
}
