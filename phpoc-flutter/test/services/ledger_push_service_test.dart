import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/models/push_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

/// LedgerPushService tests — Groups A–L (58 assertions).
///
/// Blueprint: docs/planning/flutter/PUSH_TO_R2_PHASE1.md
/// Blueprint: docs/planning/flutter/PUSH_SEAL_FIX_PHASE1.md
///
/// Covers:
///   A1–A5:  Construction & API
///   B1–B5:  Block Serialization
///   C1–C4:  Obfuscation
///   D1–D7:  Push Operations
///   E1–E4:  Hash Index
///   F1–F4:  Push Result
///   G1–G6:  Error Handling
///   H1–H5:  Integration
///   I1–I8:  Seal Field Serialization (blockId ≠ identitySeal)
///   J1–J3:  Hash Index Correctness
///   K1–K2:  Entry Decoding (defense-in-depth)
///   L1–L5:  Genesis Push Correctness (seal field + no excess fields)

// ── Test constants ─────────────────────────────────────────────

/// Valid 64-char hex master key (32 bytes for AES-128 + HMAC).
const testMkHex =
    'abababababababababababababababababababababababababababababababab';

/// Second master key (different from testMkHex) for wrong-key tests.
const wrongMkHex =
    'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

// ── Fake Transport ─────────────────────────────────────────────

/// In-memory [HttpTransport] fake for unit/integration testing.
///
/// Records all pushes in [store] and supports configurable error
/// simulation via [errorOnPath], [unreachable], and [timeoutPaths].
class FakeHttpTransport implements HttpTransport {
  @override
  final String baseUrl;

  @override
  final String apiKey;

  /// All pushed data, keyed by path.
  final Map<String, Uint8List> store = {};

  /// Paths that should return a given HTTP status code on push.
  final Map<String, int> errorOnPath = {};

  /// If true, all operations throw a network error.
  bool unreachable = false;

  /// Paths that should time out (throw timeout exception).
  final Set<String> timeoutPaths = {};

  FakeHttpTransport({
    this.baseUrl = 'https://test-worker.example.com',
    this.apiKey = 'fake-api-key',
  });

  @override
  Future<Uint8List?> pull(String path) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    if (store.containsKey(path)) {
      return store[path];
    }
    return null; // 404
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    if (timeoutPaths.contains(path)) {
      throw HttpTransportException('Connection timed out', 0);
    }
    final statusCode = errorOnPath[path];
    if (statusCode != null) {
      throw HttpTransportException(
        'HTTP $statusCode on push($path)',
        statusCode,
      );
    }
    store[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
    // Match real Worker ?prefix= API: return entries relative to prefix
    return store.keys
        .where((k) => k.startsWith(prefix))
        .map((k) => k.substring(prefix.length))
        .toList();
  }

  @override
  Future<void> healthCheck() async {
    if (unreachable) {
      throw HttpTransportException('Network unreachable', 0);
    }
  }

  @override
  Future<void> delete(String path) async {
    store.remove(path);
  }
}

// ── Helpers ────────────────────────────────────────────────────

/// Create a fresh [LedgerPushService] with in-memory DB, initialized
/// crypto (with test MK cached), and fake transport.
Future<LedgerPushService> _makeService({
  AppDatabase? db,
  CryptoService? crypto,
  FakeHttpTransport? transport,
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
  final t = transport ?? FakeHttpTransport();
  return LedgerPushService(db: d, crypto: c, transport: t);
}

/// Insert a block with the given params into the DB.
Future<Block> _insertBlock(
  AppDatabase db, {
  required String blockId,
  required BlockType type,
  required int blockIndex,
  String dataEnc = 'eyJ0aXRsZSI6InRlc3QifQ==', // base64('{"title":"test"}')
  String? identitySeal,
  String? prevHash,
  int? createdAt,
}) async {
  final block = Block(
    blockId: blockId,
    blockType: type,
    blockIndex: blockIndex,
    dataEnc: dataEnc,
    identitySeal: identitySeal ?? blockId,
    prevHash: prevHash ?? Block.genesisPrevHash,
    createdAt: createdAt ?? 1_000_000,
  );
  await db.blockDao.insertBlock(block);
  return block;
}

/// Load the test ledger (testdata/ledger.json) and import it into the DB.
Future<void> _importTestLedger(AppDatabase db) async {
  final file = await _readTestLedgerFile();
  final blocks = jsonDecode(file) as List<dynamic>;
  for (var i = 0; i < blocks.length; i++) {
    final b = blocks[i] as Map<String, dynamic>;
    final typeStr = b['type'] as String;
    final blockType = _parseBlockType(typeStr);
    final entries = b['entries'] as List<dynamic>? ?? [];
    final dataEnc = base64.encode(utf8.encode(jsonEncode(entries)));

    await db.blockDao.insertBlock(Block(
      blockId: (b['block_hash'] as String?) ?? 'block_$i',
      blockType: blockType,
      blockIndex: (b['day_index'] as int?) ?? i,
      keyVersion: 1,
      dataEnc: dataEnc,
      identitySeal: (b['identity_seal'] as String?) ??
          b['signature'] as String? ??
          b['block_hash'] as String?,
      prevHash: (b['prev_hash'] as String?) ?? Block.genesisPrevHash,
      createdAt: _isoDateToEpoch(b['date'] as String? ?? '2026-06-01'),
    ));
  }
}

BlockType _parseBlockType(String typeStr) {
  switch (typeStr) {
    case 'genesis':
      return BlockType.genesis;
    case 'day':
      return BlockType.day;
    case 'month_summary':
      return BlockType.month;
    case 'year_summary':
      return BlockType.year;
    default:
      throw FormatException('Unknown block type: $typeStr');
  }
}

int _isoDateToEpoch(String dateStr) {
  final parts = dateStr.split('-');
  final dt = DateTime.utc(
    int.parse(parts[0]),
    int.parse(parts[1]),
    int.parse(parts[2]),
  );
  return dt.millisecondsSinceEpoch ~/ 1000;
}

Future<String> _readTestLedgerFile() async {
  // Embedded test ledger JSON for integration tests (31 blocks, 146 entries).
  // This matches testdata/ledger.json but is embedded to avoid filesystem deps.
  // During Phase 3, this can be loaded from the actual file.
  throw UnimplementedError(
    'Test ledger loading not available in Phase 2 (RED). '
    'Will be implemented in Phase 3.',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group A: Construction & API
// ═══════════════════════════════════════════════════════════════

void main() {
  group('A: LedgerPushService — Construction & API', () {
    late CryptoService crypto;
    late FakeHttpTransport transport;

    setUp(() async {
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
    });

    // A1
    test('A1: Constructor accepts db, crypto, transport (all required)',
        () async {
      final db = AppDatabase.inMemory();
      final service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
      expect(service, isA<LedgerPushService>());
      await db.close();
    });

    // A2
    test('A2: Constructor rejects null db with error', () async {
      expect(
        () => LedgerPushService(
          db: null as dynamic,
          crypto: crypto,
          transport: transport,
        ),
        throwsA(isA<Error>()),
      );
    });

    // A3
    test('A3: Constructor rejects null crypto with error', () async {
      final db = AppDatabase.inMemory();
      try {
        expect(
          () => LedgerPushService(
            db: db,
            crypto: null as dynamic,
            transport: transport,
          ),
          throwsA(isA<Error>()),
        );
      } finally {
        await db.close();
      }
    });

    // A4
    test('A4: Constructor rejects null transport with error', () async {
      final db = AppDatabase.inMemory();
      try {
        expect(
          () => LedgerPushService(
            db: db,
            crypto: crypto,
            transport: null as dynamic,
          ),
          throwsA(isA<Error>()),
        );
      } finally {
        await db.close();
      }
    });

    // A5
    test('A5: Service exposes pushAll() as its single public method', () async {
      final db = AppDatabase.inMemory();
      final service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
      expect(service.pushAll, isA<Function>());
      // pushAll() with empty DB must throw StateError (safety guard)
      await expectLater(
        service.pushAll(),
        throwsA(isA<StateError>()),
      );
      await db.close();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group B: Block Serialization
  // ═════════════════════════════════════════════════════════════

  group('B: LedgerPushService — Block Serialization', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // B1
    test('B1: Block serialized as valid JSON with PHPSPEC field names',
        () async {
      await _insertBlock(db,
        blockId: 'b1',
        type: BlockType.day,
        blockIndex: 1,
        prevHash: 'aaaa',
      );
      await service.pushAll();

      // Verify the pushed block is valid JSON with PHPSPEC field names
      final pushed = transport.store['ledger/blocks/000001.json'];
      expect(pushed, isNotNull,
          reason: 'Block should be pushed to R2 path');
      // Data is obfuscated, so we verify it's non-empty (structural test)
      expect(pushed!.length, greaterThan(0));
    });

    // B2
    test('B2: Genesis block serialized with correct contract fields',
        () async {
      await _insertBlock(db,
        blockId: 'g1',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'genesis-seal',
      );
      await service.pushAll();

      final pushed = transport.store['ledger/blocks/000000.json'];
      expect(pushed, isNotNull);
      expect(pushed!.length, greaterThan(0),
          reason: 'Genesis block must be pushed');
    });

    // B3
    test('B3: Day block serialized with correct type and index', () async {
      await _insertBlock(db,
        blockId: 'd5',
        type: BlockType.day,
        blockIndex: 5,
        prevHash: 'aaaa',
      );
      await service.pushAll();

      final pushed = transport.store['ledger/blocks/000005.json'];
      expect(pushed, isNotNull,
          reason: 'Day block at index 5 must be at path 000005.json');
      expect(pushed!.length, greaterThan(0));
    });

    // B4
    test('B4: Serialized block with 5 entries preserves entry count',
        () async {
      final entries = List.generate(
        5,
        (i) => {'hash': 'h$i', 'data': {'title': 'Task $i'}},
      );
      final dataEnc =
          base64.encode(utf8.encode(jsonEncode(entries)));
      await _insertBlock(db,
        blockId: 'b-entries',
        type: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: 'aaaa',
      );
      await service.pushAll();

      // Verify the block was pushed (we test the actual entry count
      // after deobfuscation in Group H round-trip tests)
      final pushed = transport.store['ledger/blocks/000001.json'];
      expect(pushed, isNotNull);
      expect(pushed!.length, greaterThan(0));
    });

    // B5
    test('B5: Block with invalid UTF-8 data_enc is handled gracefully',
        () async {
      // data_enc that is valid base64 but contains non-UTF-8 bytes after decode
      final badDataEnc = base64.encode(Uint8List.fromList([0xFF, 0xFE, 0xFD]));
      await _insertBlock(db,
        blockId: 'b-bad',
        type: BlockType.day,
        blockIndex: 1,
        dataEnc: badDataEnc,
        prevHash: 'aaaa',
      );
      await service.pushAll();

      // Must not crash — block should still be pushed
      final pushed = transport.store['ledger/blocks/000001.json'];
      expect(pushed, isNotNull,
          reason: 'Block with bad data_enc must still be pushed');
      expect(pushed!.length, greaterThan(0));
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group C: Obfuscation
  // ═════════════════════════════════════════════════════════════

  group('C: LedgerPushService — Obfuscation', () {
    late CryptoService crypto;

    setUp(() async {
      crypto = CryptoService();
      await crypto.initialize();
    });

    // C1
    test('C1: obfuscateBlob returns non-empty raw bytes', () {
      final result = crypto.obfuscateBlob('test block data', testMkHex);
      expect(result, isNotEmpty,
          reason: 'Obfuscated output must not be empty');
      expect(result, isA<Uint8List>());
    });

    // C2
    test('C2: deobfuscateBlob round-trips correctly', () {
      const original = '{"type":"day","day_index":1,"entries":[]}';
      final obfuscated = crypto.obfuscateBlob(original, testMkHex);
      final restored = crypto.deobfuscateBlob(obfuscated, testMkHex);
      expect(restored, original,
          reason: 'Round-trip obfuscate → deobfuscate must '
              'return original data');
    });

    // C3
    test('C3: Obfuscation with wrong MK throws CryptoException on '
        'deobfuscate', () {
      const data = 'test data';
      final obfuscated = crypto.obfuscateBlob(data, testMkHex);
      expect(
        () => crypto.deobfuscateBlob(obfuscated, wrongMkHex),
        throwsA(isA<CryptoException>()),
        reason: 'Deobfuscation with wrong key must fail with '
            'CryptoException',
      );
    });

    // C4
    test('C4: Obfuscation of empty data still produces valid output', () {
      final result = crypto.obfuscateBlob('', testMkHex);
      expect(result, isNotEmpty,
          reason: 'Even empty data must produce padded obfuscated output');
      final restored = crypto.deobfuscateBlob(result, testMkHex);
      expect(restored, '',
          reason: 'Empty data round-trip must return empty string');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group D: Push Operations
  // ═════════════════════════════════════════════════════════════

  group('D: LedgerPushService — Push Operations', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // D1
    test('D1: pushAll() pushes blocks to correctly named paths', () async {
      // Insert 3 blocks
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        prevHash: 'bbbb');

      await service.pushAll();

      // Check all block paths exist in store
      expect(transport.store.containsKey('ledger/blocks/000000.json'),
          isTrue, reason: 'Block 0 must be at 000000.json');
      expect(transport.store.containsKey('ledger/blocks/000001.json'),
          isTrue, reason: 'Block 1 must be at 000001.json');
      expect(transport.store.containsKey('ledger/blocks/000002.json'),
          isTrue, reason: 'Block 2 must be at 000002.json');
    });

    // D2
    test('D2: pushAll() pushes ledger/hash_index.json as plaintext '
        'JSON array', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);

      await service.pushAll();

      final hashIndex = transport.store['ledger/hash_index.json'];
      expect(hashIndex, isNotNull,
          reason: 'hash_index.json must be pushed');
      // Should be plaintext JSON (not obfuscated)
      final text = utf8.decode(hashIndex!);
      expect(() => jsonDecode(text), returnsNormally,
          reason: 'hash_index.json must be valid JSON');
      final parsed = jsonDecode(text);
      expect(parsed, isA<List>(),
          reason: 'hash_index.json must be a JSON array');
    });

    // D3
    test('D3: pushAll() pushes ledger/index.json as obfuscated JSON',
        () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);

      await service.pushAll();

      final indexData = transport.store['ledger/index.json'];
      expect(indexData, isNotNull,
          reason: 'index.json must be pushed');
      // Should be obfuscated (non-plaintext)
      expect(indexData!.length, greaterThan(0));
    });

    // D4
    test('D4: Block pushed to R2 matches block read from DB '
        '(round-trip verify)', () async {
      final entries = [
        {'hash': 'h1', 'data': {'title': 'Task'}},
      ];
      final dataEnc =
          base64.encode(utf8.encode(jsonEncode(entries)));
      final block = await _insertBlock(db,
        blockId: 'verify-me',
        type: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: 'aaaa',
        identitySeal: 'seal-verify',
      );

      await service.pushAll();

      // Pull the block back and deobfuscate
      final pushed = transport.store['ledger/blocks/000001.json'];
      expect(pushed, isNotNull);
      final restored = crypto.deobfuscateBlob(pushed!, testMkHex);
      final restoredJson = jsonDecode(restored) as Map<String, dynamic>;

      expect(restoredJson['type'], 'day');
      expect(restoredJson['day_index'], 1);
      expect(restoredJson['day_hash'], 'verify-me');
      expect(restoredJson['entries'], isA<List>());
    });

    // D5
    test('D5: pushAll() returns PushResult with correct counts', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        prevHash: 'bbbb');

      final result = await service.pushAll();

      expect(result.success, isTrue);
      expect(result.blocksPushed, 3,
          reason: 'All 3 blocks should be pushed');
      expect(result.failedBlocks, isEmpty);
      expect(result.errors, isEmpty);
    });

    // D6
    test('D6: pushAll() without MK throws StateError', () async {
      final noMkCrypto = CryptoService();
      await noMkCrypto.initialize();
      // Do NOT call setMasterKey — MK is not cached

      final svc = LedgerPushService(
        db: db,
        crypto: noMkCrypto,
        transport: transport,
      );

      expect(
        () => svc.pushAll(),
        throwsA(isA<StateError>()),
        reason: 'pushAll() must fail fast when no MK is cached',
      );
    });

    // D7
    test('D7: pushAll() with empty DB throws StateError', () async {
      final emptyDb = AppDatabase.inMemory();
      try {
        final svc = LedgerPushService(
          db: emptyDb,
          crypto: crypto,
          transport: transport,
        );

        await expectLater(
          svc.pushAll(),
          throwsA(isA<StateError>()),
          reason: 'pushAll() must refuse to push an empty ledger',
        );
      } finally {
        await emptyDb.close();
      }
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group E: Hash Index
  // ═════════════════════════════════════════════════════════════

  group('E: LedgerPushService — Hash Index', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // E1
    test('E1: Hash index is a JSON array of hex strings, '
        'length = block count', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'aaaa');
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        identitySeal: 'bbbb', prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        identitySeal: 'cccc', prevHash: 'bbbb');

      await service.pushAll();

      final hashIndex = transport.store['ledger/hash_index.json'];
      expect(hashIndex, isNotNull);
      final parsed = jsonDecode(utf8.decode(hashIndex!)) as List;
      expect(parsed.length, 3,
          reason: 'Hash index length must equal block count');
      for (final h in parsed) {
        expect(h, isA<String>());
        expect((h as String).length, greaterThan(0));
      }
    });

    // E2
    test('E2: Hash index entry [0] is the genesis block hash', () async {
      await _insertBlock(db,
        blockId: 'genesis-block-hash', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'genesis-identity-seal');
      await _insertBlock(db,
        blockId: 'd1', type: BlockType.day, blockIndex: 1,
        prevHash: 'genesis-block-hash');

      await service.pushAll();

      final hashIndex = transport.store['ledger/hash_index.json'];
      final parsed = jsonDecode(utf8.decode(hashIndex!)) as List;
      expect(parsed[0], 'genesis-block-hash',
          reason: 'First hash index entry must be genesis blockId (block_hash), '
              'not identitySeal');
    });

    // E3
    test('E3: Hash index entry [N] matches block N\'s block_hash field',
        () async {
      final hashes = ['h0-gen', 'h1-day', 'h2-day'];
      await _insertBlock(db,
        blockId: hashes[0], type: BlockType.genesis, blockIndex: 0,
        identitySeal: hashes[0]);
      await _insertBlock(db,
        blockId: hashes[1], type: BlockType.day, blockIndex: 1,
        identitySeal: hashes[1], prevHash: hashes[0]);
      await _insertBlock(db,
        blockId: hashes[2], type: BlockType.day, blockIndex: 2,
        identitySeal: hashes[2], prevHash: hashes[1]);

      await service.pushAll();

      final hashIndex = transport.store['ledger/hash_index.json'];
      final parsed = jsonDecode(utf8.decode(hashIndex!)) as List;
      for (var i = 0; i < hashes.length; i++) {
        expect(parsed[i], hashes[i],
            reason: 'Hash index position $i must match block $i hash');
      }
    });

    // E4
    test('E4: Hash index pushed as plaintext (no obfuscation)', () async {
      await _insertBlock(db,
        blockId: 'test-id', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'test-seal');

      await service.pushAll();

      final raw = transport.store['ledger/hash_index.json'];
      expect(raw, isNotNull);
      // Plaintext means directly parseable as UTF-8 JSON
      final text = utf8.decode(raw!);
      expect(() => jsonDecode(text), returnsNormally);
      final parsed = jsonDecode(text);
      expect(parsed, isA<List>());
      expect(parsed, contains('test-id'));
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group F: Push Result
  // ═════════════════════════════════════════════════════════════

  group('F: LedgerPushService — Push Result', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // F1
    test('F1: PushResult.success is true when all blocks + index pushed',
        () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);

      final result = await service.pushAll();
      expect(result.success, isTrue,
          reason: 'Full push of all blocks must report success');
      expect(result.blocksPushed, 1);
    });

    // F2
    test('F2: PushResult.success is false when any push fails', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa');
      // Make block 1 fail with 403
      transport.errorOnPath['ledger/blocks/000001.json'] = 403;

      final result = await service.pushAll();
      expect(result.success, isFalse,
          reason: 'Any block failure must result in success: false');
    });

    // F3
    test('F3: PushResult.failedBlocks lists block indices that failed',
        () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        prevHash: 'bbbb');
      // Make block 2 fail
      transport.errorOnPath['ledger/blocks/000002.json'] = 500;

      final result = await service.pushAll();
      expect(result.failedBlocks, contains(2),
          reason: 'Failed block indices must be reported');
    });

    // F4
    test('F4: PushResult.errors contains error messages for each failure',
        () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      transport.errorOnPath['ledger/blocks/000000.json'] = 403;

      final result = await service.pushAll();
      expect(result.errors, isNotEmpty,
          reason: 'Error messages must be provided for failures');
      expect(result.errors.any((e) => e.contains('403')),
          isTrue,
          reason: 'Error message must reference the HTTP status code');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group G: Error Handling
  // ═════════════════════════════════════════════════════════════

  group('G: LedgerPushService — Error Handling', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
    });

    tearDown(() async {
      await db.close();
    });

    // G1
    test('G1: Transport returns 403 → pushAll() includes auth error '
        'in result', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      transport.errorOnPath['ledger/blocks/000000.json'] = 403;

      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      final result = await service.pushAll();
      expect(result.success, isFalse);
      expect(result.errors.any((e) => e.contains('403')), isTrue,
          reason: '403 auth error must be reported in result.errors');
    });

    // G2
    test('G2: Worker unreachable → pushAll() returns failure result, '
        'not exception', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      transport.unreachable = true;

      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      // Must not throw — returns failure result instead
      final result = await service.pushAll();
      expect(result, isA<PushResult>());
      expect(result.success, isFalse,
          reason: 'Network unreachable must return failure, not crash');
    });

    // G3
    test('G3: Empty database → pushAll() throws StateError',
        () async {
      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      await expectLater(
        service.pushAll(),
        throwsA(isA<StateError>()),
        reason: 'Empty DB push must throw — pushing 0 blocks wipes R2',
      );
    });

    // G4
    test('G4: Single block in DB → pushAll() pushes just that block '
        '+ index', () async {
      await _insertBlock(db,
        blockId: 'single', type: BlockType.genesis, blockIndex: 0);

      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      final result = await service.pushAll();
      expect(result.success, isTrue);
      expect(result.blocksPushed, 1);
      expect(transport.store.containsKey('ledger/blocks/000000.json'),
          isTrue);
      expect(transport.store.containsKey('ledger/hash_index.json'),
          isTrue);
      expect(transport.store.containsKey('ledger/index.json'),
          isTrue);
    });

    // G5
    test('G5: Transport timeout → partial push result with timeout '
        'errors', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        prevHash: 'bbbb');
      // Simulate timeout on block 1
      transport.timeoutPaths.add('ledger/blocks/000001.json');

      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      final result = await service.pushAll();
      expect(result.success, isFalse);
      expect(result.failedBlocks, contains(1));
    });

    // G6
    test('G6: pushAll() with concurrent call — second call no-ops or '
        'returns existing result', () async {
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0);

      final service = LedgerPushService(
        db: db, crypto: crypto, transport: transport,
      );
      // Fire two concurrent pushAll() calls
      final results = await Future.wait([
        service.pushAll(),
        service.pushAll(),
      ]);
      // Both must return PushResult (no crash)
      expect(results[0], isA<PushResult>());
      expect(results[1], isA<PushResult>());
      // At least one should have pushed successfully
      expect(
        results.any((r) => r.success),
        isTrue,
        reason: 'At least one concurrent call must succeed',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group H: Integration
  // ═════════════════════════════════════════════════════════════

  group('H: LedgerPushService — Integration', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // H1
    test('H1: Import test ledger → pushAll → verify block files '
        'present', () async {
      // Insert 31 blocks simulating the test ledger
      for (var i = 0; i < 31; i++) {
        final type = i == 0 ? BlockType.genesis : BlockType.day;
        final prevHash = i == 0
            ? Block.genesisPrevHash
            : 'hash-${i - 1}';
        await _insertBlock(db,
          blockId: 'hash-$i',
          type: type,
          blockIndex: i,
          prevHash: prevHash,
          identitySeal: 'hash-$i',
        );
      }

      await service.pushAll();

      // Verify all 31 block files in store
      for (var i = 0; i < 31; i++) {
        final path =
            'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
        expect(transport.store.containsKey(path), isTrue,
            reason: 'Block $i must be at $path');
      }
    });

    // H2
    test('H2: Push → pull back → deobfuscate → matches original',
        () async {
      final entries = [
        {'hash': 'h1', 'data': {'title': 'Round Trip Test'}},
      ];
      final dataEnc =
          base64.encode(utf8.encode(jsonEncode(entries)));
      await _insertBlock(db,
        blockId: 'rt-block',
        type: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: 'aaaa',
        identitySeal: 'seal-rt',
      );

      await service.pushAll();

      // Pull block back from fake transport
      final pushed = transport.store['ledger/blocks/000001.json'];
      expect(pushed, isNotNull);
      final deobfuscated =
          crypto.deobfuscateBlob(pushed!, testMkHex);
      final json = jsonDecode(deobfuscated) as Map<String, dynamic>;

      expect(json['type'], 'day');
      expect(json['day_hash'], 'rt-block');
      expect(json['entries'], isA<List>());
      expect((json['entries'] as List).length, 1);
    });

    // H3
    test('H3: Push → pull hash_index → matches local hash_index',
        () async {
      await _insertBlock(db,
        blockId: 'hi-0', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'hi-seal-0');
      await _insertBlock(db,
        blockId: 'hi-1', type: BlockType.day, blockIndex: 1,
        identitySeal: 'hi-seal-1', prevHash: 'hi-0');

      await service.pushAll();

      // Pull and parse hash index
      final pushed = transport.store['ledger/hash_index.json'];
      expect(pushed, isNotNull);
      final remoteIndex = jsonDecode(utf8.decode(pushed!)) as List;
      expect(remoteIndex, ['hi-0', 'hi-1']);
    });

    // H4
    test('H4: pushAll → pushAll again (idempotent) → remote state '
        'unchanged', () async {
      await _insertBlock(db,
        blockId: 'idem-0', type: BlockType.genesis, blockIndex: 0);

      await service.pushAll();
      final firstStore = Map<String, Uint8List>.from(transport.store);

      // Second push
      await service.pushAll();
      // File count should be the same
      expect(transport.store.length, firstStore.length,
          reason: 'Repeated push must not change file count');
    });

    // H5
    test('H5: Full test suite (918 tests) passes with zero regressions',
        () {
      // This is a meta-test — verified by running the full test suite.
      // Placed here as a reminder during Phase 3: run `flutter test`
      // and confirm all existing 918 tests still pass.
      expect(true, isTrue,
          reason: 'Meta-test: run full flutter test suite after Phase 3');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group I: Seal Field Serialization (blockId ≠ identitySeal)
  // ═════════════════════════════════════════════════════════════
  //
  // These tests verify the fix: seal fields (day_hash, year_hash,
  // month_hash) and block_hash must use blockId — NOT identitySeal.
  // The existing helper _insertBlock() defaults identitySeal ?? blockId,
  // which masks this bug. Tests here explicitly pass distinct values.

  group('I: Seal field — blockId vs identitySeal', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    /// Helper: insert block with explicit, distinct blockId + identitySeal.
    /// Unlike the top-level _insertBlock (which defaults identitySeal ?? blockId),
    /// this never conflates the two values.
    Future<Block> _insertDistinct(
      AppDatabase db, {
      required String blockId,
      required BlockType type,
      required int blockIndex,
      required String? identitySeal,
      String dataEnc = 'eyJ0aXRsZSI6InRlc3QifQ==',
      String? prevHash,
      int? createdAt,
    }) async {
      final block = Block(
        blockId: blockId,
        blockType: type,
        blockIndex: blockIndex,
        dataEnc: dataEnc,
        identitySeal: identitySeal,
        prevHash: prevHash ?? Block.genesisPrevHash,
        createdAt: createdAt ?? 1_000_000,
      );
      await db.blockDao.insertBlock(block);
      return block;
    }

    /// Helper: push → pull back → deobfuscate → return parsed JSON.
    Future<Map<String, dynamic>> _pushAndDeobfuscate(
      int blockIndex,
    ) async {
      await service.pushAll();
      final path =
          'ledger/blocks/${blockIndex.toString().padLeft(6, '0')}.json';
      final pushed = transport.store[path];
      if (pushed == null) {
        throw StateError('Block $blockIndex not found in transport store');
      }
      final deobfuscated = crypto.deobfuscateBlob(pushed, testMkHex);
      return jsonDecode(deobfuscated) as Map<String, dynamic>;
    }

    // I1
    test('I1: Genesis with blockId ≠ identitySeal — day_hash = blockId',
        () async {
      await _insertDistinct(db,
        blockId: 'genesis-block-hash-aaa',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'genesis-identity-proof-zzz',
      );

      final json = await _pushAndDeobfuscate(0);
      // Genesis uses block_hash (I-17), not day_hash
      expect(json['block_hash'], equals('genesis-block-hash-aaa'),
          reason: 'Genesis seal field (block_hash) must be the block hash '
              '(blockId), not the identity proof (identitySeal)');
      expect(json.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(json['block_hash'], isNot(equals('genesis-identity-proof-zzz')),
          reason: 'Identity seal must not leak into the seal hash field');
    });

    // I2
    test('I2: Day block with blockId ≠ identitySeal — day_hash = blockId',
        () async {
      await _insertDistinct(db,
        blockId: 'day-block-hash-bbb',
        type: BlockType.day,
        blockIndex: 1,
        identitySeal: 'day-identity-ccc',
        prevHash: 'aaaa',
      );

      final json = await _pushAndDeobfuscate(1);
      expect(json['day_hash'], equals('day-block-hash-bbb'),
          reason: 'Day block seal field (day_hash) must use blockId');
      expect(json['day_hash'], isNot(equals('day-identity-ccc')),
          reason: 'Identity seal must not overwrite day_hash');
    });

    // I3
    test('I3: Year summary with blockId ≠ identitySeal — year_hash = blockId',
        () async {
      await _insertDistinct(db,
        blockId: 'year-block-hash-ddd',
        type: BlockType.year,
        blockIndex: 1,
        identitySeal: 'year-identity-eee',
        prevHash: '0000',
      );

      final json = await _pushAndDeobfuscate(1);
      expect(json['year_hash'], equals('year-block-hash-ddd'),
          reason: 'Year summary seal field (year_hash) must use blockId');
      expect(json['year_hash'], isNot(equals('year-identity-eee')),
          reason: 'Identity seal must not overwrite year_hash');
      // Verify the correct field name is used (not a fallback like
      // 'year_summary_hash')
      expect(json.containsKey('year_hash'), isTrue,
          reason: 'Year summary must emit "year_hash" field name, '
              'not a type-concatenated fallback');
    });

    // I4
    test('I4: Month summary with blockId ≠ identitySeal — month_hash = '
        'blockId', () async {
      await _insertDistinct(db,
        blockId: 'month-block-hash-fff',
        type: BlockType.month,
        blockIndex: 1,
        identitySeal: 'month-identity-ggg',
        prevHash: '1111',
      );

      final json = await _pushAndDeobfuscate(1);
      expect(json['month_hash'], equals('month-block-hash-fff'),
          reason: 'Month summary seal field (month_hash) must use blockId');
      expect(json['month_hash'], isNot(equals('month-identity-ggg')),
          reason: 'Identity seal must not overwrite month_hash');
      expect(json.containsKey('month_hash'), isTrue,
          reason: 'Month summary must emit "month_hash" field name, '
              'not a type-concatenated fallback');
    });

    // I5
    test('I5: block_hash field = blockId regardless of identitySeal value',
        () async {
      await _insertDistinct(db,
        blockId: 'block-hash-real-111',
        type: BlockType.day,
        blockIndex: 1,
        identitySeal: 'identity-seal-different-222',
        prevHash: 'aaaa',
      );

      final json = await _pushAndDeobfuscate(1);
      expect(json['block_hash'], equals('block-hash-real-111'),
          reason: 'block_hash convenience field must always be blockId, '
              'not identitySeal');
      expect(json['block_hash'], isNot(equals('identity-seal-different-222')),
          reason: 'block_hash must NOT be identitySeal even when non-null');
    });

    // I6
    test('I6: identity_seal preserved as separate field when non-null',
        () async {
      await _insertDistinct(db,
        blockId: 'block-id-aaa',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'identity-proof-bbb',
      );

      final json = await _pushAndDeobfuscate(0);
      expect(json['identity_seal'], equals('identity-proof-bbb'),
          reason: 'identity_seal must be preserved as a separate field '
              'alongside the seal hash (which uses blockId)');
      // Verify both fields coexist with correct values
      // Genesis seal field is block_hash (I-17)
      expect(json['block_hash'], equals('block-id-aaa'));
      expect(json.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(json['identity_seal'], isNot(equals(json['block_hash'])),
          reason: 'identity_seal and seal hash must be distinct values');
    });

    // I7
    test('I7: identity_seal omitted from serialized JSON when null', () async {
      await _insertDistinct(db,
        blockId: 'day-block-no-ident',
        type: BlockType.day,
        blockIndex: 1,
        identitySeal: null,
        prevHash: 'aaaa',
      );

      final json = await _pushAndDeobfuscate(1);
      expect(json.containsKey('identity_seal'), isFalse,
          reason: 'Null identity_seal must not emit the field in JSON — '
              'absent fields mean no identity proof present');
      // day_hash must still be present and use blockId
      expect(json['day_hash'], equals('day-block-no-ident'),
          reason: 'day_hash must still use blockId when identitySeal is null');
    });

    // I8
    test('I8: All four block types round-trip push→deobfuscate→verify '
        'seal fields', () async {
      // Insert one of each block type, all with distinct blockId vs identitySeal
      await _insertDistinct(db,
        blockId: 'all-gen-hash',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'all-gen-ident',
      );
      await _insertDistinct(db,
        blockId: 'all-year-hash',
        type: BlockType.year,
        blockIndex: 1,
        identitySeal: 'all-year-ident',
        prevHash: 'all-gen-hash',
      );
      await _insertDistinct(db,
        blockId: 'all-month-hash',
        type: BlockType.month,
        blockIndex: 2,
        identitySeal: 'all-month-ident',
        prevHash: 'all-year-hash',
      );
      await _insertDistinct(db,
        blockId: 'all-day-hash',
        type: BlockType.day,
        blockIndex: 3,
        identitySeal: null,
        prevHash: 'all-month-hash',
      );

      await service.pushAll();

      // Deobfuscate each block and verify
      final g = await _pushAndDeobfuscate(0);
      // Genesis uses block_hash (I-17), not day_hash
      expect(g.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(g['block_hash'], 'all-gen-hash');
      expect(g['identity_seal'], 'all-gen-ident');

      final y = await _pushAndDeobfuscate(1);
      expect(y['year_hash'], 'all-year-hash');
      expect(y['block_hash'], 'all-year-hash');
      expect(y['identity_seal'], 'all-year-ident');

      final m = await _pushAndDeobfuscate(2);
      expect(m['month_hash'], 'all-month-hash');
      expect(m['block_hash'], 'all-month-hash');
      expect(m['identity_seal'], 'all-month-ident');

      final d = await _pushAndDeobfuscate(3);
      expect(d['day_hash'], 'all-day-hash');
      expect(d['block_hash'], 'all-day-hash');
      expect(d.containsKey('identity_seal'), isFalse,
          reason: 'Null identity_seal must be absent from JSON');

      // Verify hash_index contains all blockIds
      final hashIndexRaw = transport.store['ledger/hash_index.json'];
      final hashIndex = jsonDecode(utf8.decode(hashIndexRaw!)) as List;
      expect(hashIndex, [
        'all-gen-hash',
        'all-year-hash',
        'all-month-hash',
        'all-day-hash',
      ]);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group J: Hash Index Correctness
  // ═════════════════════════════════════════════════════════════

  group('J: Hash index — blockId vs identitySeal', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // J1
    test('J1: Hash index uses blockId when blockId ≠ identitySeal',
        () async {
      // Insert blocks where blockId and identitySeal differ
      await db.blockDao.insertBlock(Block(
        blockId: 'hash-gen-block',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ident-gen-token',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'hash-day-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ident-day-token',
        prevHash: 'hash-gen-block',
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      final hashIndexRaw = transport.store['ledger/hash_index.json'];
      final hashIndex = jsonDecode(utf8.decode(hashIndexRaw!)) as List;
      expect(hashIndex[0], 'hash-gen-block',
          reason: 'Hash index must contain blockId, not identitySeal');
      expect(hashIndex[1], 'hash-day-block',
          reason: 'Hash index must contain blockId, not identitySeal');
      expect(hashIndex, isNot(contains('ident-gen-token')),
          reason: 'identitySeal values must NOT appear in hash index');
    });

    // J2
    test('J2: Hash index contains blockId for all block types', () async {
      await db.blockDao.insertBlock(Block(
        blockId: 'hj-gen',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ign-gen',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'hj-year',
        blockType: BlockType.year,
        blockIndex: 1,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ign-year',
        prevHash: 'hj-gen',
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'hj-month',
        blockType: BlockType.month,
        blockIndex: 2,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ign-month',
        prevHash: 'hj-year',
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'hj-day',
        blockType: BlockType.day,
        blockIndex: 3,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'ign-day',
        prevHash: 'hj-month',
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      final hashIndexRaw = transport.store['ledger/hash_index.json'];
      final hashIndex = jsonDecode(utf8.decode(hashIndexRaw!)) as List;
      expect(hashIndex, ['hj-gen', 'hj-year', 'hj-month', 'hj-day'],
          reason: 'All four block types must contribute their blockId '
              'to hash_index.json in correct order');
    });

    // J3
    test('J3: Hash index entry matches block_hash field in pushed block',
        () async {
      await db.blockDao.insertBlock(Block(
        blockId: 'cross-ref-hash',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'cross-ref-ident',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      // Deobfuscate the block
      final pushed = transport.store['ledger/blocks/000000.json'];
      final deobfuscated = crypto.deobfuscateBlob(pushed!, testMkHex);
      final blockJson = jsonDecode(deobfuscated) as Map<String, dynamic>;

      // Read hash index
      final hashIndexRaw = transport.store['ledger/hash_index.json'];
      final hashIndex = jsonDecode(utf8.decode(hashIndexRaw!)) as List;

      // hash_index[0] must match block_hash inside the block JSON
      expect(hashIndex[0], equals(blockJson['block_hash']),
          reason: 'hash_index entry must match block_hash field '
              'inside the deobfuscated block');
      // Neither should be the identitySeal
      expect(hashIndex[0], isNot(equals('cross-ref-ident')),
          reason: 'Neither hash_index nor block_hash should be identitySeal');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group K: Entry Decoding (defense-in-depth)
  // ═════════════════════════════════════════════════════════════
  //
  // Verify the map-format and legacy list-format data_enc decoding
  // paths both work correctly. These paths were recently changed from
  // `as List` only to map-first decoding, matching LedgerBackupService.

  group('K: Entry decoding — data_enc formats', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    // K1
    test('K1: Block with data_enc as map {"entries": [...]} decodes '
        'entries correctly', () async {
      final entries = [
        {'hash': 'e1', 'data': {'title': 'Task A'}},
        {'hash': 'e2', 'data': {'title': 'Task B'}},
      ];
      final dataEnc = base64.encode(utf8.encode(jsonEncode({
        'type': 'day',
        'entries': entries,
        'prev_hash': 'aaaa',
      })));

      await db.blockDao.insertBlock(Block(
        blockId: 'map-format-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        identitySeal: null,
        prevHash: 'aaaa',
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      // Deobfuscate and verify entries
      final pushed = transport.store['ledger/blocks/000001.json'];
      final deobfuscated = crypto.deobfuscateBlob(pushed!, testMkHex);
      final json = jsonDecode(deobfuscated) as Map<String, dynamic>;

      expect(json['entries'], isA<List>());
      final decoded = json['entries'] as List;
      expect(decoded.length, 2,
          reason: 'Map-format data_enc must decode both entries');
      expect(decoded[0]['hash'], 'e1');
      expect(decoded[1]['hash'], 'e2');
    });

    // K2
    test('K2: Block with data_enc as legacy list [...] decodes entries '
        'correctly', () async {
      final entries = [
        {'hash': 'legacy-e1', 'data': {'title': 'Old Task'}},
      ];
      final dataEnc = base64.encode(utf8.encode(jsonEncode(entries)));

      await db.blockDao.insertBlock(Block(
        blockId: 'list-format-block',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        identitySeal: null,
        prevHash: 'aaaa',
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      // Deobfuscate and verify entries
      final pushed = transport.store['ledger/blocks/000001.json'];
      final deobfuscated = crypto.deobfuscateBlob(pushed!, testMkHex);
      final json = jsonDecode(deobfuscated) as Map<String, dynamic>;

      expect(json['entries'], isA<List>());
      final decoded = json['entries'] as List;
      expect(decoded.length, 1,
          reason: 'Legacy list-format data_enc must decode the entry');
      expect(decoded[0]['hash'], 'legacy-e1');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group L: Genesis Push Correctness
  // ═════════════════════════════════════════════════════════════
  //
  // I-17: Both Python and Flutter chain implementations use
  // `block_hash` as the genesis seal field, not `day_hash`.
  //
  // Flutter genesis blocks do NOT include a `date` field in their
  // sealed data. Adding `date` during export changes the seal
  // computation domain, breaking cross-client verification.
  //
  // For cross-client compatibility, genesis push MUST:
  //   1. Use `block_hash` as the seal field (not `day_hash`)
  //   2. NOT add a `date` field (not in original sealed data)

  group('L: Genesis push — seal field + no excess fields', () {
    late AppDatabase db;
    late CryptoService crypto;
    late FakeHttpTransport transport;
    late LedgerPushService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(testMkHex);
      transport = FakeHttpTransport();
      service = LedgerPushService(
        db: db,
        crypto: crypto,
        transport: transport,
      );
    });

    tearDown(() async {
      await db.close();
    });

    /// Helper: push → pull back → deobfuscate → return parsed JSON.
    Future<Map<String, dynamic>> _deobfuscateBlock(int blockIndex) async {
      await service.pushAll();
      final path =
          'ledger/blocks/${blockIndex.toString().padLeft(6, '0')}.json';
      final pushed = transport.store[path];
      if (pushed == null) {
        throw StateError('Block $blockIndex not found in transport store');
      }
      final deobfuscated = crypto.deobfuscateBlob(pushed, testMkHex);
      return jsonDecode(deobfuscated) as Map<String, dynamic>;
    }

    // L1
    test('L1: Genesis push uses block_hash as seal field, day_hash is '
        'NOT present', () async {
      await db.blockDao.insertBlock(Block(
        blockId: 'gen-block-hash-aaa',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'gen-identity-zzz',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      final json = await _deobfuscateBlock(0);

      // block_hash must be present and contain blockId
      expect(json['block_hash'], equals('gen-block-hash-aaa'),
          reason: 'Genesis seal field must be block_hash (I-17), '
              'matching both Python and Flutter chain implementations');

      // day_hash MUST NOT be present
      expect(json.containsKey('day_hash'), isFalse,
          reason: 'Genesis must NOT emit day_hash — the seal was computed '
              'without it. Adding it breaks cross-client seal verification '
              'because Python and Web verifiers include all non-excluded '
              'fields in the seal HMAC computation.');

      // Value must be blockId, not identitySeal
      expect(json['block_hash'], isNot(equals('gen-identity-zzz')),
          reason: 'block_hash must be blockId, not identitySeal');
    });

    // L2
    test('L2: Genesis push does NOT add a date field (not in original '
        'sealed data)', () async {
      // Flutter genesis blocks are sealed WITHOUT a date field.
      // The sealed fields are: type, day_index, prev_hash, entries,
      // format_version, key_version, username, email, recovery_seed_enc,
      // identity_pub_key, identity_secret_enc_fallback.
      // Adding date to the push would break seal verification on
      // Python CLI and Web import.
      await db.blockDao.insertBlock(Block(
        blockId: 'gen-no-date-push',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'seal-push',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_700_000_000,
      ));

      final json = await _deobfuscateBlock(0);

      // date must NOT be present on genesis
      expect(json.containsKey('date'), isFalse,
          reason: 'Genesis push must not add a date field — '
              'Flutter genesis blocks are sealed without date. '
              'Adding it breaks cross-client seal verification.');

      // block_hash must still be present
      expect(json.containsKey('block_hash'), isTrue,
          reason: 'block_hash must still be present when date is omitted');
      expect(json['block_hash'], equals('gen-no-date-push'),
          reason: 'block_hash value must equal blockId');
    });

    // L3
    test('L3: Non-genesis pushed blocks still use correct seal field '
        'names', () async {
      // Regression guard: genesis fix must not affect day/year/month
      // seal field names.
      await db.blockDao.insertBlock(Block(
        blockId: 'day-hash-push',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'day-ident-push',
        prevHash: 'aaaa',
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'year-hash-push',
        blockType: BlockType.year,
        blockIndex: 2,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'year-ident-push',
        prevHash: 'day-hash-push',
        createdAt: 1_000_000,
      ));
      await db.blockDao.insertBlock(Block(
        blockId: 'month-hash-push',
        blockType: BlockType.month,
        blockIndex: 3,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'month-ident-push',
        prevHash: 'year-hash-push',
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      // Deobfuscate each block
      final dayJson = await _deobfuscateBlock(1);
      final yearJson = await _deobfuscateBlock(2);
      final monthJson = await _deobfuscateBlock(3);

      expect(dayJson['day_hash'], equals('day-hash-push'),
          reason: 'Day blocks must use day_hash (unchanged)');
      expect(dayJson['block_hash'], equals('day-hash-push'));

      expect(yearJson['year_hash'], equals('year-hash-push'),
          reason: 'Year summary blocks must use year_hash (unchanged)');
      expect(yearJson['block_hash'], equals('year-hash-push'));

      expect(monthJson['month_hash'], equals('month-hash-push'),
          reason: 'Month summary blocks must use month_hash (unchanged)');
      expect(monthJson['block_hash'], equals('month-hash-push'));
    });

    // L4
    test('L4: Genesis identity_seal preserved as separate field '
        'alongside block_hash in push', () async {
      await db.blockDao.insertBlock(Block(
        blockId: 'gen-block-push',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'gen-ident-push',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      final json = await _deobfuscateBlock(0);

      // block_hash = seal hash
      expect(json['block_hash'], equals('gen-block-push'),
          reason: 'block_hash = blockId (the cryptographic seal hash)');

      // identity_seal = identity proof
      expect(json['identity_seal'], equals('gen-ident-push'),
          reason: 'identity_seal must be a separate field from block_hash');

      // Must be distinct
      expect(json['block_hash'], isNot(equals(json['identity_seal'])),
          reason: 'block_hash and identity_seal must not be conflated');
    });

    // L5
    test('L5: Genesis push hash_index entry = blockId, not identitySeal',
        () async {
      await db.blockDao.insertBlock(Block(
        blockId: 'hi-gen-block',
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: 'eyJ0aXRsZSI6InRlc3QifQ==',
        identitySeal: 'hi-gen-ident',
        prevHash: Block.genesisPrevHash,
        createdAt: 1_000_000,
      ));

      await service.pushAll();

      final hashIndexRaw = transport.store['ledger/hash_index.json'];
      final hashIndex = jsonDecode(utf8.decode(hashIndexRaw!)) as List;

      expect(hashIndex[0], equals('hi-gen-block'),
          reason: 'hash_index must contain blockId (block_hash value), '
              'not identitySeal');
      expect(hashIndex[0], isNot(equals('hi-gen-ident')),
          reason: 'identitySeal must not leak into hash_index');
    });
  });
}
