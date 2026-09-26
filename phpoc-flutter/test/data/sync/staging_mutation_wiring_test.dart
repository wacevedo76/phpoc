import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_hash.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// Staging Mutation Wiring — ADR-034 P2 (Flutter side, Groups F/H).
///
/// Phase 2 (RED). Locks in the mutation-flow contract for Flutter:
///   F18  pushToRemote() remote cookie staging_hash == canonical hash (I3)
///   F19  the pushed blob's entries hash to the cookie's staging_hash (I3)
///   F20  hash input == the row set actually pushed (activity.committed-only
///        rows are excluded from BOTH push and hash — committed-filter parity)
///   F21  local cookie updated (last_seen_hash/last_seen_seq, keep specifier)
///   F22  remote cookie seq = nextSeq(last_seen_seq): absent → 1, N → N+1
///   F23  blob pushed before remote cookie (I3 ordering)
///   F24  offline blob-push failure → local mutation + local-cookie update
///        persist, no unhandled error escapes (I7 fail-open)
///   H4   device_specifier reused across pushes; fresh 32-hex specifier +
///        canonical staging_hash + seq >= 1 on a fresh reconcileAndClaim (I5)
///
/// Hash input = the canonical non-committed rows that were pushed. Staging
/// store rows carry extra fields (title/start_epoch/duration/...) merged back
/// by _rowToMap, so every hash here is computed over a 5-field canonical
/// projection {activity_id, activity_status, activity, updated_at, committed}
/// — matching dtoToCanonicalRow / computeStagingHash parity (I2).
///
/// Private SyncService symbols are library-private, so this file drives only
/// public APIs: pushToRemote(), reconcileAndClaim().
///
/// Run: flutter test test/data/sync/staging_mutation_wiring_test.dart

// ═══════════════════════════════════════════════════════════════════
// Canonical-row helpers (mirror SyncService._rowIsCommitted semantics)
// ═══════════════════════════════════════════════════════════════════

/// Reproduce `SyncService._rowIsCommitted`: committed when the row-level
/// `committed` flag OR the `committed` field inside the activity blob is true.
bool _rowIsCommitted(Map<String, dynamic> row) {
  if (row['committed'] == true) return true;
  try {
    final activity = json.decode(row['activity'] as String? ?? '{}');
    if (activity is Map && activity['committed'] == true) return true;
  } catch (_) {}
  return false;
}

/// Project a stored row (with extras) down to the 5-field canonical form
/// that computeStagingHash expects.
Map<String, dynamic> _canonicalRow(Map<String, dynamic> row) => {
      'activity_id': row['activity_id'],
      'activity_status': row['activity_status'],
      'activity': row['activity'],
      'updated_at': row['updated_at'],
      'committed': row['committed'] == true,
    };

/// Hash a list of rows after projecting to canonical form. Callers are
/// responsible for pre-filtering committed rows when the intended set is
/// the "pushed" set (computeStagingHash only checks the top-level flag).
String _hashRows(List<Map<String, dynamic>> rows) =>
    computeStagingHash(rows.map(_canonicalRow).toList());

// ═══════════════════════════════════════════════════════════════════
// Test Infrastructure (replicated — library-private symbols are not
// importable across files)
// ═══════════════════════════════════════════════════════════════════

class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Configurable transport spy recording blob/cookie push ordering.
class _ConfigTransport extends HttpTransport {
  final List<String> pushPaths = [];
  final List<Uint8List> pushData = [];
  final List<String> pushOrder = []; // 'blob' | 'cookie' only
  bool _throwOnPush = false;

  _ConfigTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  void setThrowOnPush(bool value) => _throwOnPush = value;

  @override
  Future<Uint8List?> pull(String path) async => null; // default: 404

  @override
  Future<void> push(String path, Uint8List data) async {
    if (_throwOnPush) throw Exception('offline');
    pushPaths.add(path);
    pushData.add(data);
    if (path == StagingPaths.remoteRowLevelBlob) {
      pushOrder.add('blob');
    } else if (path == StagingPaths.remoteDeviceCookie) {
      pushOrder.add('cookie');
    }
  }

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

const _mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const _knownSpecifier = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(_mk);
  return crypto;
}

class _Harness {
  final SyncService svc;
  final StagingStore stagingStore;
  final _FakeStorage storage;
  final _ConfigTransport transport;
  final AppDatabase db;
  final CryptoService crypto;

  _Harness(this.svc, this.stagingStore, this.storage, this.transport, this.db,
      this.crypto);

  Future<void> addRow({
    required String activityId,
    required String status,
    int updatedAt = 1000,
    String title = 'Test Task',
    bool committed = false,
    bool activityCommitted = false,
  }) async {
    final activity = <String, dynamic>{
      'title': title,
      'start_epoch': 1000,
      'duration': 0,
      'is_active': status == 'active',
      'is_paused': status == 'paused',
      'pauses': <dynamic>[],
      'tags': <dynamic>[],
      'device_uuid': 'test-device',
    };
    if (activityCommitted) activity['committed'] = true;
    await stagingStore.putRow({
      'activity_id': activityId,
      'activity_status': status,
      'activity': json.encode(activity),
      'updated_at': updatedAt,
      'committed': committed,
      'title': title,
      'start_epoch': 1000,
      'duration': 0,
    }, preserveUpdatedAt: true);
  }

  Future<void> seedLocalCookie(String specifier,
      {int? lastSeenSeq, String? lastSeenHash}) async {
    await storage.set('cookie', {
      'device_specifier': specifier,
      'creation_time': DateTime.now().millisecondsSinceEpoch,
      if (lastSeenSeq != null) 'last_seen_seq': lastSeenSeq,
      if (lastSeenHash != null) 'last_seen_hash': lastSeenHash,
    });
  }

  /// The last remote cookie pushed (or null if none was pushed).
  Future<Map<String, dynamic>?> remoteCookie() async {
    final idx = transport.pushPaths.lastIndexOf(StagingPaths.remoteDeviceCookie);
    if (idx < 0) return null;
    final raw = transport.pushData[idx];
    return json.decode(utf8.decode(raw)) as Map<String, dynamic>;
  }

  /// Entries of the first pushed row-level blob (deobfuscated).
  Future<List<Map<String, dynamic>>> pushedBlobEntries() async {
    final idx = transport.pushPaths.indexOf(StagingPaths.remoteRowLevelBlob);
    if (idx < 0) return [];
    final blob = transport.pushData[idx];
    final jsonStr = crypto.deobfuscateBlob(blob, _mk);
    final decoded = json.decode(jsonStr) as Map<String, dynamic>;
    return (decoded['entries'] as List)
        .map((e) => Map<String, dynamic>.from(e as Map))
        .toList();
  }

  /// Canonical hash over the _rowIsCommitted-filtered row set (the pushed set).
  Future<String> canonicalHash() async {
    final rows = await stagingStore.getAllRows();
    final active = rows.where((r) => !_rowIsCommitted(r)).toList();
    return _hashRows(active);
  }

  Future<void> close() async {
    svc.dispose();
    await db.close();
  }
}

Future<_Harness> _makeHarness({
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
    await storage.set('cookie', {
      'device_specifier': _knownSpecifier,
      'creation_time': DateTime.now().millisecondsSinceEpoch,
    });
  }

  final svc = SyncService(
    storage: storage,
    crypto: c,
    transport: t,
    stagingStore: stagingStore,
  );

  return _Harness(svc, stagingStore, storage, t, db, c);
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

void main() {
  group('F-Flutter: Mutation flow (ADR-034 P2)', () {
    test('F18: pushToRemote sets remote cookie staging_hash to canonical hash',
        () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');
      final expected = await h.canonicalHash();

      await h.svc.pushToRemote();

      final cookie = await h.remoteCookie();
      expect(cookie, isNotNull, reason: 'F18 remote cookie was pushed');
      expect(cookie!['staging_hash'], expected,
          reason: 'F18 staging_hash equals canonical hash');
      await h.close();
    });

    test('F19: pushed blob entries hash to the cookie staging_hash (I3)',
        () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');

      await h.svc.pushToRemote();

      final cookie = await h.remoteCookie();
      expect(cookie, isNotNull, reason: 'F19 remote cookie was pushed');
      final blobEntries = await h.pushedBlobEntries();
      expect(blobEntries, isNotEmpty, reason: 'F19 a blob was pushed');
      expect(cookie!['staging_hash'], _hashRows(blobEntries),
          reason: 'F19 cookie hash equals hash of the pushed blob');
      await h.close();
    });

    test('F20: hash input matches pushed rows (activity.committed-only row '
        'excluded)', () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');
      await h.addRow(
          activityId: 'task-b', status: 'active', activityCommitted: true);

      await h.svc.pushToRemote();

      final cookie = await h.remoteCookie();
      expect(cookie, isNotNull, reason: 'F20 remote cookie was pushed');

      final expected = await h.canonicalHash();
      expect(cookie!['staging_hash'], expected,
          reason: 'F20 hash excludes the activity.committed-only row (task-b)');

      // A naive hash over ALL rows (without the activity.committed filter)
      // must differ — task-b is hashed but must not be pushed.
      final allRows = await h.stagingStore.getAllRows();
      expect(cookie['staging_hash'], isNot(_hashRows(allRows)),
          reason: 'F20 hash must not include task-b (hashed-but-not-pushed)');
      await h.close();
    });

    test('F21: pushToRemote updates local cookie (hash+seq) and keeps specifier',
        () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');
      await h.seedLocalCookie('keep-me', lastSeenSeq: 4);
      final expected = await h.canonicalHash();

      await h.svc.pushToRemote();

      final local = await h.storage.get('cookie') as Map;
      expect(local['device_specifier'], 'keep-me',
          reason: 'F21 keeps device_specifier');
      expect(local['last_seen_hash'], expected,
          reason: 'F21 local last_seen_hash set');
      expect(local['last_seen_seq'], 5,
          reason: 'F21 local last_seen_seq refreshed to the pushed seq');
      await h.close();
    });

    test('F22: remote cookie seq = nextSeq(last_seen_seq): absent → 1, N → N+1',
        () async {
      // absent last_seen_seq → 1
      {
        final h = await _makeHarness();
        await h.addRow(activityId: 'task-a', status: 'active');
        await h.svc.pushToRemote();
        final cookie = await h.remoteCookie();
        expect(cookie, isNotNull, reason: 'F22 remote cookie was pushed');
        expect(cookie!['seq'], 1, reason: 'F22 absent last_seen_seq → seq 1');
        await h.close();
      }
      // last_seen_seq = 5 → 6
      {
        final h = await _makeHarness();
        await h.addRow(activityId: 'task-a', status: 'active');
        await h.seedLocalCookie('s1', lastSeenSeq: 5);
        await h.svc.pushToRemote();
        final cookie = await h.remoteCookie();
        expect(cookie, isNotNull, reason: 'F22 remote cookie was pushed');
        expect(cookie!['seq'], 6, reason: 'F22 seq = last_seen_seq + 1');
        await h.close();
      }
    });

    test('F23: blob pushed before remote cookie (I3 ordering)', () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');

      await h.svc.pushToRemote();

      expect(h.transport.pushOrder, ['blob', 'cookie'],
          reason: 'F23 blob before cookie');
      await h.close();
    });

    test('F24: offline blob push → local mutation + local cookie persist, '
        'no unhandled error (I7)', () async {
      final h = await _makeHarness();
      await h.addRow(activityId: 'task-a', status: 'active');
      await h.seedLocalCookie('off-spec');
      h.transport.setThrowOnPush(true);

      Object? raised;
      try {
        await h.svc.pushToRemote();
      } catch (e) {
        raised = e;
      }
      expect(raised, isNull, reason: 'F24 no unhandled error escapes');

      final local = await h.storage.get('cookie') as Map;
      expect(local['device_specifier'], 'off-spec',
          reason: 'F24 local cookie keeps specifier');
      expect(local['last_seen_hash'], isA<String>(),
          reason: 'F24 local cookie updated before offline blob failure');
      expect((local['last_seen_hash'] as String).length, 64,
          reason: 'F24 last_seen_hash is a 64-hex digest');
      await h.close();
    });
  });

  group('H4: Specifier stability (I5)', () {
    test('H4: specifier reused across pushes; fresh claim regenerates with '
        'canonical hash + seq >= 1', () async {
      // Reuse sub-block: two pushes keep the same specifier.
      {
        final h = await _makeHarness();
        await h.addRow(activityId: 'task-a', status: 'active');
        await h.seedLocalCookie('stable-spec');

        await h.svc.pushToRemote();
        final c1 = await h.remoteCookie();
        expect(c1, isNotNull, reason: 'H4 first remote cookie pushed');

        await h.svc.pushToRemote();
        final c2 = await h.remoteCookie();
        expect(c2, isNotNull, reason: 'H4 second remote cookie pushed');
        expect(c2!['device_specifier'], 'stable-spec',
            reason: 'H4 specifier reused across pushes');
        expect(c2['device_specifier'], c1!['device_specifier'],
            reason: 'H4 both pushes carry the same specifier');
        await h.close();
      }

      // Fresh-claim sub-block: no local cookie → regenerate specifier and
      // stamp the remote cookie with canonical staging_hash + seq >= 1.
      {
        final h = await _makeHarness(seedCookie: false);
        await h.addRow(activityId: 'task-a', status: 'active');
        final expected = await h.canonicalHash();

        await h.svc.reconcileAndClaim();

        final cookie = await h.remoteCookie();
        expect(cookie, isNotNull, reason: 'H4 fresh-claim remote cookie pushed');
        expect(cookie!['device_specifier'], matches(RegExp(r'^[0-9a-f]{32}$')),
            reason: 'H4 fresh 32-hex device_specifier');
        expect(cookie['staging_hash'], expected,
            reason: 'H4 handoff staging_hash is canonical');
        expect(cookie['seq'] is int && cookie['seq'] >= 1, isTrue,
            reason: 'H4 handoff seq >= 1');
        await h.close();
      }
    });
  });
}
