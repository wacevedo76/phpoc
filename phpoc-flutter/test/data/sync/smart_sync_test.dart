import 'dart:convert' show json, utf8;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, computeEntryHash, computeContentHash;
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// Smart Sync Button — Phase 2 RED tests.
///
/// Blueprint: `docs/planning/flutter/SMART_SYNC_BUTTON_PHASE1.md`
/// (Groups A + C + D = 16 assertions).
///
/// RED in Phase 2: written against the Phase-3 target API (`smartSync`,
/// `SmartSyncOutcome`, `forceLocal`, `reconcileRemoteLedger`,
/// `ReconcileResult`) that does not exist yet. They fail on missing members
/// until Phase 3 implements them.

/// In-memory storage backing SyncService.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
  Map<String, dynamic>? readIndex() => _data['index'];
  void writeIndex(Map<String, dynamic>? data) => _data['index'] = data;
}

/// Transport backed by an in-memory remote blob store — real pull/merge/push
/// semantics with no HTTP.
class _MemoryTransport extends HttpTransport {
  final Map<String, Uint8List> remote = {};
  final List<String> pushedPaths = [];
  bool throwOnHealthCheck = false;
  int ledgerPushCount = 0;

  _MemoryTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  @override
  Future<void> push(String path, Uint8List data) async {
    pushedPaths.add(path);
    if (path.startsWith('ledger/')) ledgerPushCount++;
    remote[path] = data;
  }

  @override
  Future<Uint8List?> pull(String path) async => remote[path];

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async => remote.remove(path);

  @override
  Future<void> healthCheck() async {
    if (throwOnHealthCheck) {
      throw HttpTransportException('health check failed (offline)', 500);
    }
  }
}

/// A transport that refuses pushes under `ledger/` (to force pushFailed A8).
class _FailingLedgerPushTransport extends _MemoryTransport {
  @override
  Future<void> push(String path, Uint8List data) async {
    if (path.startsWith('ledger/')) {
      throw HttpTransportException('ledger push rejected', 500);
    }
    return super.push(path, data);
  }
}

Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

/// Build a `{hash, data}` entry map for a day block, mirroring production
/// `LedgerEngine._prepareEntries` so the resulting block passes `verify()`:
/// adds a `content_hash` over the canonical data and computes the entry hash
/// over the enriched map.
class _Harness {
  final AppDatabase db;
  final CryptoService crypto;
  final _MemoryTransport transport;
  final StagingStore store;
  final LedgerEngine engine;
  final SyncService sync;
  final LedgerPushService push;
  final LedgerPullService pull;

  _Harness._(this.db, this.crypto, this.transport, this.store, this.engine,
      this.sync, this.push, this.pull);

  /// Build a harness. [online] wires the transport health check.
  static Future<_Harness> build({bool online = true}) async {
    final crypto = await _makeCrypto();
    final db = AppDatabase.inMemory();
    final store = StagingStore(db);
    final transport = _MemoryTransport();
    transport.throwOnHealthCheck = !online;

    final engine = LedgerEngine(
      crypto: crypto,
      store: LedgerBlockStore(db.blockDao),
      indexStore: LedgerIndexStore(),
      stagingStore: store,
    );

    final backup = LedgerBackupService(db: db);
    final pull = LedgerPullService(
      db: db,
      crypto: crypto,
      transport: transport,
      backupService: backup,
      stagingStorage: StagingStorage(db),
      stagingStore: store,
    );
    final push = LedgerPushService(db: db, crypto: crypto, transport: transport);
    final sync = SyncService(
      storage: _FakeStorage(),
      crypto: crypto,
      transport: transport,
      stagingStore: store,
      ledgerEngine: engine,
      ledgerPull: pull,
      ledgerPush: push,
    );

    return _Harness._(db, crypto, transport, store, engine, sync, push, pull);
  }

  /// Append a genesis block onto the chain (needed before any day block).
  void genesis() {
    engine.chain.append(engine.chain.buildGenesisBlock(
      username: 'tester',
      email: 't@example.com',
      recoverySeedEnc: 'seed-enc',
      identityPubKey: 'pubkey',
      identitySecretEncFallback: 'secret-fallback',
    ));
  }

  /// Build a `{hash, data}` entry map for a day block, mirroring production
  /// `LedgerEngine._prepareEntries` so the resulting block passes `verify()`:
  /// adds a `content_hash` over the canonical data and computes the entry hash
  /// over the enriched map.
  Map<String, dynamic> _entry({required Map<String, dynamic> data}) {
    final enriched = Map<String, dynamic>.from(data);
    enriched['content_hash'] = computeContentHash(data, crypto);
    return {'hash': computeEntryHash(enriched), 'data': enriched};
  }

  /// Build + append a day block against [prevBlock], returning the block.
  Map<String, dynamic> dayBlock({
    required List<Map<String, dynamic>> entries,
    required Map<String, dynamic> prevBlock,
    required String dateStr,
  }) {
    final block = engine.chain.buildDayBlock(
      entries: entries,
      prevHash: prevBlock.isEmpty ? '0' * 64 : getBlockHash(prevBlock),
      dateStr: dateStr,
    );
    engine.chain.append(block);
    return block;
  }

  /// Add an ended staging row that `smartSync`/`commitAndSync` can seal.
  Future<void> addEndedRow({
    required String activityId,
    String title = 'Test Task',
    int startEpoch = 1700000000000,
  }) async {
    await store.putRow({
      'activity_id': activityId,
      'activity_status': 'ended',
      'activity': json.encode({
        'title': title,
        'start_epoch': startEpoch,
        'duration': 3600000,
        'is_active': false,
        'is_paused': false,
        'pauses': [],
        'tags': [],
        'committed': false,
      }),
      'updated_at': startEpoch,
      'committed': false,
      'title': title,
      'start_epoch': startEpoch,
      'duration': 3600000,
    }, preserveUpdatedAt: true);
  }

  /// Seed the remote transport ledger files from the given chain blocks,
  /// obfuscated with the shared MK (what a canonical remote device pushed).
  Future<void> seedRemoteFromBlocks(List<Map<String, dynamic>> blocks) async {
    final mk = crypto.getMasterKey()!;
    final hashes = blocks.map(getBlockHash).toList();
    for (var i = 0; i < blocks.length; i++) {
      final obfuscated = crypto.obfuscateBlob(json.encode(blocks[i]), mk);
      transport.remote['ledger/blocks/${i.toString().padLeft(6, '0')}.json'] =
          obfuscated;
    }
    transport.remote['ledger/hash_index.json'] =
        Uint8List.fromList(utf8.encode(json.encode(hashes)));
  }

  /// Seed ONLY the remote transport ledger files (no local chain changes).
  Future<void> seedRemoteOnly(List<Map<String, dynamic>> blocks) =>
      seedRemoteFromBlocks(blocks);

  List<Map<String, dynamic>> localBlocks() => engine.getAllBlocks();

  Future<void> close() async {
    sync.dispose();
    await db.close();
  }
}

void main() {
  group('A: smartSync orchestration', () {
    test(
      'A1: unconfigured (no transport) → committedLocal, no pull/push',
      () async {
        final h = await _Harness.build();
        final sync = SyncService(
          storage: _FakeStorage(),
          crypto: h.crypto,
          stagingStore: h.store,
          ledgerEngine: h.engine,
        );
        await h.addEndedRow(activityId: 'A1id0001', title: 'Laundry');

        final outcome = await sync.smartSync();

        expect(outcome, SmartSyncOutcome.committedLocal,
            reason: 'unconfigured device falls back to a local commit');
        final rows = await h.store.getAllRows();
        expect(rows.any((r) => r['committed'] == true), isTrue,
            reason: 'local commit must mark the row committed');
        expect(h.transport.pushedPaths, isEmpty,
            reason: 'unconfigured device must never push');
        sync.dispose();
        await h.close();
      },
    );

    test(
      'A2: remote configured but healthCheck throws (offline) → committedLocal, no pull/push',
      () async {
        final h = await _Harness.build(online: false);
        await h.addEndedRow(activityId: 'A2id0001');

        final outcome = await h.sync.smartSync();

        expect(outcome, SmartSyncOutcome.committedLocal,
            reason: 'offline device degrades to a local commit');
        final rows = await h.store.getAllRows();
        expect(rows.any((r) => r['committed'] == true), isTrue,
            reason: 'local commit must mark the row committed');
        expect(
          h.transport.pushedPaths.where((p) => p.startsWith('ledger/')),
          isEmpty,
          reason: 'offline sync must not push ledger blocks',
        );
        await h.close();
      },
    );

    test(
      'A3: remote configured + online → pulls first, merges, pushes → remoteSynced',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g0 = h.localBlocks().first;
        final remoteDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'REMOTE001',
              'title': 'Remote task',
              'start_epoch': 1700000000000,
              'duration': 3600000,
            }),
          ],
          prevBlock: g0,
          dateStr: '2026-08-18',
        );
        // Put the same canonical block on the REMOTE too (device-to-device).
        await h.seedRemoteOnly([g0, remoteDay]);
        await h.addEndedRow(activityId: 'A3id0001', title: 'Local task');

        final outcome = await h.sync.smartSync();

        expect(outcome, SmartSyncOutcome.remoteSynced,
            reason: 'online configured device reconciles and pushes');
        await h.close();
      },
    );

    test(
      'A4: no ended uncommitted entries + unconfigured → nothingToCommit',
      () async {
        final h = await _Harness.build();
        final sync = SyncService(
          storage: _FakeStorage(),
          crypto: h.crypto,
          stagingStore: h.store,
          ledgerEngine: h.engine,
        );
        final outcome = await sync.smartSync();
        expect(outcome, SmartSyncOutcome.nothingToCommit,
            reason: 'clean unconfigured device is a no-op');
        expect(h.transport.pushedPaths, isEmpty);
        sync.dispose();
        await h.close();
      },
    );

    test(
      'A5: online but local ledger identical to remote (nothing to commit) → remoteDry',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        await h.seedRemoteOnly([g]);

        final outcome = await h.sync.smartSync();

        expect(outcome, SmartSyncOutcome.remoteDry,
            reason: 'no redundant push when already in sync');
        expect(h.localBlocks().length, 1,
            reason: 'nothing extra committed on an unchanged chain');
        await h.close();
      },
    );

    test(
      'A6: stale local catches up — missing remote canonical block is merged',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        final localDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'LOCAL001',
              'title': 'Local block',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-17',
        );
        // Remote is one block AHEAD: genesis, localDay, remoteDay.
        final remoteDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'REMOTE222',
              'title': 'Remote canonical',
              'start_epoch': 1700000000000,
              'duration': 2000,
            }),
          ],
          prevBlock: localDay,
          dateStr: '2026-08-18',
        );
        await h.seedRemoteOnly([g, localDay, remoteDay]);

        await h.sync.smartSync();

        final local = h.localBlocks();
        expect(local.length, 3,
            reason: 'local chain must gain the missing remote canonical block');
        expect(
          local.any((b) =>
              b['type'] == 'day' &&
              (b['entries'] as List).any((e) =>
                  (e['data'] as Map)['activity_id'] == 'REMOTE222')),
          isTrue,
          reason: 'behind-device catches up instead of overwriting remote',
        );
        await h.close();
      },
    );

    test(
      'A7: stale-local merge preserves the local unsealed tail (no drop)',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        final canonicalDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'CANON001',
              'title': 'Canonical',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-18',
        );
        // Local ONLY stranded tail block (phone Aug 18/19 case).
        h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'STRAND001',
              'title': 'Stranded tail',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: canonicalDay,
          dateStr: '2026-08-19',
        );
        // Remote is BEHIND local: only [genesis].
        await h.seedRemoteOnly([g]);

        await h.sync.smartSync();

        final local = h.localBlocks();
        expect(
          local.any((b) =>
              b['type'] == 'day' &&
              (b['entries'] as List).any((e) =>
                  (e['data'] as Map)['activity_id'] == 'STRAND001')),
          isTrue,
          reason: 'the stranded local tail must survive a reconcile',
        );
        await h.close();
      },
    );

    test(
      'A8: remote online but push failing → pushFailed',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final failingTransport = _FailingLedgerPushTransport();
        final push = LedgerPushService(
          db: h.db,
          crypto: h.crypto,
          transport: failingTransport,
        );
        final sync = SyncService(
          storage: _FakeStorage(),
          crypto: h.crypto,
          transport: failingTransport,
          stagingStore: h.store,
          ledgerEngine: h.engine,
          ledgerPush: push,
        );

        final outcome = await sync.smartSync();

        expect(outcome, SmartSyncOutcome.pushFailed,
            reason: 'a push that cannot reach R2 must surface as pushFailed');
        sync.dispose();
        await h.close();
      },
    );

    test(
      'A9: fallback path is a local-only commit — rows marked, not MOVE-deleted',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        await h.addEndedRow(activityId: 'A9id0001', title: 'Keep me');

        final sync = SyncService(
          storage: _FakeStorage(),
          crypto: h.crypto,
          stagingStore: h.store,
          ledgerEngine: h.engine,
        );
        final outcome = await sync.smartSync();

        expect(outcome, SmartSyncOutcome.committedLocal);
        final rows = await h.store.getAllRows();
        final row = rows.firstWhere((r) => r['activity_id'] == 'A9id0001');
        expect(row['committed'], isTrue,
            reason: 'fallback marks committed=true rather than deleting');
        expect(rows.any((r) => r['activity_id'] == 'A9id0001'), isTrue,
            reason: 'fallback must NOT MOVE-delete the committed row');
        sync.dispose();
        await h.close();
      },
    );

    test(
      'A10: online path pushes the newly committed block',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        await h.seedRemoteOnly([g]);
        await h.addEndedRow(activityId: 'A10id01', title: 'Commit me');

        await h.sync.smartSync();

        final remoteBlock1 = h.transport.remote['ledger/blocks/000001.json'];
        expect(remoteBlock1, isNotNull,
            reason: 'the freshly committed day block (index 1) is pushed');
        final decoded = h.crypto.deobfuscateBlob(
            remoteBlock1!, h.crypto.getMasterKey()!);
        final map = json.decode(decoded) as Map<String, dynamic>;
        final entries = map['entries'] as List<dynamic>;
        expect(
          entries.any((e) => (e['data'] as Map)['activity_id'] == 'A10id01'),
          isTrue,
          reason: 'the committed block pushed to R2 seals the synced entry',
        );
        await h.close();
      },
    );
  });

  group('C: commitAndSync(forceLocal:)', () {
    test(
      'C1: forceLocal=true does NOT auto-push new blocks nor MOVE-delete rows',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        await h.addEndedRow(activityId: 'C1id0001', title: 'Persist');

        final hash = await h.sync.commitAndSync(forceLocal: true);

        expect(hash, isNotNull, reason: 'the ended entry sealed a block');
        final rows = await h.store.getAllRows();
        final row = rows.firstWhere((r) => r['activity_id'] == 'C1id0001');
        expect(row['committed'], isTrue, reason: 'forceLocal marks committed');
        expect(rows.any((r) => r['activity_id'] == 'C1id0001'), isTrue,
            reason: 'forceLocal must NOT MOVE-delete the row');
        expect(
          h.transport.pushedPaths.where((p) => p.startsWith('ledger/')),
          isEmpty,
          reason: 'forceLocal=true must not auto-push ledger blocks',
        );
        await h.close();
      },
    );

    test(
      'C2: commitAndSync() default keeps push-mode (auto-push + MOVE delete)',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        await h.addEndedRow(activityId: 'C2id0001', title: 'Destroy');

        final hash = await h.sync.commitAndSync();

        expect(hash, isNotNull);
        final rows = await h.store.getAllRows();
        expect(rows.any((r) => r['activity_id'] == 'C2id0001'), isFalse,
            reason: 'default (forceLocal=false) MOVE-deletes the committed row');
        expect(
          h.transport.pushedPaths.any((p) => p.startsWith('ledger/')),
          isTrue,
          reason: 'default commit auto-pushes the ledger to remote',
        );
        await h.close();
      },
    );
  });

  group('D: reconcile/merge (ledger catch-up)', () {
    test(
      'D1: merge appends only MISSING remote blocks; present indices are skipped',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        final day = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'D1REMOTE',
              'title': 'remote',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-18',
        );

        await h.sync.reconcileRemoteLedger([g, day]);
        expect(h.localBlocks().length, 2, reason: 'first merge appends missing');
        await h.sync.reconcileRemoteLedger([g, day]);
        expect(h.localBlocks().length, 2,
            reason: 'second merge must NOT duplicate');
        expect(h.localBlocks().where((b) => b['type'] == 'day').length, 1,
            reason: 'exactly one canonical day block after idempotent merge');
        await h.close();
      },
    );

    test(
      'D2: merge preserves prev_hash linkage across the boundary',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        final day = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'D2REMOTE',
              'title': 'remote',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-18',
        );

        await h.sync.reconcileRemoteLedger([g, day]);

        final blocks = h.localBlocks();
        final genesisHash = getBlockHash(blocks[0]);
        expect(blocks[1]['prev_hash'], genesisHash,
            reason: 'first appended remote block links to the last local block');
        expect(h.engine.verify(), isTrue,
            reason: 'a linked merged chain must verify');
        await h.close();
      },
    );

    test(
      'D3: future/branching remote tip surfaced, not blindly pushed (no clobber)',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        // Local seals a canonical first day block.
        final localDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'D3LOCAL',
              'title': 'local',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-18',
        );
        // REMOTE contains a DIFFERENT first-day block (fork: same position,
        // different hash) that cannot bridge to the local tail.
        final remoteAlt = _buildAltDayBlock(h, g, '2026-08-18', '8000000001');

        final divergence =
            await h.sync.reconcileRemoteLedger([g, remoteAlt]);

        // The alternate remote block is genuinely a different fork from what
        // the local chain sealed (so the conflict is real, not a no-op).
        expect(getBlockHash(remoteAlt), isNot(getBlockHash(localDay)),
            reason: 'the remote fork must differ from the local canonical block');
        expect(h.localBlocks().length, 2,
            reason: 'a divergent fork must not extend the local chain');
        expect(divergence.conflictedIndices, isNotEmpty,
            reason: 'the merge must surface the conflicting remote block');
        expect(h.engine.verify(), isTrue,
            reason: 'the local canonical chain remains intact after a rejected fork');
        expect((divergence.conflictedIndices.first as num?) is num ||
                divergence.conflictedIndices.isNotEmpty,
            isTrue,
            reason: 'conflictedIndices carry block ordinals');
        await h.close();
      },
    );

    test(
      'D4: same sealed index + different hash → conflict detected, never overwritten',
      () async {
        final h = await _Harness.build(online: true);
        h.genesis();
        final g = h.localBlocks().first;
        final localDay = h.dayBlock(
          entries: [
            h._entry(data: {
              'activity_id': 'D4LOCAL',
              'title': 'local',
              'start_epoch': 1700000000000,
              'duration': 1000,
            }),
          ],
          prevBlock: g,
          dateStr: '2026-08-18',
        );
        final remoteDay = _buildAltDayBlock(h, g, '2026-08-18', 'D4REMOTE');

        final divergence =
            await h.sync.reconcileRemoteLedger([g, remoteDay]);

        expect(h.engine.verify(), isTrue);
        expect(divergence.conflictedIndices, isNotEmpty,
            reason: 'same-index-different-hash must be flagged as a conflict');
        final localIndex1 = h.localBlocks()[1];
        expect(getBlockHash(localIndex1), getBlockHash(localDay),
            reason: 'the local canonical sealed block must NOT be overwritten');
        await h.close();
      },
    );
  });
}

/// Build an ALTERNATE day block (a fork) with a different entry, for
/// divergence/conflict tests.
Map<String, dynamic> _buildAltDayBlock(
  _Harness h,
  Map<String, dynamic> prevBlock,
  String dateStr,
  String activityId,
) {
  return h.engine.chain.buildDayBlock(
    entries: [
      h._entry(data: {
        'activity_id': activityId,
        'title': 'alt-$activityId',
        'start_epoch': 1700000000000,
        'duration': 1000,
      }),
    ],
    prevHash: getBlockHash(prevBlock),
    dateStr: dateStr,
  );
}

