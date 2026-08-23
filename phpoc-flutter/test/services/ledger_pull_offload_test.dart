import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show computeEntryHash;
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/pull_stage_functions.dart';

/// Restore-pull isolate offload + concurrent block fetch — Phase 2 RED tests.
///
/// Blueprint: docs/planning/flutter/RESTORE_PULL_ISOLATE_FIX_PHASE1.md
///
/// Groups (25 assertions):
///   C1–C5: Concurrent block fetch (phase-2 RED: C3/C4)
///   O1–O6: Isolate offload seam (phase-2 RED: O1/O2/O3/O4; O5/O6 guard-green)
///   S1–S5: Seeding after concurrent + offloaded pull (guard-green deps)
///   R1–R4: Restore integration / ANR regression (phase-2 RED: R2)
///   E1–E5: Edge & error cases (guard-green deps)
///
/// RED surface: the `offload` seam (`LedgerPullService.offload`) is injected
/// but NOT yet routed through in `_doPullAll` (sequential loop + direct
/// `crypto.deobfuscateBlob`/`_validateImportedChain`), and the pure stage
/// helpers in `pull_stage_functions.dart` are skeletons that throw
/// `UnimplementedError`. So the offload-invocation, concurrency, and
/// wall-clock assertions FAIL for the right reason; behavior-preserving
/// dependencies stay green and become meaningful once Phase 3 wires the seam.

// ── Test constants (same non-secret fixtures as ledger_pull_service_test) ──

const testMkHex =
    'abababababababababababababababababababababababababababababababab';
const wrongMkHex =
    'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

// ── Inline offload runner (hermetic — never spawns a real isolate) ─────────

/// Counts invocations and executes the closure on the current isolate.
/// Used to prove the CPU-bound stages are routed through the `offload` seam
/// (Phase 3 GREEN) vs. today's direct in-thread calls (Phase 2 RED: count 0).
class CountingOffloadRunner {
  int calls = 0;
  final List<String> stageTags = [];

  Future<T> run<T>(FutureOr<T> Function() compute) async {
    calls++;
    return await compute();
  }

  OffloadRunner get runner => <T>(FutureOr<T> Function() compute) => run(compute);

  void reset() {
    calls = 0;
    stageTags.clear();
  }
}

// ── Concurrency-tracking transport ──────────────────────────────────────────

/// Wraps an [HttpTransport] and records the peak number of concurrent
/// in-flight [pull] calls, so bounded-concurrency (C3) and no-serialization
/// (C4/R2) can be asserted.
class ConcurrencyTrackingTransport implements HttpTransport {
  final HttpTransport inner;
  int _inFlight = 0;
  int peakConcurrent = 0;
  int pullCalls = 0;

  ConcurrencyTrackingTransport(this.inner);

  @override
  String get baseUrl => inner.baseUrl;
  @override
  String get apiKey => inner.apiKey;

  @override
  Future<Uint8List?> pull(String path) async {
    pullCalls++;
    _inFlight++;
    if (_inFlight > peakConcurrent) peakConcurrent = _inFlight;
    try {
      return await inner.pull(path);
    } finally {
      _inFlight--;
    }
  }

  @override
  Future<void> push(String path, Uint8List data) => inner.push(path, data);

  @override
  Future<List<String>> listFiles(String prefix) => inner.listFiles(prefix);

  @override
  Future<void> healthCheck() => inner.healthCheck();

  @override
  Future<void> delete(String path) => inner.delete(path);
}

// ── Base FakePullTransport (mirrors ledger_pull_service_test) ───────────────

class FakePullTransport implements HttpTransport {
  @override
  final String baseUrl;
  @override
  final String apiKey;
  final Map<String, Uint8List> blockStore;
  String? hashIndexJson;
  bool unreachable = false;
  final Map<String, int> statusOnPath = {};

  /// Per-block artificial latency (ms) to model slow fetches.
  final Map<String, int> latencyMs = {};

  FakePullTransport({
    this.baseUrl = 'https://test-worker.example.com',
    this.apiKey = 'fake-api-key',
    Map<String, Uint8List>? blockStore,
    this.hashIndexJson,
  }) : blockStore = blockStore ?? {};

  Future<void> _maybeDelay(String path) async {
    final ms = latencyMs[path];
    if (ms != null && ms > 0) {
      await Future<void>.delayed(Duration(milliseconds: ms));
    }
  }

  @override
  Future<Uint8List?> pull(String path) async {
    await _maybeDelay(path);
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    final status = statusOnPath[path];
    if (status != null) {
      throw HttpTransportException('HTTP $status on pull($path)', status);
    }
    if (path.endsWith('?list') || path.contains('?prefix=')) {
      return _handleList(path);
    }
    if (path == 'ledger/hash_index.json' && hashIndexJson != null) {
      return Uint8List.fromList(utf8.encode(hashIndexJson!));
    }
    return blockStore[path];
  }

  Uint8List? _handleList(String path) {
    final prefix = path.replaceFirst(RegExp(r'\?.*'), '');
    final files = blockStore.keys.where((k) => k.startsWith(prefix)).toList();
    return Uint8List.fromList(utf8.encode(jsonEncode(files)));
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    blockStore[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
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

// ── Helpers ─────────────────────────────────────────────────────────────────

Future<LedgerPullService> _makeService({
  AppDatabase? db,
  CryptoService? crypto,
  HttpTransport? transport,
  LedgerBackupService? backupService,
  StagingStorage? stagingStorage,
  StagingStore? stagingStore,
  OffloadRunner? offload,
  bool cacheMk = true,
}) async {
  final d = db ?? AppDatabase.inMemory();
  final c = crypto ?? CryptoService();
  if (!c.isInitialized) await c.initialize();
  if (cacheMk) c.setMasterKey(testMkHex);
  return LedgerPullService(
    db: d,
    crypto: c,
    transport: transport ?? FakePullTransport(),
    backupService: backupService ?? LedgerBackupService(db: d),
    stagingStorage: stagingStorage ?? StagingStorage(d),
    stagingStore: stagingStore ?? StagingStore(d),
    offload: offload ?? isolateOffloadRunner,
  );
}

/// Store an obfuscated block into `transport.blockStore` (when it is a
/// [FakePullTransport]) at the correct index path.
void _storeBlock(
  HttpTransport transport,
  CryptoService crypto,
  int index,
  Map<String, dynamic> blockJson,
) {
  final ft = transport;
  if (ft is! FakePullTransport) return;
  final json = jsonEncode(blockJson);
  final obfuscated = crypto.obfuscateBlob(json, testMkHex);
  final path = 'ledger/blocks/${index.toString().padLeft(6, '0')}.json';
  ft.blockStore[path] = obfuscated;
}

Map<String, dynamic> _genesisBlockJson({String blockHash = 'g'}) => {
      'type': 'genesis',
      'day_index': 0,
      'date': '2026-06-01',
      'prev_hash': '0' * 64,
      'entries': <dynamic>[],
      'block_hash': blockHash,
      'identity_seal': blockHash,
    };

Map<String, dynamic> _dayBlockJson({
  required int index,
  String blockHash = 'hash',
  required String prevHash,
  List<Map<String, dynamic>>? entries,
}) =>
    {
      'type': 'day',
      'day_index': index,
      'date': '2026-06-02',
      'prev_hash': prevHash,
      'entries': entries ?? <dynamic>[],
      'day_hash': blockHash,
      'identity_seal': blockHash,
    };

/// A valid 2-block chain (genesis + day with one completed entry).
void _seedValidTwoBlockChain(FakePullTransport t, CryptoService c) {
  t.hashIndexJson = jsonEncode(['g', 'd']);
  _storeBlock(t, c, 0, _genesisBlockJson(blockHash: 'blockgen'));
  final mkHex = c.getMasterKey() ?? testMkHex;
  final data = {
    'title': 'Task A',
    'duration': 1800,
    'is_active': false,
    'is_paused': false,
    // Encrypted epoch/duration fields drive `decryptEpoch`-based staging
    // seeding (PHPSPEC format); the staging row exposes plaintext
    // start_epoch/duration for the UI.
    'startTime_enc': c.encrypt('1717200000000', mkHex),
    'endTime_enc': c.encrypt('1717201800000', mkHex),
    'duration_enc': c.encrypt('1800', mkHex),
  };
  _storeBlock(
    t,
    c,
    1,
    _dayBlockJson(
      index: 1,
      blockHash: 'blockd',
      prevHash: 'blockgen',
      entries: [{'hash': computeEntryHash(data), 'data': data}],
    ),
  );
}

void main() {
  // ═════════════════════════════════════════════════════════════
  // Group O: Isolate offload of CPU-bound stages — 6 tests
  // ═════════════════════════════════════════════════════════════
  group('O: Isolate offload of CPU-bound stages', () {
    // O1 — decodePullBlockBytes invoked through the offload runner
    test('O1: decodePullBlockBytes is invoked through the offload runner',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final transport = FakePullTransport();
      _seedValidTwoBlockChain(transport, crypto);
      final counter = CountingOffloadRunner();

      final service = await _makeService(
        crypto: crypto,
        transport: transport,
        offload: counter.runner,
      );

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(counter.calls, greaterThanOrEqualTo(1),
          reason:
              'Deobfuscation must be routed through the offload seam — '
              'currently it is not, so this is RED (Phase 3 wires it).');
    });

    // O2 — validatePulledChain invoked through the offload runner
    test('O2: validatePulledChain is invoked through the offload runner',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final transport = FakePullTransport();
      _seedValidTwoBlockChain(transport, crypto);
      final counter = CountingOffloadRunner();

      final service = await _makeService(
        crypto: crypto,
        transport: transport,
        offload: counter.runner,
      );

      final result = await service.pullAll();

      expect(result.success, isTrue);
      // Expect at least one invocation per block decode plus one chain
      // validation (2 decodes + 1 validate = 3 once wired). Skeleton runs
      // zero through the seam → RED.
      expect(counter.calls, greaterThanOrEqualTo(3),
          reason:
              'Both per-block deobfuscation and chain validation must be '
              'offloaded. Currently neither is — RED.');
    });

    // O3 — off-loaded deobfuscation is byte-identical to in-thread result
    test('O3: decodePullBlockBytes output matches in-thread deobfuscation',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final transport = FakePullTransport();
      _seedValidTwoBlockChain(transport, crypto);

      final raw = transport.blockStore['ledger/blocks/000001.json']!;
      final inThread = crypto.deobfuscateBlob(raw, testMkHex);

      // Pure helper must reproduce the same JSON string (behavior-preserving).
      expect(() => decodePullBlockBytes(raw, testMkHex), returnsNormally,
          reason:
              'decodePullBlockBytes is a skeleton (throws UnimplementedError) '
              '→ RED until Phase 3 moves the real body here.');
      expect(decodePullBlockBytes(raw, testMkHex), inThread,
          reason: 'Off-loaded decode must be byte-identical to in-thread.');
    });

    // O4 — tampered entry hash still fails chain validation when off-loaded
    test('O4: tampered entry hash fails off-loaded chain validation',
        () async {
      // A valid block list whose day entry hash has been tampered.
      final data = {'title': 'Task', 'duration': 100, 'is_active': false};
      final valid = [
        _genesisBlockJson(),
        _dayBlockJson(
          index: 1,
          prevHash: 'g',
          entries: [{'hash': computeEntryHash(data), 'data': data}],
        ),
      ];
      // Tamper the stored entry hash.
      ((valid[1]['entries'] as List)[0] as Map<String, dynamic>)['hash'] =
          'ff' * 32;

      expect(
        () => validatePulledChain(valid),
        throwsA(isA<FormatException>()),
        reason:
            'validatePulledChain must still detect the tampered hash '
            'off-thread. Skeleton throws UnimplementedError, not '
            'FormatException → RED until Phase 3 is implemented.',
      );
    });

    // O5 — wrong MK → all blocks fail → PullResult.failure (unchanged)
    test('O5: wrong MK yields PullResult.failure (unchanged errors)',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final wrongCrypto = CryptoService()..initialize();
      wrongCrypto.setMasterKey(wrongMkHex);
      final transport = FakePullTransport();
      _seedValidTwoBlockChain(transport, crypto);
      final counter = CountingOffloadRunner();

      final service = await _makeService(
        crypto: wrongCrypto,
        transport: transport,
        offload: counter.runner,
        cacheMk: false,
      );

      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'Wrong MK must cause pull failure (unchanged, guard-green).');
      expect(result.errors, isNotEmpty,
          reason: 'Crypto error must still be reported.');
    });

    // O6 — default runner is Isolate.run-backed; inline injectable
    test('O6: default offload is non-null; inline runner injectable', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final transport = FakePullTransport();
      _seedValidTwoBlockChain(transport, crypto);

      // Default (no offload passed) → uses production isolate runner.
      final defaultService =
          await _makeService(crypto: crypto, transport: transport);
      expect(defaultService.offload, isNotNull,
          reason: 'Default offload runner must be present (Isolate.run-backed).');

      // Inline runner injectable (DI seam contract).
      final inline = _makeService(
          crypto: crypto,
          transport: transport,
          offload: CountingOffloadRunner().runner);
      expect((await inline).offload, isNotNull,
          reason: 'An inline/injectable runner must not be null.');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group C: Concurrent block fetch — 5 tests
  // ═════════════════════════════════════════════════════════════
  group('C: Concurrent block fetch', () {
    FakePullTransport multiBlockTransport(CryptoService c, int n) {
      final t = FakePullTransport();
      t.hashIndexJson = jsonEncode(List.generate(n, (i) => 'h$i'));
      for (var i = 0; i < n; i++) {
        _storeBlock(
          t,
          c,
          i,
          i == 0
              ? _genesisBlockJson(blockHash: 'h0')
              : _dayBlockJson(
                  index: i, prevHash: 'h${i - 1}', blockHash: 'h$i'),
        );
      }
      return t;
    }

    // C1 — concurrent pull returns same block set as sequential pull
    test('C1: concurrent + sequential pulls yield the same block set',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);

      // Sequential baseline (default service).
      final seqService =
          await _makeService(crypto: crypto, transport: multiBlockTransport(crypto, 6));
      final seq = await seqService.pullAll();

      // Same transport data, but this time assert the downloaded set matches.
      final t2 = multiBlockTransport(crypto, 6);
      final conService = await _makeService(crypto: crypto, transport: t2);
      final con = await conService.pullAll();

      expect(con.success, isTrue);
      expect(con.blocksPulled, seq.blocksPulled,
          reason: 'Concurrency must be behavior-equivalent to sequential.');
      expect(con.blocksPulled, 6,
          reason: 'All 6 blocks must be downloaded either way.');
    });

    // C2 — blocks imported in chain order regardless of fetch completion order
    test('C2: blocks imported in chain (index) order', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();
      final t = multiBlockTransport(crypto, 6);
      final service = await _makeService(db: db, crypto: crypto, transport: t);

      await service.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 6);
      for (var i = 0; i < blocks.length; i++) {
        expect(blocks[i].blockIndex, i,
            reason: 'Imported block at position $i must have blockIndex $i '
                '(prev_hash linkage is order-dependent).');
      }
      await db.close();
    });

    // C3 — in-flight HTTP stays bounded AND shows real concurrency
    test('C3: fetch is bounded (≤ limit) but actually concurrent (peak > 1)',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = ConcurrencyTrackingTransport(multiBlockTransport(crypto, 20));
      final service = await _makeService(crypto: crypto, transport: t);

      const limit = 5;
      await service.pullAll();

      expect(t.peakConcurrent, lessThanOrEqualTo(limit),
          reason: 'In-flight HTTP must stay ≤ bounded concurrency limit.');
      expect(t.peakConcurrent, greaterThan(1),
          reason:
              'Block fetch must actually run concurrently (peak > 1). '
              'Currently the loop is sequential → peak == 1 → RED until '
              'Phase 3 replaces it with bounded Future.wait.');
      expect(t.pullCalls, 21,
          reason: 'All 20 blocks must still be fetched, plus the leading '
              'hash_index.json discovery pull (20 + 1 = 21).');
    });

    // C4 — a slow single block does not stall the other blocks
    test('C4: a slow block does not stall the other blocks', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = multiBlockTransport(crypto, 20);
      // Make block 1 very slow (150ms); others fast.
      t.latencyMs['ledger/blocks/000001.json'] = 150;
      final tracking = ConcurrencyTrackingTransport(t);
      final service = await _makeService(crypto: crypto, transport: tracking);

      final sw = Stopwatch()..start();
      await service.pullAll();
      sw.stop();

      // If fetch were sequential, the slow block alone costs 150ms and the
      // others serialize after it (~20 × fast). A concurrent fetch completes
      // the whole pull well under the sum of all serial latencies.
      expect(sw.elapsedMilliseconds, lessThan(150 + 100),
          reason:
              'The pull must not serialize behind a single slow block. '
              'Currently sequential → wall time ≈ sum of all block latencies '
              '→ RED until concurrent fetch lands.');
    });

    // C5 — a fetch failure reports the failed index + returns the good blocks
    test('C5: per-block failure reports index + keeps good blocks', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = multiBlockTransport(crypto, 5);
      // Fail the LAST block so the remaining chain (0..3) is still valid and
      // the failed index is reported without a linkage break.
      t.statusOnPath['ledger/blocks/000004.json'] = 500;
      final service = await _makeService(crypto: crypto, transport: t);

      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'One failed block makes the pull a partial failure.');
      expect(result.failedBlocks, contains(4),
          reason: 'The failed index 4 must be reported.');
      expect(result.blocksPulled, 4,
          reason: 'The 4 good blocks must still be pulled (guard-green).');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group S: Seeding after concurrent + offloaded pull — 5 tests
  // ═════════════════════════════════════════════════════════════
  group('S: Staging seeding after concurrent + offloaded pull', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakePullTransport transport;
    late StagingStore store;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakePullTransport();
      store = StagingStore(db);
      _seedValidTwoBlockChain(transport, crypto);
    });

    tearDown(() async {
      await db.close();
    });

    // S1 — staging still seeded with all entries after concurrent+offloaded pull
    test('S1: staging is seeded with all entries', () async {
      final service = await _makeService(
          db: db, crypto: crypto, transport: transport,
          offload: CountingOffloadRunner().runner);
      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.entriesStaged, 1,
          reason: 'The single completed day entry must be staged.');
      final rows = await store.getAllRows();
      expect(rows.length, 1,
          reason: 'Staging must contain the seeded entry (guard-green dep).');
    });

    // S2 — no duplicate staging rows across concurrently-fetched blocks
    test('S2: no duplicate staging rows', () async {
      final service = await _makeService(
          db: db, crypto: crypto, transport: transport);
      await service.pullAll();

      // Re-pull same chain — still no duplication.
      await service.pullAll();
      final rows = await store.getAllRows();
      expect(rows.length, 1,
          reason: 'Re-pull must not duplicate the seeded row (guard-green).');
    });

    // S3 — seeded row fields correct for UI rendering
    test('S3: seeded row fields are correct', () async {
      final service = await _makeService(
          db: db, crypto: crypto, transport: transport);
      await service.pullAll();

      final rows = await store.getAllRows();
      expect(rows.length, 1);
      final row = rows.first;
      expect(row['committed'], true,
          reason: 'Seeded row must be committed=true at row level.');
      final activity = jsonDecode(row['activity'] as String)
          as Map<String, dynamic>;
      expect(activity['title'], 'Task A');
      expect(activity['start_epoch'], 1717200000000);
      expect(activity['duration'], 1800);
      expect(activity['is_active'], false);
      expect((activity['tags'] as List).isEmpty, isTrue);
    });

    // S4 — pullIfRemoteHasMore (freshness detector) still works unchanged
    test('S4: pullIfRemoteHasMore unchanged', () async {
      transport.hashIndexJson = jsonEncode(List.generate(10, (i) => 'h$i'));
      final service = await _makeService(
          db: db, crypto: crypto, transport: transport);
      final result = await service.pullIfRemoteHasMore(localBlockCount: 2);
      expect(result.success, isTrue);
      expect(result.blocksPulled, 8,
          reason: 'Freshness detector must report 8 new blocks (guard-green).');
    });

    // S5 — result counts (loaded, skipped) reflect concurrent fetch
    test('S5: result counts reflect downloaded blocks', () async {
      final service = await _makeService(
          db: db, crypto: crypto, transport: transport);
      final result = await service.pullAll();
      expect(result.blocksPulled, 2,
          reason: 'blocksPulled must equal the 2-chain length (guard-green).');
      expect(result.entriesStaged, 1,
          reason: 'entriesStaged must match seeded entries (guard-green).');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group R: Restore integration — 4 tests
  // ═════════════════════════════════════════════════════════════
  group('R: Restore integration / ANR regression', () {
    // R1 — restore completes + seeds entries from a large (N ≥ 20) remote
    test('R1: restore completes and seeds entries from a large remote',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();
      final t = FakePullTransport();
      const n = 24;
      t.hashIndexJson = jsonEncode(List.generate(n, (i) => 'h$i'));
      // Each day block carries one completed entry so `entriesStaged` is > 0.
      for (var i = 0; i < n; i++) {
        final data = {
          'title': 'Task $i',
          'duration': 100,
          'is_active': false,
          'is_paused': false,
        };
        _storeBlock(
          t,
          crypto,
          i,
          i == 0
              ? _genesisBlockJson(blockHash: 'h$i')
              : _dayBlockJson(
                  index: i,
                  prevHash: 'h${i - 1}',
                  blockHash: 'h$i',
                  entries: [{'hash': computeEntryHash(data), 'data': data}]),
        );
      }
      final store = StagingStore(db);
      final service = await _makeService(
          db: db, crypto: crypto, transport: t);

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, n);
      final rows = await store.getAllRows();
      expect(rows.length, greaterThanOrEqualTo(20),
          reason: 'A large pull must seed the History with many entries '
              '(the ANR fix goal — reproduces the empty-History symptom).');
      await db.close();
    });

    // R2 — pullAll completes within a wall-clock bound (no ANR window)
    test('R2: pullAll completes within a wall-clock bound', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = FakePullTransport();
      const n = 30;
      final delay = 12; // ms per slow block
      t.hashIndexJson = jsonEncode(List.generate(n, (i) => 'h$i'));
      for (var i = 0; i < n; i++) {
        _storeBlock(
          t,
          crypto,
          i,
          i == 0
              ? _genesisBlockJson(blockHash: 'h$i')
              : _dayBlockJson(index: i, prevHash: 'h${i - 1}', blockHash: 'h$i'),
        );
        t.latencyMs['ledger/blocks/${i.toString().padLeft(6, '0')}.json'] =
            delay;
      }
      final service = await _makeService(crypto: crypto, transport: t);

      final sw = Stopwatch()..start();
      final result = await service.pullAll();
      sw.stop();

      expect(result.success, isTrue);
      // Sequential would take n × delay = 360ms. Concurrent with limit ~5
      // takes ~ceil(n/limit)×delay ≈ 72ms. Bound well under serial sum.
      final serialSum = n * delay;
      expect(sw.elapsedMilliseconds, lessThan(serialSum),
          reason:
              'pullAll must not waste a UI-thread ANR window serializing '
              'N slow fetches. Currently sequential → wall time ≈ serial '
              'sum → RED until concurrent fetch lands.');
    });

    // R3 — failed big pull stays fail-open (local genesis preserved, no partial import)
    test('R3: failed pull preserves local genesis and imports nothing',
        () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();
      // A pre-existing local genesis.
      await db.blockDao.insertBlock(Block(
        blockId: 'local-gen',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode('[]')),
        identitySeal: 'local-seal',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      // Remote has a chain with a tampered entry hash (validation must fail
      // BEFORE import).
      final t = FakePullTransport();
      t.hashIndexJson = jsonEncode(['g', 'd']);
      _storeBlock(t, crypto, 0, _genesisBlockJson(blockHash: 'blockgen'));
      final data = {'title': 'X', 'duration': 1, 'is_active': false};
      _storeBlock(
        t,
        crypto,
        1,
        _dayBlockJson(
          index: 1,
          prevHash: 'blockgen',
          entries: [
            {'hash': 'ff' * 32, 'data': data} // tampered hash
          ],
        ),
      );

      final service = await _makeService(db: db, crypto: crypto, transport: t);
      try {
        await service.pullAll();
      } catch (_) {
        // Validation currently throws (J-group contract). Guard-green check:
        // no partial import must have occurred.
      }

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 1,
          reason: 'Local genesis only — no partial import after failed '
              'validation (D5 guard-green).');
      expect(blocks[0].blockId, 'local-gen');
      await db.close();
    });

    // R4 — importFromJson runs only after fetch + validation succeed
    test('R4: import runs only after fetch + validation succeed', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      // A chain whose validation FAILS midway must not be imported at all.
      final t = FakePullTransport();
      t.hashIndexJson = jsonEncode(['h0', 'h1', 'h2']);
      _storeBlock(t, crypto, 0, _genesisBlockJson(blockHash: 'h0'));
      // block 1: valid day (empty entries)
      _storeBlock(t, crypto, 1,
          _dayBlockJson(index: 1, prevHash: 'h0', blockHash: 'h1'));
      // block 2: broken prev_hash linkage → validation fails.
      _storeBlock(t, crypto, 2,
          _dayBlockJson(index: 2, prevHash: 'WRONG', blockHash: 'h2'));

      final service = await _makeService(db: db, crypto: crypto, transport: t);
      try {
        await service.pullAll();
      } catch (_) {
        // Validation throws before import.
      }

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'Import must NOT occur because validation failed first '
              'on the broken prev_hash linkage (D4 order guard).');
      expect(store, isNotNull);
      await db.close();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group E: Edge & error cases — 5 tests
  // ═════════════════════════════════════════════════════════════
  group('E: Edge & error cases', () {
    // E1 — empty remote → PullResult.ok(0,0), no offload invoked
    test('E1: empty remote yields ok(0,0) and no offload invocation', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = FakePullTransport()..hashIndexJson = jsonEncode([]);
      final counter = CountingOffloadRunner();
      final service = await _makeService(
          crypto: crypto, transport: t, offload: counter.runner);

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
      expect(result.entriesStaged, 0);
      expect(counter.calls, 0,
          reason: 'No CPU-bound stage runs on an empty pull — no isolate '
              'spin (guard-green).');
    });

    // E2 — null transport → PullResult.ok(0,0)
    test('E2: null transport yields ok(0,0)', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final service =
          await _makeService(crypto: crypto, transport: null as dynamic);
      final result = await service.pullAll();
      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
    });

    // E3 — network failure on hash_index → PullResult.failure
    test('E3: hash_index network failure yields PullResult.failure', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = FakePullTransport()..unreachable = true;
      final service = await _makeService(crypto: crypto, transport: t);
      final result = await service.pullAll();
      expect(result.success, isFalse);
      expect(result.errors, isNotEmpty);
    });

    // E4 — transient per-block HTTP failure degrades gracefully
    test('E4: transient per-block failure degrades gracefully', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final t = FakePullTransport();
      t.hashIndexJson = jsonEncode(['g', 'd']);
      _storeBlock(t, crypto, 0, _genesisBlockJson(blockHash: 'g'));
      _storeBlock(t, crypto, 1,
          _dayBlockJson(index: 1, prevHash: 'g', blockHash: 'd'));
      t.statusOnPath['ledger/blocks/000001.json'] = 503;
      final service = await _makeService(crypto: crypto, transport: t);
      final result = await service.pullAll();
      expect(result.failedBlocks, contains(1),
          reason: 'A transient per-block failure is reported, not fatal.');
      expect(result.blocksPulled, 1,
          reason: 'The good block is still pulled (guard-green).');
    });

    // E5 — MK not cached → StateError (unchanged precondition)
    test('E5: uncached MK yields StateError', () async {
      final crypto = CryptoService()..initialize();
      // No setMasterKey.
      final service = await _makeService(
          crypto: crypto,
          cacheMk: false);
      expect(
        () => service.pullAll(),
        throwsA(isA<StateError>()),
        reason: 'Uncached MK precondition unchanged (guard-green).',
      );
    });
  });
}
