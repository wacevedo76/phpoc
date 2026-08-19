import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// Regression test: deleting a staged entry must not be resurrected by the
/// next remote reconcile.
///
/// Bug observed on-device: an ended staging row deleted via `sync.remove`
/// came right back. Because a delete only removed the LOCAL row — it never
/// removed the entry from the remote `staging/blob` — the next
/// `_reconcileAndClaimRowLevel` pulled the stale remote row and re-inserted
/// it (mergeEntries treats a remote-only row as authoritative).
///
/// Fix: `remove` must also drop the entry from the remote blob (tombstone
/// push) so a subsequent reconcile converges to "deleted" instead of
/// resurrecting the row.

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
}


/// Transport backed by an in-memory remote blob store that round-trips the
/// obfuscated `staging/blob` bytes — real pull/merge/push semantics.
class _MemoryTransport extends HttpTransport {
  final Map<String, Uint8List> remote = {};
  final List<String> pushedPaths = [];

  _MemoryTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  @override
  Future<void> push(String path, Uint8List data) async {
    pushedPaths.add(path);
    remote[path] = data;
  }

  @override
  Future<Uint8List?> pull(String path) async => remote[path];

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async => remote.remove(path);
}

Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

Future<({SyncService sync, _MemoryTransport transport, CryptoService crypto})>
    _make() async {
  final database = AppDatabase.inMemory();
  final store = StagingStore(database);
  final storage = _FakeStorage();
  final crypto = await _makeCrypto();
  final transport = _MemoryTransport();
  final sync = SyncService(
    storage: storage,
    crypto: crypto,
    transport: transport,
    stagingStore: store,
  );
  return (sync: sync, transport: transport, crypto: crypto);
}

/// Decode the remote blob's `entries` so a test can assert on remote state.
Future<List<Map<String, dynamic>>> _remoteEntries({
  required _MemoryTransport transport,
  required CryptoService crypto,
}) async {
  final blob = transport.remote['staging/blob'];
  if (blob == null) return [];
  final s = crypto.deobfuscateBlob(blob, crypto.getMasterKey()!);
  final parsed = jsonDecode(s) as Map<String, dynamic>;
  return (parsed['entries'] as List<dynamic>).cast<Map<String, dynamic>>();
}

/// Build a SyncService wired to a real [LedgerEngine] + a real in-memory
/// transport, mirroring the production app (commit is a ledger move).
Future<({SyncService sync, _MemoryTransport transport, CryptoService crypto, StagingStore store})>
    _makeWithLedger() async {
  final database = AppDatabase.inMemory();
  final store = StagingStore(database);
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
  final transport = _MemoryTransport();
  final sync = SyncService(
    storage: storage,
    crypto: crypto,
    transport: transport,
    stagingStore: store,
    ledgerEngine: engine,
    ledgerPush: LedgerPushService(
      db: database,
      crypto: crypto,
      transport: transport,
    ),
  );
  return (sync: sync, transport: transport, crypto: crypto, store: store);
}

void main() {
  group('delete/resurrect', () {
    test(
      'RED/GREEN: a deleted staged entry stays deleted after a remote '
      'reconcile (delete must propagate to remote blob)',
      () async {
        final (
          :sync,
          :transport,
          :crypto,
        ) = await _make();

        // Seed a local ended staging row, then push it to remote (this is
        // exactly the state the real device was in: remote holds the row).
        final deviceUuid = '430987b3-bedf-426c-8ab2-a94bb3413586';
        final id = await sync.capture(
          title: 'Push-ups',
          startEpoch: 1787039242029,
        );
        await sync.end(id, 1787039243645);
        // Assign the same device_uuid the remote entry carried.
        final store = sync.stagingStore;
        final row = (await store.getAllRows()).firstWhere((r) =>
            r['activity_id'] == id);
        final activity = jsonDecode(row['activity'] as String)
            as Map<String, dynamic>;
        activity['device_uuid'] = deviceUuid;
        activity['end_device_uuid'] = deviceUuid;
        await store.putRow({...row, 'activity': jsonEncode(activity)});

        // Push the real ended row to the remote blob.
        await sync.pushToRemote();

        // Remote now hosts the row (as observed on device).
        final remoteBefore = await _remoteEntries(
          transport: transport,
          crypto: crypto,
        );
        expect(remoteBefore.any((r) => r['activity_id'] == id), isTrue,
            reason: 'precondition: remote blob holds the staged row');

        // User deletes it on the entry screen.
        await sync.remove(id);

        // Local is clean.
        final localAfterRemove = await store.getAllRows();
        expect(localAfterRemove.any((r) => r['activity_id'] == id), isFalse,
            reason: 'delete removed the local row');

        // The debounced auto-sync fires a reconcile (no cookie in test →
        // goes straight to _reconcileAndClaimRowLevel). Without the fix this
        // resurrects the row from the stale remote blob.
        await sync.checkAndSync();

        // Deleted entry must NOT come back.
        final localAfterSync = await sync.getEntries();
        expect(localAfterSync.any((r) => r['activity_id'] == id), isFalse,
            reason: 'deleted entry resurrected by reconcile (BUG)');

        // Remote must also be free of the deleted entry.
        final remoteAfter = await _remoteEntries(
          transport: transport,
          crypto: crypto,
        );
        expect(remoteAfter.any((r) => r['activity_id'] == id), isFalse,
            reason: 'deleted entry must be dropped from the remote blob');
      },
    );

    // REPLICA of the on-device symptom: delete one entry, then commit OTHER
    // ended entries to the ledger, then reconcile. The deleted entry must NOT
    // come back ready-to-commit (the remote blob must not silently re-seed it
    // back into local staging during the commit flow's later reconcile).
    test(
      'RED/GREEN: delete survives an intervening commit + reconcile '
      '(no resurrection after commit to local ledger)',
      () async {
        final (:sync, :transport, :crypto, :store) = await _makeWithLedger();

        // Two ended scratchpad rows live on the remote (the state the user's
        // device was in): one the user wants to DELETE, one they will COMMIT.
        final toDelete = await sync.capture(title: 'Push-ups', startEpoch: 1787039242029);
        await sync.end(toDelete, 1787039243645);
        final toCommit = await sync.capture(title: 'Workout', startEpoch: 1787039242029);
        await sync.end(toCommit, 1787039244000);

        // Remote blob holds both (pre-fix stale state observed live).
        await sync.pushToRemote();
        final remoteBefore = await _remoteEntries(
          transport: transport,
          crypto: crypto,
        );
        expect(remoteBefore.any((r) => r['activity_id'] == toDelete), isTrue);
        expect(remoteBefore.any((r) => r['activity_id'] == toCommit), isTrue);

        // 1) User deletes one entry on the entry screen.
        await sync.remove(toDelete);
        expect((await store.getAllRows()).any((r) => r['activity_id'] == toDelete), isFalse,
            reason: 'delete removed the local row');

        // 2) User commits the OTHER ended entry to the local ledger (a move).
        await sync.commitAndSync();

        // 3) A reconcile runs (periodic / debounced auto-sync after commit).
        await sync.checkAndSync();

        // The deleted entry must stay deleted locally.
        final localAfter = await sync.getEntries();
        expect(localAfter.any((r) => r['activity_id'] == toDelete), isFalse,
            reason: 'deleted entry resurrected by commit flow + reconcile (BUG)');

        // Remote must be free of the deleted entry too.
        final remoteAfter = await _remoteEntries(
          transport: transport,
          crypto: crypto,
        );
        expect(remoteAfter.any((r) => r['activity_id'] == toDelete), isFalse,
            reason: 'deleted entry must be dropped from the remote blob');
      },
    );
  });
}
