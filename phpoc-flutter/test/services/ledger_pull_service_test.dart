import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/models/pull_result.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show computeEntryHash;
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';

/// LedgerPullService tests — Groups A, B, C, F (20 assertions).
///
/// Blueprint: docs/planning/flutter/WIPE_CLOUD_ONBOARD_PHASE1.md
///
/// Covers:
///   A1–A4:  Construction & API
///   B1–B6:  Block Pulling from R2
///   C1–C5:  Import after Pull
///   F1–F5:  Error Handling

// ── Test constants ─────────────────────────────────────────────

/// Valid 64-char hex master key (32 bytes for AES-128 + HMAC).
const testMkHex =
    'abababababababababababababababababababababababababababababababab';

/// Second master key (different from testMkHex) for wrong-key tests.
const wrongMkHex =
    'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

// ── Fake Transport ─────────────────────────────────────────────

/// In-memory [HttpTransport] fake that serves pre-obfuscated blocks
/// for pull testing.
///
/// [blockStore] — maps path → Uint8List of obfuscated block data.
/// [hashIndexJson] — plaintext JSON array of block hashes (defaults to empty).
/// [unreachable] — if true, all operations throw a network error.
/// [statusOnPath] — maps path → HTTP status code to simulate errors.
class FakePullTransport implements HttpTransport {
  @override
  final String baseUrl;

  @override
  final String apiKey;

  /// Pre-obfuscated block data, keyed by path.
  final Map<String, Uint8List> blockStore;

  /// Plaintext hash index JSON to serve on pull('ledger/hash_index.json').
  String? hashIndexJson;

  /// If true, all operations throw a network error.
  bool unreachable = false;

  /// Paths that should return a given HTTP status code on pull.
  final Map<String, int> statusOnPath = {};

  FakePullTransport({
    this.baseUrl = 'https://test-worker.example.com',
    this.apiKey = 'fake-api-key',
    Map<String, Uint8List>? blockStore,
    this.hashIndexJson,
  }) : blockStore = blockStore ?? {};

  @override
  Future<Uint8List?> pull(String path) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    final status = statusOnPath[path];
    if (status != null) {
      throw HttpTransportException('HTTP $status on pull($path)', status);
    }
    // Special case: list query
    if (path.endsWith('?list') || path.contains('?prefix=')) {
      return _handleList(path);
    }
    if (path == 'ledger/hash_index.json' && hashIndexJson != null) {
      return Uint8List.fromList(utf8.encode(hashIndexJson!));
    }
    return blockStore[path]; // null = 404
  }

  Uint8List? _handleList(String path) {
    final prefix = path.replaceFirst(RegExp(r'\?.*'), '');
    final files = blockStore.keys.where((k) => k.startsWith(prefix)).toList();
    return Uint8List.fromList(utf8.encode(jsonEncode(files)));
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    blockStore[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    // Match real Worker ?prefix= API: return entries relative to prefix
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

// ── Helpers ────────────────────────────────────────────────────

/// Create a fresh [LedgerPullService] with in-memory DB, initialized
/// crypto (with test MK cached), fake transport, and backup service.
Future<LedgerPullService> _makeService({
  AppDatabase? db,
  CryptoService? crypto,
  FakePullTransport? transport,
  LedgerBackupService? backupService,
  StagingStorage? stagingStorage,
  StagingStore? stagingStore,
  bool cacheMk = true,
}) async {
  final d = db ?? AppDatabase.inMemory();
  final c = crypto ?? CryptoService();
  if (!c.isInitialized) {
    await c.initialize();
  }
  if (cacheMk) {
    c.setMasterKey(testMkHex);
  }
  final t = transport ?? FakePullTransport();
  final b = backupService ?? LedgerBackupService(db: d);
  final s = stagingStorage ?? StagingStorage(d);
  final store = stagingStore ?? StagingStore(d);
  return LedgerPullService(
    db: d,
    crypto: c,
    transport: t,
    backupService: b,
    stagingStorage: s,
    stagingStore: store,
  );
}

/// Build an obfuscated block and store it in the fake transport.
///
/// Returns the path used to store it.
String _storeObfuscatedBlock(
  FakePullTransport transport,
  CryptoService crypto,
  int index,
  Map<String, dynamic> blockJson, {
  String? mkHex,
}) {
  final mk = mkHex ?? testMkHex;
  final json = jsonEncode(blockJson);
  final obfuscated = crypto.obfuscateBlob(json, mk);
  final path = 'ledger/blocks/${index.toString().padLeft(6, '0')}.json';
  transport.blockStore[path] = obfuscated;
  return path;
}

/// Build a minimal genesis block JSON map.
Map<String, dynamic> _genesisBlockJson({
  String identitySeal = 'genesis-seal',
  String prevHash = '0000000000000000000000000000000000000000000000000000000000000000',
  String blockHash = 'genesis-block-hash',
  String date = '2026-06-01',
  List<Map<String, dynamic>>? entries,
}) =>
    {
      'type': 'genesis',
      'day_index': 0,
      'date': date,
      'prev_hash': prevHash,
      'entries': entries ?? [],
      'signature': identitySeal,
      'identity_seal': identitySeal,
      'block_hash': blockHash,
    };

/// Build a minimal day block JSON map.
Map<String, dynamic> _dayBlockJson({
  required int dayIndex,
  String prevHash = 'aaaa',
  String identitySeal = 'day-seal',
  String blockHash = 'day-block-hash',
  String date = '2026-06-02',
  List<Map<String, dynamic>>? entries,
}) =>
    {
      'type': 'day',
      'day_index': dayIndex,
      'date': date,
      'prev_hash': prevHash,
      'entries': entries ?? [],
      'signature': identitySeal,
      'identity_seal': identitySeal,
      'block_hash': blockHash,
    };

// ═══════════════════════════════════════════════════════════════
// Group A: Construction & API
// ═══════════════════════════════════════════════════════════════

void main() {
  group('A: LedgerPullService — Construction & API', () {
    late CryptoService crypto;
    late FakePullTransport transport;
    late AppDatabase db;
    late LedgerBackupService backupService;
    late StagingStorage stagingStorage;

    setUp(() async {
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakePullTransport();
      db = AppDatabase.inMemory();
      backupService = LedgerBackupService(db: db);
      stagingStorage = StagingStorage(db);
    });

    tearDown(() async {
      await db.close();
    });

    // A1
    test('A1: Constructor requires db, crypto, transport, backupService',
        () async {
      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
      expect(service, isA<LedgerPullService>());
    });

    // A2
    test('A2: Service exposes pullAll() as single public method', () async {
      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
      expect(service.pullAll, isA<Function>());
    });

    // A3
    test('A3: pullAll() throws StateError if crypto.hasMasterKey is false',
        () async {
      final noMkCrypto = CryptoService();
      await noMkCrypto.initialize();
      // Do NOT call setMasterKey

      final service = LedgerPullService(
        db: db,
        crypto: noMkCrypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );

      expect(
        () => service.pullAll(),
        throwsA(isA<StateError>()),
        reason: 'pullAll() must fail fast when no MK is cached',
      );
    });

    // A4
    test('A4: pullAll() with null transport returns empty result (no-op)',
        () async {
      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: null as dynamic,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );

      // Should not throw — returns empty/success result for local-only mode
      final result = await service.pullAll();
      expect(result, isA<PullResult>());
      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
      expect(result.entriesStaged, 0);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group B: Block Pulling from R2
  // ═════════════════════════════════════════════════════════════

  group('B: LedgerPullService — Block Pulling', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakePullTransport transport;
    late LedgerBackupService backupService;
    late StagingStorage stagingStorage;
    late LedgerPullService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakePullTransport();
      backupService = LedgerBackupService(db: db);
      stagingStorage = StagingStorage(db);
      service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
    });

    tearDown(() async {
      await db.close();
    });

    // B1
    test('B1: Pull ledger/hash_index.json returns JSON array with N entries',
        () async {
      // Setup: store hash_index.json with 3 hashes
      transport.hashIndexJson = jsonEncode(['hash0', 'hash1', 'hash2']);
      // Store 3 obfuscated blocks
      for (var i = 0; i < 3; i++) {
        _storeObfuscatedBlock(
          transport,
          crypto,
          i,
          i == 0
              ? _genesisBlockJson(blockHash: 'hash$i', identitySeal: 'hash$i')
              : _dayBlockJson(
                  dayIndex: i,
                  prevHash: 'hash${i - 1}',
                  blockHash: 'hash$i',
                  identitySeal: 'hash$i',
                ),
        );
      }

      final result = await service.pullAll();

      expect(result, isA<PullResult>());
      expect(result.success, isTrue);
      expect(result.blocksPulled, 3,
          reason: 'Must pull all 3 blocks listed in hash_index');
    });

    // B2
    test(
        'B2: Pull single block → deobfuscate → valid PHPSPEC JSON',
        () async {
      transport.hashIndexJson = jsonEncode(['genesis-hash']);
      final genesisJson = _genesisBlockJson(blockHash: 'genesis-hash',
          identitySeal: 'genesis-hash');
      _storeObfuscatedBlock(transport, crypto, 0, genesisJson);

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 1);
      // Verify the block is in the DB after pull
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 1,
          reason: 'Single pulled block must be in database');
      expect(blocks[0].blockType, BlockType.genesis);
    });

    // B3
    test('B3: Pull all 31 blocks → assembled into sorted PHPSPEC array',
        () async {
      final hashes = List.generate(31, (i) => 'hash-$i');
      transport.hashIndexJson = jsonEncode(hashes);

      // Store blocks in reverse order to verify sorting
      for (var i = 30; i >= 0; i--) {
        final prevHash = i == 0
            ? '0000000000000000000000000000000000000000000000000000000000000000'
            : 'hash-${i - 1}';
        final json = i == 0
            ? _genesisBlockJson(blockHash: 'hash-$i', identitySeal: 'hash-$i',
                prevHash: prevHash)
            : _dayBlockJson(
                dayIndex: i,
                prevHash: prevHash,
                blockHash: 'hash-$i',
                identitySeal: 'hash-$i',
              );
        _storeObfuscatedBlock(transport, crypto, i, json);
      }

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 31);
      // Verify blocks are stored sorted by index in DB
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 31);
      for (var i = 0; i < 31; i++) {
        expect(blocks[i].blockIndex, i,
            reason: 'Block at DB position $i must have blockIndex $i');
      }
    });

    // B4
    test('B4: Pull with missing blocks → partial result, failed indices '
        'reported', () async {
      transport.hashIndexJson = jsonEncode(['h0', 'h1', 'h2', 'h3']);
      // Store blocks 0 and 3 only — blocks 1 and 2 are missing (404)
      _storeObfuscatedBlock(
          transport, crypto, 0, _genesisBlockJson(blockHash: 'h0',
              identitySeal: 'h0'));
      _storeObfuscatedBlock(
          transport,
          crypto,
          3,
          _dayBlockJson(
              dayIndex: 3,
              prevHash: 'h0',
              blockHash: 'h3',
              identitySeal: 'h3'));

      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'Missing blocks must result in failure');
      expect(result.blocksPulled, 2,
          reason: 'Only blocks 0 and 3 should be pulled');
      expect(result.failedBlocks, containsAll([1, 2]),
          reason: 'Failed indices 1 and 2 must be reported');
    });

    // B5
    test('B5: Pull from empty remote (no blocks) → returns empty result',
        () async {
      transport.hashIndexJson = jsonEncode([]);

      final result = await service.pullAll();

      expect(result.success, isTrue,
          reason: 'Empty remote is not an error');
      expect(result.blocksPulled, 0);
      expect(result.entriesStaged, 0);
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'No blocks should be in DB after empty pull');
    });

    // B6
    test('B6: Block roundtrip: obfuscate → deobfuscate → JSON matches '
        'original', () async {
      // Genesis at index 0 satisfies _validateImportedChain's genesis-first
      // requirement; the day block links to it via prev_hash.
      final genesisJson = _genesisBlockJson(
          blockHash: 'genesis-hash', identitySeal: 'genesis-seal');

      final entryHash =
          computeEntryHash({'title': 'Test Entry', 'duration': 3600});
      final dayJson = _dayBlockJson(
        dayIndex: 5,
        prevHash: 'genesis-hash',
        blockHash: 'block-hash-5',
        identitySeal: 'seal-5',
        entries: [
          {
            'hash': entryHash,
            'data': {'title': 'Test Entry', 'duration': 3600},
          },
        ],
      );

      // Obfuscate locally, store in fake transport (genesis + day block)
      _storeObfuscatedBlock(transport, crypto, 0, genesisJson);
      _storeObfuscatedBlock(transport, crypto, 5, dayJson);
      transport.hashIndexJson =
          jsonEncode(['genesis-hash', 'block-hash-5']);

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 2);
      // Verify the block's data survived the roundtrip
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 2);
      // data_enc stores the full canonical block map (not a legacy entries
      // array), so decoding yields a Map whose `entries` carry the data.
      // blockIndex is the unique chain ordinal: genesis=0, day file index=1
      // (the day's `day_index: 5` is carried inside data_enc, not blockIndex).
      final dataEnc = blocks.lastWhere((b) => b.blockIndex == 1).dataEnc;
      final decoded = jsonDecode(utf8.decode(base64.decode(dataEnc)))
          as Map<String, dynamic>;
      final entries = decoded['entries'] as List<dynamic>;
      expect(entries.length, 1);
      expect((entries[0] as Map)['data']['title'], 'Test Entry');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group C: Import after Pull
  // ═════════════════════════════════════════════════════════════

  group('C: LedgerPullService — Import after Pull', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakePullTransport transport;
    late LedgerBackupService backupService;
    late StagingStorage stagingStorage;
    late LedgerPullService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakePullTransport();
      backupService = LedgerBackupService(db: db);
      stagingStorage = StagingStorage(db);
      service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
    });

    tearDown(() async {
      await db.close();
    });

    // C1
    test('C1: Pull all blocks → import into DB → 31 blocks in database',
        () async {
      final hashes = List.generate(31, (i) => 'import-hash-$i');
      transport.hashIndexJson = jsonEncode(hashes);

      for (var i = 0; i < 31; i++) {
        final prevHash = i == 0
            ? '0000000000000000000000000000000000000000000000000000000000000000'
            : 'import-hash-${i - 1}';
        final json = i == 0
            ? _genesisBlockJson(
                blockHash: 'import-hash-$i', identitySeal: 'import-hash-$i',
                prevHash: prevHash)
            : _dayBlockJson(
                dayIndex: i,
                prevHash: prevHash,
                blockHash: 'import-hash-$i',
                identitySeal: 'import-hash-$i',
              );
        _storeObfuscatedBlock(transport, crypto, i, json);
      }

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 31);
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 31,
          reason: 'All 31 blocks must be in database after pull+import');
    });

    // C2
    test('C2: Genesis block after import → correct identity_seal, '
        'block_index: 0, prev_hash', () async {
      transport.hashIndexJson = jsonEncode(['gen-hash']);
      _storeObfuscatedBlock(
        transport,
        crypto,
        0,
        _genesisBlockJson(
          blockHash: 'gen-hash',
          identitySeal: 'genesis-identity-seal-value',
          prevHash:
              '0000000000000000000000000000000000000000000000000000000000000000',
        ),
      );

      await service.pullAll();

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 1);
      final genesis = blocks[0];
      expect(genesis.blockIndex, 0,
          reason: 'Genesis must be at blockIndex 0');
      expect(genesis.blockType, BlockType.genesis);
      expect(
        genesis.prevHash,
        '0000000000000000000000000000000000000000000000000000000000000000',
        reason: 'Genesis prev_hash must be 64 zeros',
      );
      expect(genesis.identitySeal, 'genesis-identity-seal-value',
          reason: 'Genesis identity_seal must be preserved');
    });

    // C3
    test('C3: Pull + import → staging seeded with entries', () async {
      // Genesis block first (required by chain validation), then a day block
      // with spec-conformant entry hashes.
      _storeObfuscatedBlock(
        transport,
        crypto,
        0,
        _genesisBlockJson(blockHash: 'genesis-hash',
            identitySeal: 'genesis-identity-seal-value'),
      );

      final dataA = {'title': 'Task A', 'duration': 1800, 'tags': ['work']};
      final dataB = {'title': 'Task B', 'duration': 3600, 'tags': ['personal']};
      transport.hashIndexJson = jsonEncode(['genesis-hash', 'day-hash']);
      _storeObfuscatedBlock(
        transport,
        crypto,
        1,
        _dayBlockJson(
          dayIndex: 1,
          prevHash: 'genesis-hash',
          blockHash: 'day-hash',
          identitySeal: 'day-hash',
          entries: [
            {'hash': computeEntryHash(dataA), 'data': dataA},
            {'hash': computeEntryHash(dataB), 'data': dataB},
          ],
        ),
      );

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.entriesStaged, 2,
          reason: 'Two entries must be seeded to staging');
      expect(result.entriesStaged, greaterThan(0),
          reason: 'Staging must have entries after pull');
    });

    // C4
    test('C4: Pulled blocks match original structure (same entry count '
        'per block)', () async {
      // Block 0: genesis with 1 entry
      transport.hashIndexJson = jsonEncode(['g-hash', 'd-hash']);
      _storeObfuscatedBlock(
        transport,
        crypto,
        0,
        _genesisBlockJson(
          blockHash: 'g-hash',
          identitySeal: 'g-hash',
          entries: [
            {
              'hash': 'e-gen',
              'data': {'title': 'Genesis Entry', 'duration': 0},
            },
          ],
        ),
      );
      // Block 1: day with 3 entries
      _storeObfuscatedBlock(
        transport,
        crypto,
        1,
        _dayBlockJson(
          dayIndex: 1,
          prevHash: 'g-hash',
          blockHash: 'd-hash',
          identitySeal: 'd-hash',
          entries: [
            {
              'hash': computeEntryHash({'title': 'Task 1', 'duration': 100}),
              'data': {'title': 'Task 1', 'duration': 100},
            },
            {
              'hash': computeEntryHash({'title': 'Task 2', 'duration': 200}),
              'data': {'title': 'Task 2', 'duration': 200},
            },
            {
              'hash': computeEntryHash({'title': 'Task 3', 'duration': 300}),
              'data': {'title': 'Task 3', 'duration': 300},
            },
          ],
        ),
      );

      final result = await service.pullAll();

      expect(result.success, isTrue);
      expect(result.entriesStaged, 4,
          reason: '1 genesis entry + 3 day entries = 4 total staged');
    });

    // C5
    test('C5: Import replaces any existing blocks (clear + reimport)',
        () async {
      // First, insert a block into the DB manually
      await db.blockDao.insertBlock(Block(
        blockId: 'old-block',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode('[]')),
        identitySeal: 'old-seal',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      // Now pull — it should replace the existing block
      transport.hashIndexJson = jsonEncode(['new-hash']);
      _storeObfuscatedBlock(
        transport,
        crypto,
        0,
        _genesisBlockJson(
          blockHash: 'new-hash',
          identitySeal: 'new-seal',
        ),
      );

      final result = await service.pullAll();

      expect(result.success, isTrue);
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 1,
          reason: 'Old block should be replaced, not duplicated');
      expect(blocks[0].identitySeal, 'new-seal',
          reason: 'Imported block must replace pre-existing block');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group F: Error Handling
  // ═════════════════════════════════════════════════════════════

  group('F: LedgerPullService — Error Handling', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakePullTransport transport;
    late LedgerBackupService backupService;
    late StagingStorage stagingStorage;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakePullTransport();
      backupService = LedgerBackupService(db: db);
      stagingStorage = StagingStorage(db);
    });

    tearDown(() async {
      await db.close();
    });

    // F1
    test('F1: Pull with unreachable Worker → exception caught, result '
        'reports failure, genesis preserved locally', () async {
      // Insert a genesis block locally first
      await db.blockDao.insertBlock(Block(
        blockId: 'local-gen',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode('[]')),
        identitySeal: 'local-gen-seal',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      transport.unreachable = true;

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );

      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'Unreachable Worker must report failure');
      // Local genesis must still exist
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 1,
          reason: 'Local genesis must be preserved on pull failure');
      expect(blocks[0].blockId, 'local-gen');
    });

    // F2
    test('F2: Pull with wrong MK → CryptoException, no blocks imported',
        () async {
      // Obfuscate blocks with testMkHex, then try to pull with wrongMkHex
      transport.hashIndexJson = jsonEncode(['block-hash']);
      _storeObfuscatedBlock(
        transport,
        crypto,
        0,
        _genesisBlockJson(blockHash: 'block-hash', identitySeal: 'block-hash'),
      );

      // Create a crypto service with wrong MK
      final wrongCrypto = CryptoService();
      await wrongCrypto.initialize();
      wrongCrypto.setMasterKey(wrongMkHex);

      final service = LedgerPullService(
        db: db,
        crypto: wrongCrypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );

      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'Wrong MK must cause pull failure');
      expect(result.errors, isNotEmpty,
          reason: 'Crypto error must be reported');
      // No blocks should be imported
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, isEmpty,
          reason: 'No blocks should be imported with wrong MK');
    });

    // F3
    test('F3: Corrupted block on remote (invalid JSON) → that block '
        'skipped, others imported', () async {
      // Store 3 block hashes but make block 1 corrupted (non-JSON data)
      transport.hashIndexJson = jsonEncode(['h0', 'h1', 'h2']);
      _storeObfuscatedBlock(
          transport, crypto, 0, _genesisBlockJson(blockHash: 'h0',
              identitySeal: 'h0'));
      // Corrupt block 1: store garbage after obfuscation header
      final corrupted = crypto.obfuscateBlob('NOT VALID JSON', testMkHex);
      transport.blockStore['ledger/blocks/000001.json'] = corrupted;
      _storeObfuscatedBlock(
          transport,
          crypto,
          2,
          _dayBlockJson(
              dayIndex: 2,
              prevHash: 'h0',
              blockHash: 'h2',
              identitySeal: 'h2'));

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: 'Corrupted block must cause failure report');
      expect(result.blocksPulled, 2,
          reason: 'Blocks 0 and 2 should still be imported');
      expect(result.failedBlocks, contains(1),
          reason: 'Block 1 must be reported as failed');
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks.length, 2,
          reason: 'Two valid blocks must be in DB after pull');
    });

    // F4
    test('F4: Pull with 401 from Worker → HttpTransportException, result '
        'reports auth failure', () async {
      transport.statusOnPath['ledger/hash_index.json'] = 401;

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );
      final result = await service.pullAll();

      expect(result.success, isFalse,
          reason: '401 must cause failure');
      expect(result.errors.any((e) => e.contains('401')), isTrue,
          reason: 'Error must reference 401 status');
    });

    // ══════════════════════════════════════════════════════════
    // Group H: LedgerPullService — seeds staging after import
    // ══════════════════════════════════════════════════════════

    group('H: LedgerPullService — seeds staging after import', () {
      late AppDatabase db;
      late CryptoService crypto;
      late FakePullTransport transport;
      late LedgerBackupService backupService;
      late StagingStorage stagingStorage;
      late SyncService syncService;

      setUp(() async {
        db = AppDatabase.inMemory();
        crypto = CryptoService();
        await crypto.initialize();
        crypto.setMasterKey(testMkHex);
        transport = FakePullTransport(
          baseUrl: 'https://worker.example.com',
          apiKey: 'test-key',
        );
        backupService = LedgerBackupService(db: db);
        stagingStorage = StagingStorage(db);
        syncService = SyncService(
            storage: stagingStorage,
            crypto: crypto,
            stagingStore: StagingStore(db));
      });

      LedgerPullService _makeService() => LedgerPullService(
            db: db,
            crypto: crypto,
            transport: transport,
            backupService: backupService,
            stagingStorage: stagingStorage,
            stagingStore: StagingStore(db),
          );

      // H1
      test('H1: pullAll inserts entries into staging after block import',
          () async {
        transport.hashIndexJson = jsonEncode(['h0']);
        _storeObfuscatedBlock(
            transport, crypto, 0,
            _genesisBlockJson(blockHash: 'h0', identitySeal: 'h0', entries: [
              {'entry_id': 'e1', 'title': 'Test Activity', 'start_epoch': 1717200000000,
               'end_epoch': 1717203600000, 'duration': 3600000, 'is_active': false,
               'is_paused': false, 'tags': ['work'], 'date': '2024-06-01',
               'hash': 'abc123'},
            ]));

        final service = _makeService();
        final result = await service.pullAll();

        expect(result.success, isTrue);
        expect(result.entriesStaged, greaterThan(0),
            reason: 'Entries from imported blocks must be seeded into staging');

        // Verify staging has entries
        final stagingEntries = await syncService.getEntries();
        expect(stagingEntries, isNotEmpty,
            reason: 'Staging must contain entries after pullAll');
      });

      // H2
      test('H2: pullAll does NOT duplicate entries already in staging',
          () async {
        transport.hashIndexJson = jsonEncode(['h0']);
        _storeObfuscatedBlock(
            transport, crypto, 0,
            _genesisBlockJson(blockHash: 'h0', identitySeal: 'h0', entries: [
              {'entry_id': 'dup1', 'title': 'Activity 1',
               'start_epoch': 1717200000000, 'end_epoch': 1717203600000,
               'duration': 3600000, 'is_active': false, 'is_paused': false,
               'tags': [], 'date': '2024-06-01', 'hash': 'dup1'},
            ]));

        final service = _makeService();

        // First pull
        await service.pullAll();
        final countAfterFirst = (await syncService.getEntries()).length;

        // Second pull — same blocks
        await service.pullAll();
        final countAfterSecond = (await syncService.getEntries()).length;

        expect(countAfterSecond, countAfterFirst,
            reason: 'Second pullAll must not duplicate staging entries');
      });

      // H3
      test('H3: pullAll with empty remote does not crash', () async {
        // No hash_index.json → empty remote
        transport.hashIndexJson = null;

        final service = _makeService();
        final result = await service.pullAll();

        expect(result.success, isTrue);
        expect(result.blocksPulled, 0);
        // Should not crash or throw
        final stagingEntries = await syncService.getEntries();
        expect(stagingEntries, isEmpty,
            reason: 'Empty remote → no staging entries');
      });

      // H4
      test('H4: Staging entries have correct fields for UI rendering',
          () async {
        transport.hashIndexJson = jsonEncode(['h0']);
        _storeObfuscatedBlock(
            transport, crypto, 0,
            _genesisBlockJson(blockHash: 'h0', identitySeal: 'h0', entries: [
              {'entry_id': 'e2', 'title': 'UI Test Activity',
               'start_epoch': 1717200000000, 'end_epoch': 1717203600000,
               'duration': 3600000, 'is_active': false, 'is_paused': false,
               'tags': ['ui', 'test'], 'date': '2024-06-01',
               'hash': 'def456'},
            ]));

        final service = _makeService();
        await service.pullAll();

        final entries = await syncService.getEntries();
        expect(entries, isNotEmpty);
        for (final entry in entries) {
          // Required fields for Dashboard/History rendering
          expect(entry.containsKey('title'), isTrue,
              reason: 'Entry must have title for UI rendering');
          expect(entry.containsKey('start_epoch'), isTrue,
              reason: 'Entry must have start_epoch for date display');
          expect(entry.containsKey('duration'), isTrue,
              reason: 'Entry must have duration for time display');
          expect(entry.containsKey('tags'), isTrue,
              reason: 'Entry must have tags list');
        }
      });

      // H5
      test('H5: Seeded staging rows have row-level committed=true '
          '(not just in activity blob)', () async {
        transport.hashIndexJson = jsonEncode(['h0']);
        _storeObfuscatedBlock(
            transport, crypto, 0,
            _genesisBlockJson(blockHash: 'h0', identitySeal: 'h0', entries: [
              {'entry_id': 'e5', 'title': 'Committed Entry Check',
               'start_epoch': 1717200000000, 'end_epoch': 1717203600000,
               'duration': 3600000, 'is_active': false, 'is_paused': false,
               'tags': [], 'date': '2024-06-01', 'hash': 'xyz789'},
            ]));

        final service = _makeService();
        final result = await service.pullAll();

        expect(result.success, isTrue);
        expect(result.entriesStaged, 1);

        // Read raw staging rows (not through SyncService DTO layer)
        final stagingStore = StagingStore(db);
        final rows = await stagingStore.getAllRows();
        expect(rows, isNotEmpty);

        for (final row in rows) {
          expect(
            row['committed'],
            true,
            reason: 'Entries seeded from ledger blocks must have '
                'committed=true at the row level so MergeEngine '
                'can detect them during sync',
          );
          // Verify the activity blob also has committed=true
          final activity = jsonDecode(row['activity'] as String);
          expect(
            activity['committed'],
            true,
            reason: 'Activity blob must also carry committed for '
                '_stagingRowToDto display rendering',
          );
        }
      });
    });

    // F5
    test('F5: Concurrent pullAll() calls — second call waits for first',
        () async {
      transport.hashIndexJson = jsonEncode(['h0']);
      _storeObfuscatedBlock(
          transport, crypto, 0, _genesisBlockJson(blockHash: 'h0',
              identitySeal: 'h0'));

      final service = LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: stagingStorage,
        stagingStore: StagingStore(db),
      );

      // Fire two concurrent pullAll() calls
      final results = await Future.wait([
        service.pullAll(),
        service.pullAll(),
      ]);

      // Both must return PullResult (no crash)
      expect(results[0], isA<PullResult>());
      expect(results[1], isA<PullResult>());
      // At least one should have pulled successfully
      expect(
        results.any((r) => r.success),
        isTrue,
        reason: 'At least one concurrent call must succeed',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group J: validate-only import (no auto-heal) — 9 tests
  // Phase 1 Group J: _validateImportedChain rejects bad data
  // Covers: J1–J9
  // ═══════════════════════════════════════════════════════════════

  group('J: validate-only import (no auto-heal)', () {
    // ── Block builder helpers ──

    /// Compute obfuscated block bytes for a single block JSON.
    Uint8List _obfuscateBlock(
        CryptoService crypto, Map<String, dynamic> block, String mkHex) {
      final json = jsonEncode(block);
      return crypto.obfuscateBlob(json, mkHex);
    }

    /// Build a valid genesis block with jsonSort seal.
    Map<String, dynamic> _buildGenesis(CryptoService crypto, String mkHex) {
      final payload = {
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
      };
      final seal = crypto.seal(jsonSort(payload), mkHex);
      return {
        ...payload,
        'block_hash': seal,
        'format_version': '0.4.0',
        'key_version': 1,
        'username': 'u',
        'email': 'e@e.com',
        'recovery_seed_enc': 'seed',
        'identity_pub_key': 'pk',
        'identity_secret_enc_fallback': 'fb',
      };
    }

    /// Build a valid day block with correct entry hashes.
    Map<String, dynamic> _buildDayBlock(
        CryptoService crypto,
        String mkHex,
        String prevHash,
        List<Map<String, dynamic>> entries,
        {int dayIndex = 1}) {
      final normalizedEntries = entries.map((entry) {
        final data = Map<String, dynamic>.from(entry);
        data.remove('hash');
        final hash = computeEntryHash(data);
        return {'hash': hash, 'data': data};
      }).toList();

      final payload = {
        'type': 'day',
        'day_index': dayIndex,
        'date': '2025-01-02',
        'prev_hash': prevHash,
        'entries': normalizedEntries,
      };
      final seal = crypto.seal(jsonSort(payload), mkHex);
      return {...payload, 'day_hash': seal, 'key_version': 1};
    }

    /// Create a FakePullTransport with a complete valid chain.
    FakePullTransport _makeValidTransport(
        CryptoService crypto, String mkHex, List<Map<String, dynamic>> blocks) {
      final store = <String, Uint8List>{};
      for (var i = 0; i < blocks.length; i++) {
        final path = 'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
        store[path] = _obfuscateBlock(crypto, blocks[i], mkHex);
      }
      // Also include block paths for listFiles to find
      store['ledger/blocks/'] = Uint8List(0); // marker
      return FakePullTransport(
        blockStore: store,
        hashIndexJson: jsonEncode(List.filled(blocks.length, 'hash')),
      );
    }

    /// Create a LedgerPullService with the given transport.
    LedgerPullService _makePullService({
      required CryptoService crypto,
      required AppDatabase db,
      required FakePullTransport transport,
    }) {
      final backupService = LedgerBackupService(db: db);
      return LedgerPullService(
        db: db,
        crypto: crypto,
        transport: transport,
        backupService: backupService,
        stagingStorage: StagingStorage(db),
        stagingStore: StagingStore(db),
      );
    }

    // J1 — Valid chain with correct entry hashes passes validation
    test('J1 valid chain passes validation (no throw)', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);
      final genHash = genesis['block_hash'] as String;
      final day = _buildDayBlock(crypto, testMkHex, genHash, [
        {'title': 'Task 1', 'duration': 60},
        {'title': 'Task 2', 'duration': 120},
      ]);

      final transport = _makeValidTransport(crypto, testMkHex, [genesis, day]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      final result = await service.pullAll();
      expect(result.success, isTrue,
          reason: 'Valid chain with correct entry hashes must import cleanly');
    });

    // J2 — Entry hash mismatch throws FormatException (no auto-heal)
    test('J2 entry hash mismatch → pullAll fails (no auto-heal)', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);
      final genHash = genesis['block_hash'] as String;

      // Build a day block with intentionally wrong entry hash
      final badEntry = {
        'hash': 'ff' * 32, // wrong hash!
        'data': {'title': 'Bad entry', 'duration': 60},
      };
      final payload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genHash,
        'entries': [badEntry],
      };
      final seal = crypto.seal(jsonSort(payload), testMkHex);
      final badBlock = {...payload, 'day_hash': seal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, badBlock]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      expect(
        () => service.pullAll(),
        throwsA(isA<Exception>()),
        reason: 'Bad entry hashes must cause import failure — no auto-heal',
      );
    });

    // J3 — Prev_hash linkage break throws FormatException (no auto-heal)
    test('J3 prev_hash linkage break → pullAll fails (no auto-heal)', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);

      // Day block with prev_hash that doesn't link to genesis
      final payload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': 'ff' * 32, // wrong — should be genesis hash
        'entries': <Map<String, dynamic>>[],
      };
      final seal = crypto.seal(jsonSort(payload), testMkHex);
      final badBlock = {...payload, 'day_hash': seal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, badBlock]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      expect(
        () => service.pullAll(),
        throwsA(isA<Exception>()),
        reason: 'Prev_hash linkage breaks must cause import failure',
      );
    });

    // J4 — Genesis block missing type → throws
    test('J4 genesis missing type → import fails', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      // Genesis-like block without 'type' field
      final badGenesis = {
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
        'block_hash': 'aa' * 32,
        'format_version': '0.4.0',
        'key_version': 1,
      };

      final transport =
          _makeValidTransport(crypto, testMkHex, [badGenesis]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      expect(
        () => service.pullAll(),
        throwsA(isA<Exception>()),
        reason: 'Missing type field on first block must be detected',
      );
    });

    // J5 — Entry that is not a Map → throws
    test('J5 non-Map entry → import fails', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);
      final genHash = genesis['block_hash'] as String;

      // Day block with a string entry instead of Map
      final payload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genHash,
        'entries': ['not-a-map'], // invalid entry type
      };
      final seal = crypto.seal(jsonSort(payload), testMkHex);
      final badBlock = {...payload, 'day_hash': seal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, badBlock]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      expect(
        () => service.pullAll(),
        throwsA(isA<Exception>()),
        reason: 'Non-Map entries must be rejected at import',
      );
    });

    // J6 — Entry missing hash field → throws
    test('J6 entry missing hash → import fails', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);
      final genHash = genesis['block_hash'] as String;

      // Day block with entry missing hash
      final payload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genHash,
        'entries': [
          {'data': {'title': 'No hash', 'duration': 60}}
          // missing 'hash' field
        ],
      };
      final seal = crypto.seal(jsonSort(payload), testMkHex);
      final badBlock = {...payload, 'day_hash': seal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, badBlock]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      expect(
        () => service.pullAll(),
        throwsA(isA<Exception>()),
        reason: 'Entries missing hash field must be rejected',
      );
    });

    // J7 — Valid chain with jsonSort entries passes
    test('J7 jsonSort-format entries → import succeeds', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      final genesis = _buildGenesis(crypto, testMkHex);
      final genHash = genesis['block_hash'] as String;
      // _buildDayBlock already uses computeEntryHash + jsonSort seals
      final day = _buildDayBlock(crypto, testMkHex, genHash, [
        {'title': 'Flutter entry', 'duration': 100},
      ]);

      final transport = _makeValidTransport(crypto, testMkHex, [genesis, day]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      final result = await service.pullAll();
      expect(result.success, isTrue);
    });

    // J8 — Valid chain with Python-format entries passes
    test('J8 Python-format entries → import succeeds', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      // Build genesis with Python indent2 seal
      final genPayload = {
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
        'format_version': '0.4.0',
        'key_version': 1,
      };
      final genSeal = crypto.seal(jsonSortIndent2(genPayload), testMkHex);
      final genesis = {...genPayload, 'block_hash': genSeal};
      final genHash = genSeal;

      // Day block with correct entry hash (computed normally) but Python seal
      final entryData = {'title': 'CLI entry', 'duration': 200};
      final entryHash = computeEntryHash(entryData);
      final dayPayload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genHash,
        'entries': [
          {'hash': entryHash, 'data': entryData}
        ],
      };
      final daySeal = crypto.seal(jsonSortIndent2(dayPayload), testMkHex);
      final day = {...dayPayload, 'day_hash': daySeal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, day]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      final result = await service.pullAll();
      expect(result.success, isTrue,
          reason: 'Python indent2 formated chain must import and verify');
    });

    // J9 — Valid chain with JS no-space entries passes
    test('J9 JS no-space entries → import succeeds', () async {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(testMkHex);
      final db = AppDatabase.inMemory();

      // Build genesis with JS no-space seal
      final genPayload = {
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
        'format_version': '0.4.0',
        'key_version': 1,
      };
      final noSpaceGen = jsonSort(genPayload)
          .replaceAll(' ', '')
          .replaceAll('\n', '');
      final genSeal = crypto.seal(noSpaceGen, testMkHex);
      final genesis = {...genPayload, 'block_hash': genSeal};
      final genHash = genSeal;

      // Day block with correct entry hash but JS no-space seal
      final entryData = {'title': 'Web entry', 'duration': 150};
      final entryHash = computeEntryHash(entryData);
      final dayPayload = {
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genHash,
        'entries': [
          {'hash': entryHash, 'data': entryData}
        ],
      };
      final noSpaceDay = jsonSort(dayPayload)
          .replaceAll(' ', '')
          .replaceAll('\n', '');
      final daySeal = crypto.seal(noSpaceDay, testMkHex);
      final day = {...dayPayload, 'day_hash': daySeal, 'key_version': 1};

      final transport =
          _makeValidTransport(crypto, testMkHex, [genesis, day]);
      final service = _makePullService(
          crypto: crypto, db: db, transport: transport);

      final result = await service.pullAll();
      expect(result.success, isTrue,
          reason: 'JS no-space formated chain must import and verify');
    });
  });
}
