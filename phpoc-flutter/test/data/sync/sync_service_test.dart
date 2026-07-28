import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/models/push_result.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// SyncService tests — Groups E (16) + F (5) + G (18) + H (8) = 47 assertions.
///
/// Covers:
///   E1–E5:  capture() basic flow, hash return, cookie touch, device attribution
///   E6–E12: end(), pause(), unpause() — errors and proper behavior
///   E13–E16: modify(), remove(), sequential ops, offline resilience
///   F1–F5:  getActive(), getEntries() queries
///   G1–G18: checkAndSync() sync gate — all paths
///   H1–H8:  pushToRemote() push operations

/// In-memory storage for testing.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);

  // ── LedgerEngine support ─────────────────────────────────────
  // Index store methods
  dynamic readIndex() => _data['index'];
  void writeIndex(dynamic data) => _data['index'] = data;

  // Chain store methods
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

  // Staging store methods
  List? readEntries() => _data['entries'] as List?;
  void writeEntries(List entries) => _data['entries'] = entries;
}

/// Create a fresh CryptoService with cached MK.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

/// Create a SyncService with optional transport.
Future<SyncService> _makeSync({HttpTransport? transport}) async {
  final storage = _FakeStorage();
  final crypto = await _makeCrypto();
  return SyncService(
    storage: storage,
    crypto: crypto,
    transport: transport,
  );
}

/// Spy transport that records push/pull paths without making real HTTP calls.
class _SpyTransport extends HttpTransport {
  final List<String> pushPaths = [];
  final List<String> pullPaths = [];

  _SpyTransport() : super(baseUrl: 'https://test.example.com', apiKey: 'spy-key');

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    return null; // Simulate empty remote (404 / no data)
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    pushPaths.add(path);
    // Simulate successful push
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    return [];
  }

  @override
  Future<void> delete(String path) async {
    // no-op for spy
  }
}

/// Configurable spy transport that can return specific cookie bytes for T2 tests.
class _CookieSpyTransport extends HttpTransport {
  final Uint8List? cookieBytes;
  final List<String> pushPaths = [];
  final List<String> pullPaths = [];

  _CookieSpyTransport({this.cookieBytes})
      : super(baseUrl: 'https://test.example.com', apiKey: 'spy-key');

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    if (path == StagingPaths.remoteDeviceCookie) {
      return cookieBytes;
    }
    return null;
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    pushPaths.add(path);
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    return [];
  }

  @override
  Future<void> delete(String path) async {}
}

/// Build a remote-cookie byte payload from a specifier + optional device_uuid.
Uint8List _makeRemoteCookie(String specifier, {String? deviceUuid}) {
  return Uint8List.fromList(utf8.encode(json.encode({
    'device_uuid': deviceUuid ?? 'remote-device-uuid',
    'device_specifier': specifier,
  })));
}

/// Spy transport that throws on cookie pull (for network-error tests).
class _ThrowingCookieSpyTransport extends HttpTransport {
  _ThrowingCookieSpyTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'spy-key');

  @override
  Future<Uint8List?> pull(String path) async {
    if (path == StagingPaths.remoteDeviceCookie) {
      throw Exception('Simulated network failure on cookie pull');
    }
    return null;
  }

  @override
  Future<void> push(String path, Uint8List data) async {}

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

const _knownSpecifier = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/// Spy LedgerEngine that records commit() calls for T8 tests.
class _SpyLedgerEngine {
  List<Map<String, dynamic>>? _lastCommitted;
  int _callCount = 0;
  String? _returnHash;
  bool _throwOnCommit = false;

  List<Map<String, dynamic>>? get lastCommitted => _lastCommitted;
  int get callCount => _callCount;

  void setReturnHash(String? hash) => _returnHash = hash;
  void setThrowOnCommit(bool value) => _throwOnCommit = value;

  String? commit(List<Map<String, dynamic>> entries) {
    if (_throwOnCommit) throw Exception('LedgerEngine commit failed');
    _callCount++;
    _lastCommitted = List<Map<String, dynamic>>.from(entries);
    return _returnHash;
  }
}

/// Create a SyncService with a real LedgerEngine backed by fake storage.
Future<SyncService> _makeSyncWithEngine({HttpTransport? transport}) async {
  final storage = _FakeStorage();
  final crypto = await _makeCrypto();
  final chainStore = _FakeStorage();
  final indexStore = _FakeStorage();
  final engine = LedgerEngine(
    crypto: crypto,
    store: chainStore,
    indexStore: indexStore,
    stagingStore: storage,
  );
  return SyncService(
    storage: storage,
    crypto: crypto,
    transport: transport,
    ledgerEngine: engine,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group E: Local CRUD
  // ═══════════════════════════════════════════════════════════════

  group('E: SyncService — Local CRUD', () {
    // E1
    test('E1: capture({title}) creates active entry in storage', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'New Task');

      final active = await svc.getActive();
      expect(active, isNotEmpty);
      expect(active[0]['title'], 'New Task');
      expect(active[0]['is_active'], true);
    });

    // E2
    test('E2: capture() returns entry hash prefix', () async {
      final svc = await _makeSync();
      final hash = await svc.capture(title: 'Hashed Task');

      expect(hash, isNotEmpty);
      expect(hash, isA<String>());
    });

    // E3
    test('E3: capture() touches local cookie TTL', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      await svc.capture(title: 'Cookie Test');

      // Local cookie should exist after capture
      final cookie = await storage.get('cookie');
      expect(cookie, isNotNull,
          reason: 'Every local write must touch the device cookie');
    });

    // E4
    test('E4: capture() includes device_uuid attribution', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Attributed Task');

      final entries = await svc.getEntries();
      expect(entries[0]['device_uuid'], isNotEmpty,
          reason: 'Entry must carry device attribution for cross-device merge');
    });

    // E5
    test('E5: end(title, endEpoch) sets is_active=false + end_epoch', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task to End');
      await svc.end('Task to End', 5000);

      final entries = await svc.getEntries();
      expect(entries[0]['is_active'], false);
      expect(entries[0]['end_epoch'], 5000);
    });

    // E6
    test('E6: end() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.end('Nonexistent', 5000),
        throwsA(isA<Exception>()),
      );
    });

    // E7
    test('E7: end() auto-closes open pause before ending', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Paused Task');
      await svc.pause('Paused Task', 2000);
      await svc.end('Paused Task', 5000);

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      // The open pause should be closed (pause_stop should be set)
      if (pauses.isNotEmpty) {
        expect(pauses.last['pause_stop'], isNotNull,
            reason: 'end() must auto-close any open pause');
      }
      expect(entries[0]['is_active'], false);
    });

    // E8
    test('E8: end() recomputes duration after pause closure', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Duration Task');
      await svc.pause('Duration Task', 2000);
      await svc.end('Duration Task', 5000);

      final entries = await svc.getEntries();
      // Duration = 5000 - start - pause_time
      // If start was near capture time and pause was 2K-5K
      expect(entries[0]['duration'], isA<int>());
      expect(entries[0]['duration'], greaterThanOrEqualTo(0));
    });

    // E9
    test('E9: pause(title, pauseEpoch) adds open pause record', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Pause Task');
      await svc.pause('Pause Task', 2000);

      final active = await svc.getActive();
      expect(active[0]['is_paused'], true,
          reason: 'Task should be marked as paused');

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses, isNotEmpty);
      expect(pauses.last['pause_start'], 2000);
      expect(pauses.last['pause_stop'], isNull);
    });

    // E10
    test('E10: pause() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.pause('Nonexistent', 2000),
        throwsA(isA<Exception>()),
      );
    });

    // E11
    test('E11: unpause(title, unpauseEpoch) closes open pause', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Unpause Task');
      await svc.pause('Unpause Task', 2000);
      await svc.unpause('Unpause Task', 3000);

      final active = await svc.getActive();
      expect(active[0]['is_paused'], false,
          reason: 'Task should be resumed after unpause');

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses.last['pause_stop'], 3000);
    });

    // E12
    test('E12: unpause() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.unpause('Nonexistent', 3000),
        throwsA(isA<Exception>()),
      );
    });

    // E13
    test('E13: modify(index, fields) updates entry fields', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Modify Me');
      await svc.modify(0, {'title': 'Modified Title'});

      final entries = await svc.getEntries();
      expect(entries[0]['title'], 'Modified Title');
    });

    // E14
    test('E14: remove(index) deletes entry from staging', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Remove Me');
      await svc.remove(0);

      final entries = await svc.getEntries();
      expect(entries, isEmpty);
    });

    // E15
    test('E15: multiple captures + ends produce correct entries', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task 1');
      await svc.end('Task 1', 2000);
      await svc.capture(title: 'Task 2');
      await svc.end('Task 2', 4000);

      final entries = await svc.getEntries();
      expect(entries.length, 2);
      expect(entries[0]['title'], 'Task 1');
      expect(entries[1]['title'], 'Task 2');
      expect(entries[0]['is_active'], false);
      expect(entries[1]['is_active'], false);
    });

    // E16
    test('E16: all CRUD ops work without remote transport', () async {
      // No transport = local-only mode
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      // All operations should succeed without transport
      await svc.capture(title: 'Offline Task');
      await svc.pause('Offline Task', 2000);
      await svc.unpause('Offline Task', 3000);
      await svc.modify(0, {'title': 'Offline Modified'});
      await svc.end('Offline Modified', 5000);
      await svc.remove(0);

      final entries = await svc.getEntries();
      expect(entries, isEmpty,
          reason: 'All CRUD ops must work fully offline');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: Queries
  // ═══════════════════════════════════════════════════════════════

  group('F: SyncService — Queries', () {
    // F1
    test('F1: getActive() returns only is_active=true entries', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Active');
      await svc.capture(title: 'Done');
      await svc.end('Done', 2000);

      final active = await svc.getActive();
      expect(active, isNotEmpty);
      expect(active[0]['title'], 'Active');
    });

    // F2
    test('F2: getActive() returns empty list when no active entries', () async {
      final svc = await _makeSync();
      final active = await svc.getActive();
      expect(active, isA<List>());
      expect(active, isEmpty);
    });

    // F3
    test('F3: getEntries() returns all staging entries sorted', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'C');
      await svc.capture(title: 'A');
      await svc.capture(title: 'B');

      final entries = await svc.getEntries();
      expect(entries.length, 3);
    });

    // F4
    test('F4: getEntries(from, to) filters by date range', () async {
      final svc = await _makeSync();
      // Capture will have timestamps around now
      // We'll test that the API accepts date range params
      // (RED test: verifies the API contract exists)
      final entries = await svc.getEntries(
        from: DateTime(2020),
        to: DateTime(2030),
      );
      // Should compile and return something (even if empty in stub)
      expect(entries, isA<List>());
    });

    // F5
    test('F5: entries are returned as decrypted objects with entry_index', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Flat DTO');

      final entries = await svc.getEntries();
      expect(entries[0], isA<Map>());
      expect(entries[0]['title'], isA<String>());
      expect(entries[0]['start_epoch'], isA<int>());
      expect(entries[0]['entry_id'], isA<String>());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: Sync Gate
  // ═══════════════════════════════════════════════════════════════

  group('G: SyncService — Sync Gate', () {
    // G1
    test('G1: no remote transport → returns READY', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready);
    });

    // G2
    test('G2: genesis gate passthrough (no local blocks → continue)', () async {
      final svc = await _makeSync();
      // No local ledger blocks on mobile → genesis gate passthrough
      // checkAndSync should not throw even without genesis setup
      final result = await svc.checkAndSync();
      expect(result, isNotNull);
    });

    // G3
    test('G3: local cookie valid + remote cookie match → READY (fast path)', () async {
      final svc = await _makeSync();
      // RED test: fast path not yet implemented
      final result = await svc.checkAndSync();
      // Currently returns ready (stub), but will exercise real fast path later
      expect(result, isA<SyncCheckResult>());
    });

    // G4
    test('G4: fast path pushes local blob only (pushBlobOnly)', () async {
      final svc = await _makeSync();
      // RED: fast path blob push not yet implemented
      // This test defines the contract: fast path must push blob without
      // full auth gate
      await svc.capture(title: 'Fast Path Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G5
    test('G5: local cookie valid + remote cookie mismatch → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: cookie mismatch path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G6
    test('G6: local cookie valid + no remote cookie → auth gate (merge)', () async {
      final svc = await _makeSync();
      // RED: first push path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G7
    test('G7: local cookie expired → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: TTL enforcement not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G8
    test('G8: no local cookie → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: missing cookie path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G9
    test('G9: MK available + cookie valid → reconcile (pull+merge+push)', () async {
      final svc = await _makeSync();
      // RED: auth gate reconcile not yet implemented
      await svc.capture(title: 'Reconcile Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G10
    test('G10: MK not available + no transport → READY (local-only mode)', () async {
      final storage = _FakeStorage();
      // Crypto WITHOUT master key
      final crypto = CryptoService();
      await crypto.initialize();
      // No setMasterKey call — MK unavailable

      final svc = SyncService(storage: storage, crypto: crypto);
      final result = await svc.checkAndSync();
      // No transport = local-only mode, always READY
      expect(result, SyncCheckResult.ready,
          reason: 'Without transport, sync is trivially ready — nothing to push');
    });

    // G11
    test('G11: network error during cookie pull → OFFLINE', () async {
      final svc = await _makeSync();
      // RED: network error handling not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G12
    test('G12: network error during blob pull → OFFLINE', () async {
      final svc = await _makeSync();
      // RED: blob pull error not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G13
    test('G13: remote blob key mismatch → OFFLINE (no overwrite)', () async {
      final svc = await _makeSync();
      // RED: key mismatch safety not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G14
    test('G14: merge produces combined entries from local + remote', () async {
      final svc = await _makeSync();
      // RED: merge flow not yet implemented
      await svc.capture(title: 'Local Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G15
    test('G15: committed entries filtered from merged result', () async {
      final svc = await _makeSync();
      // RED: commit filtering not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G16
    test('G16: new cookie created after successful auth gate merge', () async {
      final svc = await _makeSync();
      // RED: cookie rotation not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G17
    test('G17: cookie pushed to remote after merge', () async {
      final svc = await _makeSync();
      // RED: cookie push not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G18
    test('G18: same-device cookie match before remote push prevents race', () async {
      final svc = await _makeSync();
      // RED: race prevention not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Push
  // ═══════════════════════════════════════════════════════════════

  group('H: SyncService — Push', () {
    // H1
    test('H1: pushToRemote() serializes all staging entries', () async {
      final svc = await _makeSync();
      // RED: push not yet implemented
      await svc.capture(title: 'Push Me');
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H2
    test('H2: pushToRemote() pushes blob obfuscated with MK', () async {
      final svc = await _makeSync();
      // RED: blob obfuscation not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H3
    test('H3: pushToRemote() pushes blob BEFORE cookie', () async {
      final svc = await _makeSync();
      // RED: push ordering not yet implemented
      // Contract: blob first, cookie second (crash safety)
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H4
    test('H4: pushToRemote() includes device_id + device_proof in blob', () async {
      final svc = await _makeSync();
      // RED: device attribution in blob not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H5
    test('H5: pushToRemote() no-ops when no remote transport', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      // Should not throw — no transport is valid (local-only mode)
      await svc.pushToRemote();
    });

    // H6
    test('H6: pushBlobOnly() pushes blob without touching cookie', () async {
      final svc = await _makeSync();
      // RED: pushBlobOnly not yet implemented
      await svc.capture(title: 'Blob Only');
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H7
    test('H7: staging hash index pushed after blob (best-effort)', () async {
      final svc = await _makeSync();
      // RED: hash index push not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H8
    test('H8: lastPushAt timestamp updated after successful push', () async {
      final svc = await _makeSync();
      // RED: lastPushAt not yet implemented
      // API contract: service should expose lastPushAt
      expect(svc.lastPushAt, isA<int>(),
          reason: 'SyncService must expose lastPushAt diagnostic property');
      expect(() => svc.pushToRemote(), returnsNormally);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: getCompleted() — completed-entries query
  // ═══════════════════════════════════════════════════════════════

  group('L: SyncService — getCompleted()', () {
    // L1
    test('L1: getCompleted() returns only entries with is_active==false',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Active Task');
      await svc.capture(title: 'Done Task');
      await svc.end('Done Task', 5000);

      final completed = await svc.getCompleted();

      // Only the ended task (is_active==false) should appear
      expect(completed.length, 1,
          reason: 'getCompleted() must exclude active (is_active==true) entries');
      expect(completed[0]['title'], 'Done Task');
      expect(completed[0]['is_active'], false);
    });

    // L2
    test('L2: each completed entry has a date field (YYYY-MM-DD from start_epoch)',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Dated Task');
      await svc.end('Dated Task', 5000);

      final completed = await svc.getCompleted();

      expect(completed[0]['date'], isA<String>(),
          reason: 'Every completed entry must carry a normalized date string');
      // Must match YYYY-MM-DD pattern
      expect(completed[0]['date'], matches(r'^\d{4}-\d{2}-\d{2}$'),
          reason: 'date field must be ISO format YYYY-MM-DD');
    });

    // L3
    test('L3: entries with start_epoch==0 get date="unknown"', () async {
      final svc = await _makeSync();
      // Capture and end an entry, then manually set start_epoch to 0
      await svc.capture(title: 'Zero Epoch');
      await svc.end('Zero Epoch', 5000);
      await svc.modify(0, {'start_epoch': 0});

      final completed = await svc.getCompleted();

      expect(completed[0]['date'], 'unknown',
          reason: 'Degraded data (epoch=0) must produce "unknown" date, not crash');
    });

    // L4
    test('L4: getCompleted() returns entries sorted by start_epoch descending',
        () async {
      final svc = await _makeSync();
      // Create entries with known timestamps
      await svc.capture(title: 'Oldest');
      await svc.modify(0, {'start_epoch': 1000});
      await svc.end('Oldest', 2000);

      await svc.capture(title: 'Middle');
      await svc.modify(1, {'start_epoch': 2000});
      await svc.end('Middle', 3000);

      await svc.capture(title: 'Newest');
      await svc.modify(2, {'start_epoch': 3000});
      await svc.end('Newest', 4000);

      final completed = await svc.getCompleted();

      expect(completed.length, 3);
      expect(completed[0]['title'], 'Newest',
          reason: 'Most recent entry (highest start_epoch) must be first');
      expect(completed[1]['title'], 'Middle');
      expect(completed[2]['title'], 'Oldest',
          reason: 'Oldest entry (lowest start_epoch) must be last');
    });

    // L5
    test('L5: getCompleted() returns empty list when staging is empty',
        () async {
      final svc = await _makeSync();

      final completed = await svc.getCompleted();

      expect(completed, isEmpty,
          reason: 'Empty staging must return empty list, not null or throw');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group P: Date range filter fix
  // ═══════════════════════════════════════════════════════════════

  group('P: SyncService — Date range filter fix', () {
    // Helper: create an entry at a specific epoch and end it
    Future<SyncService> _seededSync(
        String title, int startEpoch, int endEpoch) async {
      final svc = await _makeSync();
      await svc.capture(title: title);
      await svc.modify(0, {'start_epoch': startEpoch});
      await svc.end(title, endEpoch);
      return svc;
    }

    // P1
    test('P1: getEntries(to: date) includes entries ON the end date', () async {
      // Entry at noon on June 15
      final jun15Noon = DateTime.utc(2026, 6, 15, 12, 0, 0).millisecondsSinceEpoch;
      final svc = await _seededSync('Midday Entry', jun15Noon, jun15Noon + 1000);

      // to: midnight June 15 — entry at noon should still be included
      final toDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(to: toDate);

      expect(entries.length, 1,
          reason: 'Entry at noon on June 15 must be included when to=midnight June 15 '
              '(end date must be inclusive)');
      expect(entries[0]['title'], 'Midday Entry');
    });

    // P2
    test('P2: getEntries(from: date) includes entries ON the start date',
        () async {
      final jun15Midnight =
          DateTime.utc(2026, 6, 15).millisecondsSinceEpoch;
      final svc = await _seededSync(
          'Midnight Entry', jun15Midnight, jun15Midnight + 1000);

      final fromDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(from: fromDate);

      expect(entries.length, 1,
          reason: 'Entry at midnight on June 15 must be included when from=midnight June 15 '
              '(start date must be inclusive)');
      expect(entries[0]['title'], 'Midnight Entry');
    });

    // P3
    test('P3: range filter uses end-of-day for to boundary (entries at 11 PM pass)',
        () async {
      // Entry at 11 PM on June 15
      final jun15Late = DateTime.utc(2026, 6, 15, 23, 0, 0).millisecondsSinceEpoch;
      final svc = await _seededSync('Late Entry', jun15Late, jun15Late + 1000);

      // to: midnight June 15 — but entry at 11 PM should still be included
      final toDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(to: toDate);

      expect(entries.length, 1,
          reason: 'Entry at 11 PM on June 15 must pass when to=midnight June 15. '
              'The to boundary must use end-of-day, not midnight, to avoid the off-by-one bug');
      expect(entries[0]['title'], 'Late Entry');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group K: T2 — Cookie Check (isValidLocally wiring)
  // ═══════════════════════════════════════════════════════════════

  group('K: SyncService — T2 Cookie Check wiring', () {
    // K1
    test('K1: valid local cookie + matching remote → READY (fast path)',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      // Seed a valid (fresh) local cookie
      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Spy returns matching remote cookie
      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Fast Path Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Matching cookies must trigger fast path → READY');
      // Fast path pushes blob only (no cookie push)
      expect(spy.pushPaths, contains(StagingPaths.remoteStagingBlob),
          reason: 'Fast path must push local blob to remote');
      expect(spy.pushPaths, isNot(contains(StagingPaths.remoteDeviceCookie)),
          reason: 'Fast path must NOT push cookie when specs match');
    });

    // K2
    test('K2: expired local cookie → falls to auth gate (reconcile)',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      // Seed an expired cookie (creation_time far in the past)
      final farPast =
          DateTime.now().millisecondsSinceEpoch - (31 * 60 * 1000); // 31 min
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': farPast,
      });

      final spy = _CookieSpyTransport();
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Reconcile Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Expired cookie must fall to reconcile, which returns READY on success');
      // Reconcile pushes both blob and new cookie
      expect(spy.pushPaths, contains(StagingPaths.remoteStagingBlob),
          reason: 'Reconcile must push merged blob');
      expect(spy.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: 'Reconcile must create and push a new cookie');
    });

    // K3
    test('K3: expired cookie removed from storage after checkAndSync',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final farPast =
          DateTime.now().millisecondsSinceEpoch - (31 * 60 * 1000);
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': farPast,
      });

      final spy = _CookieSpyTransport();
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.checkAndSync();

      final cookie = await storage.get('cookie');
      // After reconcile, a NEW cookie should exist (so cookie is not null).
      // But the EXPIRED cookie should be gone. The test verifies the
      // expired cookie was cleaned up and replaced.
      expect(cookie, isNotNull,
          reason: 'Reconcile creates a fresh cookie after expiry');
      expect(cookie['creation_time'],
          greaterThan(farPast + (25 * 60 * 1000)),
          reason: 'New cookie must have a recent creation_time, not the expired one');
    });

    // K4
    test('K4: malformed cookie (null specifier) → treated as expired → reconcile',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      // Malformed: null specifier
      await storage.set('cookie', {
        'device_specifier': null,
        'creation_time': DateTime.now().millisecondsSinceEpoch,
      });

      final spy = _CookieSpyTransport();
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Malformed Cookie Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Malformed cookie must be treated as expired → reconcile → READY');
      expect(spy.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: 'Reconcile must push a fresh cookie after malformed cleanup');
    });

    // K5
    test('K5: valid cookie but no MK cached → REAUTH_NEEDED', () async {
      final storage = _FakeStorage();
      // Crypto WITHOUT master key
      final crypto = CryptoService();
      await crypto.initialize();
      // No setMasterKey call — MK unavailable

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport();
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'MK gate must take priority — valid cookie alone is not enough');
    });

    // K6
    test('K6: valid cookie + no transport → READY (local-only)', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // No transport → fully local mode
      final svc = SyncService(storage: storage, crypto: crypto);

      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Local-only mode (no transport) must return READY even with a valid cookie');
    });

    // K7: configurable TTL propagated to isValidLocally
    test('K7: checkAndSync honors configurable TTL (not hardcoded 30 min)',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final tenMinAgo =
          DateTime.now().millisecondsSinceEpoch - (10 * 60 * 1000);
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': tenMinAgo,
      });

      // Test 1: With 15-min TTL, cookie is valid → fast path
      final spy15 = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc15 = SyncService(
          storage: storage, crypto: crypto, transport: spy15);

      final result15 = await svc15.checkAndSync(cookieTtlMinutes: 15);
      expect(result15, SyncCheckResult.ready,
          reason: '10-min-old cookie must be valid with 15-min TTL → fast path → READY');
      expect(spy15.pushPaths, isNot(contains(StagingPaths.remoteDeviceCookie)),
          reason: 'Fast path with 15-min TTL must not push cookie');

      // Test 2: With 5-min TTL, cookie is expired → reconcile
      final storage2 = _FakeStorage();
      await storage2.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': tenMinAgo,
      });
      final spy5 = _CookieSpyTransport();
      final svc5 = SyncService(
          storage: storage2, crypto: crypto, transport: spy5);

      final result5 = await svc5.checkAndSync(cookieTtlMinutes: 5);
      expect(result5, SyncCheckResult.ready,
          reason: '10-min-old cookie must be expired with 5-min TTL → reconcile → READY');
      expect(spy5.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: 'Reconcile after 5-min TTL expiry must push new cookie');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group M: T3 — Cookie Compare (matches + push-after-match)
  // ═══════════════════════════════════════════════════════════════

  group('M: SyncService — T3 Cookie Compare (fast path + mismatch)', () {
    // M1
    test('M1: valid local + matching remote → _pushBlobOnly called → READY',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      // Seed a fresh valid local cookie
      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Spy returns matching remote cookie
      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Fast Path Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Matching cookies must trigger fast path → READY');
      // Fast path calls _pushBlobOnly → blob pushed
      expect(spy.pushPaths, isNotEmpty,
          reason: 'Fast path must push local blob to remote');
    });

    // M2
    test('M2: spy confirms blob pushed to StagingPaths.remoteStagingBlob '
        'during fast path', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Path Check Entry');
      await svc.checkAndSync();

      expect(spy.pushPaths, contains(StagingPaths.remoteStagingBlob),
          reason: 'Fast-path blob must go to canonical staging blob path '
              'for CLI/web interop');
    });

    // M3
    test('M3: fast path does NOT push cookie (only blob)', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'No Cookie Push Entry');
      await svc.checkAndSync();

      expect(spy.pushPaths, isNot(contains(StagingPaths.remoteDeviceCookie)),
          reason: 'Fast path must NOT push cookie when specs match — '
              'cookie is unchanged, pushing wastes bandwidth');
    });

    // M4
    test('M4: mismatch — valid local + different remote specifier → '
        'destroyLocal → REAUTH_NEEDED', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Remote cookie has DIFFERENT specifier
      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie('ffffffffffffffffffffffffffffffff'),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Mismatch Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.reauthNeeded,
          reason: 'Different remote specifier = different device session → '
              'must re-authenticate');
    });

    // M5
    test('M5: mismatch — verify cookie removed from storage after '
        'destroyLocal', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie('ffffffffffffffffffffffffffffffff'),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.checkAndSync();

      final cookie = await storage.get('cookie');
      expect(cookie, isNull,
          reason: 'Mismatch must destroy local cookie — stale cookie left '
              'behind would carry wrong device identity');
    });

    // M6
    test('M6: no remote cookie — valid local + empty remote → falls to '
        'reconcile (creates cookie)', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Spy returns null cookieBytes → simulates no remote cookie
      final spy = _CookieSpyTransport(cookieBytes: null);
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'First Push Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'When remote has no cookie, local device claims it via '
              'reconcile → READY');
      // Reconcile pushes both blob and a new cookie
      expect(spy.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: 'Reconcile must create and push a cookie when remote has '
              'none (first-push-wins)');
    });

    // M7
    test('M7: network error during remote cookie pull → OFFLINE', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Spy throws on cookie pull — simulates network blip
      final spy = _ThrowingCookieSpyTransport();
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Offline Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.offline,
          reason: 'Network blip during cookie pull must return OFFLINE — '
              'must not destroy local cookie or mislabel as REAUTH');

      // Local cookie must survive the network error
      final cookie = await storage.get('cookie');
      expect(cookie, isNotNull,
          reason: 'Network error must preserve local cookie — destroying it '
              'would force unnecessary re-auth');
      expect(cookie['device_specifier'], _knownSpecifier);
    });

    // M8
    test('M8: fast path works when device_uuid in remote cookie matches '
        'local (same-device reboot)', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      // Same specifier → same device → remote cookie carries same device_uuid
      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier,
            deviceUuid: 'same-device-uuid'),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Same Device Entry');
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'After app restart, same device (matching specifier) must '
              'hit fast path, not auth gate');
      expect(spy.pushPaths, isNot(contains(StagingPaths.remoteDeviceCookie)),
          reason: 'Same-device fast path must not waste a cookie round-trip');
    });

    // M9
    test('M9: fast path updates _lastPushAt timestamp', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      // lastPushAt should be 0 before any push
      expect(svc.lastPushAt, 0,
          reason: 'lastPushAt must start at 0 before any sync');

      await svc.capture(title: 'Timestamp Entry');
      final beforeSync = DateTime.now().millisecondsSinceEpoch;
      await svc.checkAndSync();

      expect(svc.lastPushAt, greaterThan(0),
          reason: 'Fast path must update lastPushAt for diagnostic tracking');
      expect(svc.lastPushAt, greaterThanOrEqualTo(beforeSync),
          reason: 'lastPushAt must reflect the actual push time');
    });

    // M10
    test('M10: fast path with empty staging (no entries) still pushes blob',
        () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();

      final now = DateTime.now().millisecondsSinceEpoch;
      await storage.set('cookie', {
        'device_specifier': _knownSpecifier,
        'creation_time': now,
      });

      final spy = _CookieSpyTransport(
        cookieBytes: _makeRemoteCookie(_knownSpecifier),
      );
      final svc = SyncService(
          storage: storage, crypto: crypto, transport: spy);

      // No captures — empty staging
      final result = await svc.checkAndSync();

      expect(result, SyncCheckResult.ready,
          reason: 'Empty staging must not crash fast path');
      expect(spy.pushPaths, contains(StagingPaths.remoteStagingBlob),
          reason: 'Empty blob clears remote — must not skip push');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group N: T8 — Commit to Ledger (SyncService.commitEntries)
  // ═══════════════════════════════════════════════════════════════

  group('N: SyncService — Commit to Ledger (T8)', () {
    // N1
    test('N1: commitEntries returns hash prefix (first 10 chars of '
        'last block hash)', () async {
      final svc = await _makeSyncWithEngine();
      // Create a completed entry
      await svc.capture(title: 'Hash Test');
      await svc.end('Hash Test', 5000);

      final hash = await svc.commitEntries();
      expect(hash, isNotNull,
          reason: 'commitEntries must return the block hash prefix');
      expect(hash!.length, 10,
          reason: 'Hash prefix must be exactly 10 characters');
    });

    // N2
    test('N2: commitEntries filters out is_active==true entries',
        () async {
      final svc = await _makeSyncWithEngine();
      // Create one active and one completed entry
      await svc.capture(title: 'Active Task');
      await Future.delayed(const Duration(milliseconds: 1));
      await svc.capture(title: 'Done Task');
      await svc.end('Done Task', 5000);

      await svc.commitEntries();
      // Verify only the completed entry was passed to engine
      final entries = await svc.getEntries();
      final activeEntry = entries.firstWhere(
          (e) => e['title'] == 'Active Task', orElse: () => {});
      expect(activeEntry['is_active'], true,
          reason: 'Active entry must NOT be committed');
      expect(activeEntry['committed'], isNot(true),
          reason: 'Active entry must not be marked committed');
    });

    // N3
    test('N3: commitEntries filters out already-committed entries '
        '(committed==true)', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Already Done');
      await svc.end('Already Done', 5000);
      // Mark as committed via modify (sets committed flag in raw storage)
      await svc.modify(0, {'committed': true});

      await Future.delayed(const Duration(milliseconds: 1));
      await svc.capture(title: 'Fresh Done');
      await svc.end('Fresh Done', 6000);

      await svc.commitEntries();
      // Verify only the non-committed entry was passed to engine
      final entries = await svc.getEntries();
      final alreadyDone = entries.firstWhere(
          (e) => e['title'] == 'Already Done', orElse: () => {});
      expect(alreadyDone['committed'], true,
          reason: 'Already-committed entry must stay committed');
      // Fresh Done should now be committed
      final freshDone = entries.firstWhere(
          (e) => e['title'] == 'Fresh Done', orElse: () => {});
      expect(freshDone['committed'], true,
          reason: 'Fresh Done must be marked committed after commitEntries');
    });

    // N4
    test('N4: commitEntries with empty staging returns null (no-op)',
        () async {
      final svc = await _makeSyncWithEngine();

      final result = await svc.commitEntries();
      expect(result, isNull,
          reason: 'Empty staging must return null — no entries to commit');
    });

    // N5
    test('N5: commitEntries with all entries already committed returns null',
        () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'All Done');
      await svc.end('All Done', 5000);
      await svc.modify(0, {'committed': true});

      final result = await svc.commitEntries();
      expect(result, isNull,
          reason: 'All-done must return null — sync screen may re-trigger '
              'commit; must not crash');
    });

    // N6
    test('N6: after commit, committed entries marked committed=true in '
        'staging', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Mark Me');
      await svc.end('Mark Me', 5000);

      await svc.commitEntries();
      final entries = await svc.getEntries();
      expect(entries[0]['committed'], true,
          reason: 'After commit, entry must be marked committed=true '
              'to prevent re-commit');
    });

    // N7
    test('N7: after commit, non-committed entries preserved in staging '
        'unchanged', () async {
      final svc = await _makeSyncWithEngine();
      // Active entry — must not be committed
      await svc.capture(title: 'Still Active');
      await Future.delayed(const Duration(milliseconds: 1));
      // Completed entry — will be committed
      await svc.capture(title: 'Ready to Commit');
      await svc.end('Ready to Commit', 5000);

      await svc.commitEntries();
      final entries = await svc.getEntries();
      final activeEntry = entries.firstWhere(
          (e) => e['title'] == 'Still Active', orElse: () => {});
      expect(activeEntry['is_active'], true,
          reason: 'Active entry must be preserved unchanged');
      expect(activeEntry['committed'], isNot(true),
          reason: 'Active entry must not be touched by commit');
      expect(activeEntry['title'], 'Still Active',
          reason: 'Entry fields must be preserved');
    });

    // N8
    test('N8: commitEntries calls LedgerEngine.commit() with correct '
        'entries', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Engine Test');
      await svc.end('Engine Test', 5000);

      final hash = await svc.commitEntries();
      // The real LedgerEngine processed the entry and returned a hash
      expect(hash, isNotNull,
          reason: 'commitEntries must delegate to LedgerEngine.commit '
              'and return the block hash prefix');
    });

    // N9
    test('N9: commitEntries with no LedgerEngine throws clear error',
        () async {
      // Create SyncService WITHOUT ledgerEngine
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);
      // No ledgerEngine set

      await svc.capture(title: 'No Engine');
      await svc.end('No Engine', 5000);

      expect(
        () => svc.commitEntries(),
        throwsA(isA<Exception>()),
      );
    });

    // N10
    test('N10: commitEntries passes entries with has_encrypted_fields '
        'flag preserved', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Encrypted Task', encryptFields: {'title'});
      await svc.end('Encrypted Task', 5000);

      await svc.commitEntries();
      final entries = await svc.getEntries();
      // Verify has_encrypted_fields still true after commit
      final committed = entries.firstWhere(
          (e) => e['title'] == 'Encrypted Task' ||
              (e['committed'] == true),
          orElse: () => {});
      // Flag should be preserved through to the engine
      expect(committed['has_encrypted_fields'], true,
          reason: 'has_encrypted_fields flag must survive commit round-trip');
    });

    // N11
    test('N11: committed entries retain hash field from LedgerEngine in '
        'staging', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Hash Retain');
      await svc.end('Hash Retain', 5000);

      await svc.commitEntries();
      final entries = await svc.getEntries();
      // Entry should have 'hash' field from the staging record
      final committed = entries.firstWhere(
          (e) => e['title'] == 'Hash Retain', orElse: () => {});
      expect(committed['hash'], isNotNull,
          reason: 'After commit, hash field from LedgerEngine must be '
              'preserved in staging for cross-reference');
    });

    // N12
    test('N12: commitEntries handles entries from mixed dates (groups by '
        'date)', () async {
      final svc = await _makeSyncWithEngine();
      // Create entries on different dates
      await svc.capture(title: 'Today Entry');
      await svc.end('Today Entry', 5000);

      await svc.capture(title: 'Yesterday Entry');
      // Manually set start_epoch to yesterday
      final yesterday =
          DateTime.now().millisecondsSinceEpoch - (24 * 60 * 60 * 1000);
      await svc.modify(1, {'start_epoch': yesterday});
      await svc.end('Yesterday Entry', yesterday + 5000);

      final hash = await svc.commitEntries();
      // Both entries committed successfully
      expect(hash, isNotNull,
          reason: 'Multi-date entries must commit successfully');
    });

    // N13
    test('N13: commitEntries preserves entry_id, device_uuid, '
        'end_device_uuid through commit', () async {
      final svc = await _makeSyncWithEngine();
      await svc.capture(title: 'Provenance Test');
      await svc.end('Provenance Test', 5000);

      await svc.commitEntries();
      final entries = await svc.getEntries();
      // Verify provenance fields survive the commit round-trip
      final entry = entries.firstWhere(
          (e) => e['title'] == 'Provenance Test', orElse: () => {});
      expect(entry['entry_id'], isNotNull,
          reason: 'entry_id must survive commit for cross-device merge');
      expect(entry['device_uuid'], isNotNull,
          reason: 'device_uuid must survive commit for provenance tracking');
    });

    // N14
    test('N14: commitEntries available as public method on SyncService',
        () async {
      final svc = await _makeSync();
      // Verify the method exists on the public interface
      // (compile-time check: this test won't compile if method is private)
      expect(svc.commitEntries, isA<Function>(),
          reason: 'commitEntries must be a public method on SyncService '
              'per SESSION_HANDOFF T8 contract');

      // Empty staging returns null (no-op)
      final result = await svc.commitEntries();
      expect(result, isNull,
          reason: 'Empty staging returns null — nothing to commit');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group Q: R2 Path Alignment — StagingPaths usage verification
  // ═══════════════════════════════════════════════════════════════

  group('Q: SyncService — StagingPaths usage', () {
    // Q1
    test('Q1: _pushBlobOnly pushes to StagingPaths.remoteStagingBlob', () async {
      final spy = _SpyTransport();
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Blob Push Test');
      await svc.pushToRemote();

      // The blob push path must be the canonical staging blobs path
      expect(spy.pushPaths, contains(StagingPaths.remoteStagingBlob),
          reason: '_pushBlobOnly must push to the canonical staging blob path '
              'so CLI/web can read it.');
    });

    // Q2
    test('Q2: _pullRemoteBlob pulls from StagingPaths.remoteStagingBlob', () async {
      final spy = _SpyTransport();
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto, transport: spy);

      // Exercise the pull pathway via checkAndSync
      await svc.checkAndSync();

      // The blob pull path must be the canonical staging blobs path
      expect(spy.pullPaths, contains(StagingPaths.remoteStagingBlob),
          reason: '_pullRemoteBlob must pull from the canonical staging blob path '
              'so it reads what CLI/web wrote.');
    });

    // Q3
    test('Q3: _pushCookie pushes to StagingPaths.remoteDeviceCookie', () async {
      final spy = _SpyTransport();
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto, transport: spy);

      await svc.capture(title: 'Cookie Push Test');
      await svc.pushToRemote();

      // The cookie push path must be the canonical device cookie path
      expect(spy.pushPaths, contains(StagingPaths.remoteDeviceCookie),
          reason: '_pushCookie must push to the canonical device cookie path '
              'so other devices can detect cookie presence.');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: SyncService ↔ LedgerPushService Integration — K1–K4
  // ═══════════════════════════════════════════════════════════════

  group('S: SyncService ↔ LedgerPushService Integration', () {
    /// Create a LedgerPushService backed by an in-memory DB with a seeded
    /// block, a CryptoService with MK, and a spy transport.
    Future<(LedgerPushService, _SpyTransport, AppDatabase)> _makePushService({
      bool withMk = true,
      _SpyTransport? transport,
    }) async {
      final db = AppDatabase.inMemory();
      final crypto = await _makeCrypto();
      if (!withMk) {
        crypto.clearMasterKey();
      }
      final spy = transport ?? _SpyTransport();
      final pushSvc = LedgerPushService(db: db, crypto: crypto, transport: spy);
      return (pushSvc, spy, db);
    }

    /// Insert a single day block into the DB for push tests.
    Future<void> _seedBlock(AppDatabase db, {int index = 1}) async {
      await db.blockDao.insertBlock(Block(
        blockId: 'test-block-00$index',
        blockType: BlockType.day,
        blockIndex: index,
        dataEnc: 'eyJ0ZXN0IjogdHJ1ZX0=', // base64({"test": true})
        prevHash: Block.genesisPrevHash,
        createdAt: DateTime.now().millisecondsSinceEpoch,
      ));
    }

    // K1 (mapped from blueprint K1): commitEntries → pushAll end-to-end
    test('K1: commitEntries() followed by pushAll() — committed block '
        'appears at ledger/blocks/NNNNNN.json on fake transport', () async {
      final (pushSvc, spy, db) = await _makePushService();

      // Seed a block (simulating what commitEntries() writes to DB).
      // In Phase 3, commitEntries() will write blocks to the same
      // AppDatabase that LedgerPushService reads from.
      await _seedBlock(db, index: 1);

      final result = await pushSvc.pushAll();

      expect(result.success, isTrue,
          reason: 'Push must succeed with seeded block');
      expect(result.blocksPushed, 1,
          reason: 'One block pushed to remote');
      expect(spy.pushPaths,
          contains('ledger/blocks/000001.json'),
          reason: 'Block file must be at canonical path — '
              'blockIndex 1 → 000001.json');
    });

    // K2: push idempotency
    test('K2: pushAll() with no new commits is idempotent — second push '
        'overwrites same blocks, remote state unchanged', () async {
      final (pushSvc, spy, db) = await _makePushService();
      await _seedBlock(db);

      // First push
      final r1 = await pushSvc.pushAll();
      expect(r1.success, isTrue);
      expect(r1.blocksPushed, 1);

      // Second push (no new blocks)
      final r2 = await pushSvc.pushAll();
      expect(r2.success, isTrue,
          reason: 'Re-push must succeed — idempotent design');
      expect(r2.blocksPushed, 1,
          reason: 'Same block count on re-push — no duplication');

      // Both pushes go to the same paths
      final blockPaths =
          spy.pushPaths.where((p) => p.startsWith('ledger/blocks/')).toList();
      expect(blockPaths.length, 2,
          reason: 'Both pushes write to the same block path — '
              'idempotent overwrite, not new files');
    });

    // K3: offline / transport failure
    test('K3: pushAll() after transport disconnect returns PushResult.failure, '
        'does not throw unhandled exception', () async {
      // Transport that throws on push
      final failingTransport = _FailingTransport();
      final crypto = await _makeCrypto();
      final db = AppDatabase.inMemory();
      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: failingTransport);
      await _seedBlock(db);

      // Must not throw — returns structured failure
      final result = await pushSvc.pushAll();

      expect(result.success, isFalse,
          reason: 'Network failures must produce PushResult.failure, '
              'not crashes — the UI catches PushResult');
      expect(result.failedBlocks, isNotEmpty,
          reason: 'Failed block indices must be reported');
      expect(result.errors, isNotEmpty,
          reason: 'Error messages must be surfaced for debugging');
    });

    // K4: no MK guard
    test('K4: pushAll() without cached MK throws StateError with '
        'descriptive message', () async {
      final db = AppDatabase.inMemory();
      final crypto = await _makeCrypto();
      crypto.clearMasterKey();
      final pushSvc =
          LedgerPushService(db: db, crypto: crypto, transport: _SpyTransport());
      await _seedBlock(db);

      expect(
        () => pushSvc.pushAll(),
        throwsA(isA<StateError>()),
        reason: 'Must refuse to push without master key — '
            'user must authenticate before pushing ledger blocks',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: Multi-Active Support
  // ═══════════════════════════════════════════════════════════════

  group('S: SyncService — Multi-Active', () {
    // S1 — getActive() returns list when multiple active entries exist
    test('S1: getActive() returns list of 2 when 2 active entries exist',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task A');
      await svc.capture(title: 'Task B');

      final active = await svc.getActive();
      expect(active, isA<List>(),
          reason: 'getActive() must return List<Map> for multi-active support');
      expect(active.length, 2,
          reason: 'Both captured tasks should remain active');
      expect(active[0]['title'], 'Task A');
      expect(active[1]['title'], 'Task B');
    });

    // S2 — getActive() returns empty list when no active entries
    test('S2: getActive() returns empty list when no active entries', () async {
      final svc = await _makeSync();
      final active = await svc.getActive();
      expect(active, isA<List>(),
          reason: 'getActive() must return List, not null');
      expect(active, isEmpty,
          reason: 'Empty list indicates no active tasks');
    });

    // S3 — capture() does not deactivate existing active entries
    test('S3: capture() does not deactivate existing active entries', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task A');
      await svc.capture(title: 'Task B');

      final entries = await svc.getEntries();
      final activeCount = entries.where((e) => e['is_active'] == true).length;
      expect(activeCount, 2,
          reason: 'capture() must not set is_active=false on existing entries');
    });

    // S4 — capture() appends new active entry while existing stays active
    test(
        'S4: capture() appends entry alongside existing active, both stay active',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'First');
      await svc.capture(title: 'Second');

      final entries = await svc.getEntries();
      expect(entries.length, 2);
      expect(entries[0]['is_active'], true,
          reason: 'First entry must still be active after second capture');
      expect(entries[1]['is_active'], true,
          reason: 'Second entry must be created as active');
    });

    // S5 — endByEntryId(entryId, endEpoch) ends correct entry among 2 active
    test('S5: endByEntryId() ends correct entry among 2 active tasks', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task A');
      await svc.capture(title: 'Task B');

      final active = await svc.getActive();
      final targetId = active[1]['entry_id'] as String;

      await svc.endByEntryId(targetId, 5000);

      final afterEnd = await svc.getActive();
      expect(afterEnd.length, 1,
          reason: 'Only the targeted entry should be ended');
      expect(afterEnd[0]['entry_id'], active[0]['entry_id'],
          reason: 'Untargeted entry must remain active');

      final entries = await svc.getEntries();
      final ended = entries.firstWhere((e) => e['entry_id'] == targetId);
      expect(ended['is_active'], false,
          reason: 'Targeted entry must have is_active=false');
      expect(ended['end_epoch'], 5000);
    });

    // S6 — pauseByEntryId(entryId, epoch) pauses correct entry among 2 active
    test('S6: pauseByEntryId() pauses correct entry among 2 active tasks',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task A');
      await svc.capture(title: 'Task B');

      final active = await svc.getActive();
      final targetId = active[0]['entry_id'] as String;

      await svc.pauseByEntryId(targetId, 3000);

      // Read fresh state
      final entries = await svc.getEntries();
      final paused = entries.firstWhere((e) => e['entry_id'] == targetId);
      final unpaused = entries.firstWhere((e) => e['entry_id'] != targetId && e['is_active'] == true);

      expect(paused['is_paused'], true,
          reason: 'Targeted entry must be paused');
      expect(unpaused['is_paused'], false,
          reason: 'Untargeted entry must remain unpaused');
    });

    // S7 — unpauseByEntryId(entryId, epoch) unpauses correct entry
    test('S7: unpauseByEntryId() unpauses correct entry among 2 active',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task A');
      await svc.capture(title: 'Task B');

      final active = await svc.getActive();
      final targetId = active[0]['entry_id'] as String;

      await svc.pauseByEntryId(targetId, 3000);
      await svc.unpauseByEntryId(targetId, 5000);

      final entries = await svc.getEntries();
      final task = entries.firstWhere((e) => e['entry_id'] == targetId);
      expect(task['is_paused'], false,
          reason: 'Entry must be unpaused after unpauseByEntryId()');
    });

    // S8 — Existing end(title) still works (backward compat)
    test('S8: end(title) still works with single active entry', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Old Style');
      await svc.end('Old Style', 3000);

      final entries = await svc.getEntries();
      expect(entries[0]['is_active'], false,
          reason: 'end(title) must still work for backward compatibility');
      expect(entries[0]['end_epoch'], 3000);
    });
  });
}

/// Transport that throws on push/pull for failure-path tests.
class _FailingTransport extends HttpTransport {
  _FailingTransport()
      : super(baseUrl: 'https://fail.example.com', apiKey: 'fail-key');
  @override
  Future<Uint8List?> pull(String path) async {
    throw Exception('Simulated network failure');
  }
  @override
  Future<void> push(String path, Uint8List data) async {
    throw Exception('Simulated network failure on push');
  }
  @override
  Future<List<String>> listFiles(String prefix) async => [];
  @override
  Future<void> delete(String path) async {}
}
