import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';

/// LedgerBackupService tests — Groups A (7) + B (9) + C (3) + D (4) + E (6) + F (5) = 34 assertions.
///
/// Covers:
///   A1–A7:  PHPSPEC Export
///   B1–B9:  PHPSPEC Import
///   C1–C3:  Integration (round-trip, atomicity)
///   D1–D4:  Legacy format backward compatibility
///   E1–E6:  Export seal field correctness (blockId vs identitySeal)
///   F1–F5:  Genesis export correctness (seal field + no excess fields)

// ── Helpers ────────────────────────────────────────────────────

/// Create a fresh LedgerBackupService with in-memory DB.
Future<LedgerBackupService> _makeService({AppDatabase? db}) async {
  final d = db ?? AppDatabase.inMemory();
  return LedgerBackupService(db: d);
}

/// Insert a block with the given params (returns the block).
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
    identitySeal: identitySeal,
    prevHash: prevHash ?? Block.genesisPrevHash,
    createdAt: createdAt ?? 1_000_000,
  );
  await db.blockDao.insertBlock(block);
  return block;
}

// ═══════════════════════════════════════════════════════════════
// Group A: PHPSPEC Export
// ═══════════════════════════════════════════════════════════════

void main() {
  group('A: LedgerBackupService — PHPSPEC Export', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // A1
    test('A1: exportToJson returns empty JSON array for empty DB', () async {
      final json = await service.exportToJson();
      final parsed = jsonDecode(json) as List;
      expect(parsed, isEmpty, reason: 'Empty DB must export as []');
    });

    // A2
    test('A2: exportToJson of single genesis block produces valid '
        'PHPSPEC JSON with required fields', () async {
      await _insertBlock(db,
        blockId: 'genesis-1',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'abc123def456',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks, hasLength(1));

      final b = blocks[0] as Map<String, dynamic>;
      expect(b['type'], 'genesis');
      expect(b['day_index'], 0);
      // Genesis is sealed without date — must not emit it
      expect(b.containsKey('date'), isFalse,
          reason: 'Genesis must not include date (not in seal data)');
      expect(b.containsKey('prev_hash'), isTrue);
      expect(b.containsKey('entries'), isTrue);
      // Genesis seal field is block_hash (I-17), matching Python + Flutter chain
      expect(b.containsKey('block_hash'), isTrue,
          reason: 'Genesis uses block_hash as seal field (I-17)');
      expect(b.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(b.containsKey('format_version'), isTrue,
          reason: 'Genesis must include format_version');
    });

    // A3 — Uses blockId values that differ from identitySeal to verify
    // the seal field uses blockId, not identitySeal.
    test('A3: exportToJson of multiple blocks preserves count and PHPSPEC '
        'field names', () async {
      await _insertBlock(db,
        blockId: 'block-hash-g', type: BlockType.genesis, blockIndex: 0,
        dataEnc: 'eyJnIjoxfQ==', // {"g":1}
        identitySeal: 'identity-seal-g',
      );
      await _insertBlock(db,
        blockId: 'block-hash-d1', type: BlockType.day, blockIndex: 1,
        dataEnc: 'eyJkIjoxfQ==', identitySeal: 'identity-seal-d1',
        prevHash: 'aaaa',
      );
      await _insertBlock(db,
        blockId: 'block-hash-d2', type: BlockType.day, blockIndex: 2,
        dataEnc: 'eyJkIjoyfQ==', identitySeal: 'identity-seal-d2',
        prevHash: 'bbbb',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks, hasLength(3));
      expect(blocks[0]['type'], 'genesis');
      expect(blocks[1]['type'], 'day');
      expect(blocks[2]['type'], 'day');
      // Seal fields must use blockId, not identitySeal
      // Genesis uses block_hash (I-17)
      expect(blocks[0]['block_hash'], equals('block-hash-g'),
          reason: 'Genesis block_hash must be blockId');
      expect(blocks[0].containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(blocks[1]['day_hash'], equals('block-hash-d1'),
          reason: 'Day seal must be blockId, not identitySeal');
      expect(blocks[2]['day_hash'], equals('block-hash-d2'),
          reason: 'Day seal must be blockId, not identitySeal');
      // identity_seal must be preserved as a separate field
      expect(blocks[0]['identity_seal'], equals('identity-seal-g'),
          reason: 'Genesis identity_seal must be preserved separately');
      // Non-genesis blocks with identitySeal also preserve it
      expect(blocks[1]['identity_seal'], equals('identity-seal-d1'));
      expect(blocks[2]['identity_seal'], equals('identity-seal-d2'));
    });

    // A4
    test('A4: exportToJson maintains day_index order regardless of '
        'insert order', () async {
      // Insert out of order
      await _insertBlock(db,
        blockId: 'b2', type: BlockType.day, blockIndex: 2,
        dataEnc: 'eyJkIjoyfQ==');
      await _insertBlock(db,
        blockId: 'b0', type: BlockType.genesis, blockIndex: 0,
        dataEnc: 'eyJnIjoxfQ==');
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 1,
        dataEnc: 'eyJkIjoxfQ==');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks[0]['day_index'], 0);
      expect(blocks[1]['day_index'], 1);
      expect(blocks[2]['day_index'], 2);
    });

    // A5 — Uses distinct blockId values to prove seal field = blockId,
    // not identitySeal. identitySeal is tested as a separate field.
    test('A5: exportToJson includes all block types with correct seal '
        'field names from blockId', () async {
      await _insertBlock(db,
        blockId: 'kh-gen', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'ident-gen-only');
      await _insertBlock(db,
        blockId: 'kh-year', type: BlockType.year, blockIndex: 1,
        prevHash: 'aaaa');
      await _insertBlock(db,
        blockId: 'kh-month', type: BlockType.month, blockIndex: 2,
        prevHash: 'bbbb');
      await _insertBlock(db,
        blockId: 'kh-day', type: BlockType.day, blockIndex: 3,
        prevHash: 'cccc');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks, hasLength(4));
      expect(blocks.map((b) => b['type']),
          containsAll(['genesis', 'year_summary', 'month_summary', 'day']));
      // Each type's seal field = blockId
      // Genesis: block_hash (I-17)
      expect(blocks[0]['block_hash'], equals('kh-gen'),
          reason: 'Genesis block_hash = blockId');
      expect(blocks[0].containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      expect(blocks[1]['year_hash'], equals('kh-year'),
          reason: 'Year year_hash = blockId');
      expect(blocks[2]['month_hash'], equals('kh-month'),
          reason: 'Month month_hash = blockId');
      expect(blocks[3]['day_hash'], equals('kh-day'),
          reason: 'Day day_hash = blockId');
      // identity_seal preserved only for genesis
      expect(blocks[0]['identity_seal'], equals('ident-gen-only'),
          reason: 'Genesis identity_seal must be a separate field');
      expect(blocks[1].containsKey('identity_seal'), isFalse,
          reason: 'Null identity_seal must not emit the field');
    });

    // A6 — Updated: seal field must come from blockId, not identitySeal.
    // When identitySeal is null, the block's seal hash is blockId.
    test('A6: exportToJson uses blockId for seal field when identity_seal '
        'is null', () async {
      await _insertBlock(db,
        blockId: 'no-ident-seal-hash', type: BlockType.day, blockIndex: 0,
        identitySeal: null, prevHash: 'aaaa');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;
      expect(b['day_hash'], equals('no-ident-seal-hash'),
          reason: 'Seal field (day_hash) must use blockId, not null, '
              'when identitySeal is absent');
      expect(b['block_hash'], equals('no-ident-seal-hash'),
          reason: 'block_hash convenience field must also use blockId');
    });

    // A7
    test('A7: exportToJson uses PHPSPEC-compliant field names '
        '(not internal column names)', () async {
      await _insertBlock(db,
        blockId: 'spec-check', type: BlockType.genesis, blockIndex: 0);

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      // Must use PHPSPEC field names
      expect(b.containsKey('type'), isTrue);
      expect(b.containsKey('day_index'), isTrue);
      // Genesis is sealed without date
      expect(b.containsKey('date'), isFalse,
          reason: 'Genesis must not include date field');
      expect(b.containsKey('prev_hash'), isTrue);
      expect(b.containsKey('entries'), isTrue);
      // Genesis seal field is block_hash (I-17)
      expect(b.containsKey('block_hash'), isTrue,
          reason: 'Genesis uses block_hash as seal field');
      expect(b.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      // Must NOT contain legacy internal field names
      expect(b.containsKey('block_id'), isFalse);
      expect(b.containsKey('block_type'), isFalse);
      expect(b.containsKey('block_index'), isFalse);
      expect(b.containsKey('data_enc'), isFalse);
      expect(b.containsKey('created_at'), isFalse);
      expect(b.containsKey('key_version'), isFalse);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group B: PHPSPEC Import
  // ═════════════════════════════════════════════════════════════

  group('B: LedgerBackupService — PHPSPEC Import', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // B1
    test('B1: importFromJson with empty array is a no-op', () async {
      await service.importFromJson('[]');
      final count = await db.blockDao.getBlockCount();
      expect(count, 0, reason: 'Importing [] must result in zero blocks');
    });

    // B2
    test('B2: importFromJson inserts a single genesis block from PHPSPEC',
        () async {
      const json = '''
      [
        {
          "type": "genesis",
          "format_version": "0.4.0",
          "day_index": 0,
          "date": "2026-01-01",
          "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
          "entries": [],
          "day_hash": "seal-abc123",
          "block_hash": "seal-abc123"
        }
      ]''';

      await service.importFromJson(json);
      final block = await db.blockDao.getBlock('seal-abc123');
      expect(block, isNotNull);
      expect(block!.blockType, BlockType.genesis);
      expect(block.blockIndex, 0);
      expect(block.identitySeal, 'seal-abc123');
      // date "2026-01-01" → epoch
      expect(block.createdAt, greaterThan(0));
    });

    // B3
    test('B3: importFromJson inserts multiple blocks from PHPSPEC '
        'with correct order', () async {
      const json = '''
      [
        {"type":"genesis","day_index":0,"date":"2026-01-01",
         "prev_hash":"0000000000000000000000000000000000000000000000000000000000000000",
         "entries":[],"day_hash":"seal-g","block_hash":"seal-g"},
        {"type":"day","day_index":1,"date":"2026-01-02",
         "prev_hash":"seal-g","entries":[{"hash":"h1","data":{"title":"Task 1"}}],
         "day_hash":"seal-d1","block_hash":"seal-d1"},
        {"type":"day","day_index":2,"date":"2026-01-03",
         "prev_hash":"seal-d1","entries":[],
         "day_hash":"seal-d2","block_hash":"seal-d2"}
      ]''';

      await service.importFromJson(json);
      final count = await db.blockDao.getBlockCount();
      expect(count, 3);
      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks[0].blockIndex, 0);
      expect(blocks[1].blockIndex, 1);
      expect(blocks[2].blockIndex, 2);
    });

    // B4
    test('B4: importFromJson preserves all block fields from PHPSPEC',
        () async {
      const json = '''
      [
        {
          "type": "month_summary",
          "day_index": 5,
          "date": "2026-03-15",
          "prev_hash": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
          "entries": [],
          "month_hash": "hmac-seal-value",
          "block_hash": "block-id-month"
        }
      ]''';

      await service.importFromJson(json);
      final block = await db.blockDao.getBlock('block-id-month');
      expect(block, isNotNull);
      expect(block!.blockId, 'block-id-month');
      expect(block.blockType, BlockType.month);
      // blockIndex is the unique chain ordinal (array position), NOT the
      // PHPSPEC day_index — blocks.block_index has a SQLite UNIQUE constraint
      // and summary/day indices would collide otherwise (see fidelity C4).
      // The block's own day_index:5 is preserved inside data_enc below.
      expect(block.blockIndex, 0);
      expect(block.identitySeal, 'hmac-seal-value');
      expect(block.prevHash,
          'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
      expect(block.createdAt, greaterThan(0));
      // day_index survives the import inside the canonical data_enc map.
      final decoded = jsonDecode(utf8.decode(base64.decode(block.dataEnc)))
          as Map<String, dynamic>;
      expect(decoded['day_index'], 5,
          reason: 'day_index must be preserved inside data_enc');
    });

    // B5
    test('B5: importFromJson replaces existing blocks (overwrite)', () async {
      // Insert pre-existing block
      await _insertBlock(db,
        blockId: 'old-block', type: BlockType.genesis, blockIndex: 0);

      // Import new JSON that replaces it
      const json = '''
      [
        {"type":"day","day_index":0,"date":"2026-06-01",
         "prev_hash":"aa","entries":[],"day_hash":"new-seal","block_hash":"new-block"}
      ]''';

      await service.importFromJson(json);
      final count = await db.blockDao.getBlockCount();
      expect(count, 1, reason: 'Import must replace, not merge');
      final block = await db.blockDao.getBlock('new-block');
      expect(block, isNotNull);
      final oldBlock = await db.blockDao.getBlock('old-block');
      expect(oldBlock, isNull, reason: 'Old blocks must be cleared');
    });

    // B6
    test('B6: importFromJson clears index_entries along with blocks',
        () async {
      await _insertBlock(db,
        blockId: 'b1', type: BlockType.day, blockIndex: 0, prevHash: 'aa');
      await db.customStatement(
        "INSERT INTO index_entries (block_id, date, tag, entry_id) "
        "VALUES ('b1', '2026-01-01', 'test', 'e1')",
      );

      const json = '''
      [
        {"type":"genesis","day_index":0,"date":"2026-01-01",
         "prev_hash":"0000000000000000000000000000000000000000000000000000000000000000",
         "entries":[],"day_hash":"b2","block_hash":"b2"}
      ]''';

      await service.importFromJson(json);
      final indexRows = db.customSelect(
        'SELECT COUNT(*) AS cnt FROM index_entries',
      ).get();
      expect(indexRows.first.read<int>('cnt'), 0,
          reason: 'Index entries must be cleared on import');
    });

    // B7
    test('B7: importFromJson rejects invalid JSON', () async {
      expect(
        () => service.importFromJson('not-valid-json{{{'),
        throwsA(isA<FormatException>()),
        reason: 'Malformed JSON must be rejected before any DB write',
      );
    });

    // B8
    test('B8: importFromJson rejects PHPSPEC JSON with missing type field',
        () async {
      const json = '''
      [
        {"day_index":0,"date":"2026-01-01",
         "prev_hash":"aa","entries":[],"day_hash":"s1"}
      ]''';

      expect(
        () => service.importFromJson(json),
        throwsA(isA<FormatException>()),
        reason: 'Missing required field "type" must be rejected',
      );
    });

    // B9
    test('B9: importFromJson rejects invalid type value in PHPSPEC',
        () async {
      const json = '''
      [
        {"type":"invalid_type","day_index":0,"date":"2026-01-01",
         "prev_hash":"aa","entries":[],"invalid_type_hash":"s1"}
      ]''';

      expect(
        () => service.importFromJson(json),
        throwsA(isA<FormatException>()),
        reason: 'Unknown type must be rejected',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group C: Integration (PHPSPEC round-trip)
  // ═════════════════════════════════════════════════════════════

  group('C: LedgerBackupService — Integration', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // C1
    test('C1: PHPSPEC round-trip export → import → export produces '
        'identical JSON', () async {
      // Seed some blocks
      await _insertBlock(db,
        blockId: 'rt-gen', type: BlockType.genesis, blockIndex: 0,
        dataEnc: 'eyJnIjoxfQ==', identitySeal: 'seal-gen');
      await _insertBlock(db,
        blockId: 'rt-day1', type: BlockType.day, blockIndex: 1,
        dataEnc: 'eyJkIjoxfQ==', identitySeal: 'seal-d1', prevHash: 'aa');
      await _insertBlock(db,
        blockId: 'rt-day2', type: BlockType.day, blockIndex: 2,
        dataEnc: 'eyJkIjoyfQ==', identitySeal: 'seal-d2', prevHash: 'bb');

      final exported1 = await service.exportToJson();

      // Import into a fresh service
      final db2 = AppDatabase.inMemory();
      final service2 = await _makeService(db: db2);
      await service2.importFromJson(exported1);

      final exported2 = await service2.exportToJson();
      expect(exported2, exported1,
          reason: 'PHPSPEC round-trip must produce identical JSON');
      await db2.close();
    });

    // C2
    test('C2: importFromJson preserves exact block count from PHPSPEC',
        () async {
      const json = '''
      [
        {"type":"genesis","day_index":0,"date":"2026-01-01",
         "prev_hash":"0000000000000000000000000000000000000000000000000000000000000000",
         "entries":[],"day_hash":"s1","block_hash":"b1"},
        {"type":"day","day_index":1,"date":"2026-01-02",
         "prev_hash":"b1","entries":[],"day_hash":"s2","block_hash":"b2"},
        {"type":"day","day_index":2,"date":"2026-01-03",
         "prev_hash":"b2","entries":[],"day_hash":"s3","block_hash":"b3"},
        {"type":"month_summary","day_index":3,"date":"2026-02-01",
         "prev_hash":"b3","entries":[],"month_hash":"s4","block_hash":"b4"},
        {"type":"year_summary","day_index":4,"date":"2027-01-01",
         "prev_hash":"b4","entries":[],"year_hash":"s5","block_hash":"b5"}
      ]''';

      await service.importFromJson(json);
      final count = await db.blockDao.getBlockCount();
      expect(count, 5, reason: 'Imported block count must match PHPSPEC JSON');
    });

    // C3
    test('C3: importFromJson in transaction — failure rolls back', () async {
      // Pre-populate with a genesis block
      await _insertBlock(db,
        blockId: 'pre-gen', type: BlockType.genesis, blockIndex: 0);

      // Attempt to import with an invalid block after a valid one
      const json = '''
      [
        {"type":"day","day_index":0,"date":"2026-06-01",
         "prev_hash":"aa","entries":[],"day_hash":"txn-ok","block_hash":"txn-ok"},
        {"type":"invalid_type","day_index":1,"date":"2026-06-02",
         "prev_hash":"bb","entries":[]}
      ]''';

      try {
        await service.importFromJson(json);
      } on FormatException {
        // Expected — validation failure
      }

      // Pre-existing block must still be there (rollback)
      final preBlock = await db.blockDao.getBlock('pre-gen');
      expect(preBlock, isNotNull,
          reason: 'Pre-existing block must survive failed import');
      // The partially-inserted block must NOT be present
      final txnBlock = await db.blockDao.getBlock('txn-ok');
      expect(txnBlock, isNull,
          reason: 'Partially inserted block must be rolled back');
      final count = await db.blockDao.getBlockCount();
      expect(count, 1, reason: 'Only pre-existing block should remain');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group D: Legacy Format Backward Compatibility
  // ═════════════════════════════════════════════════════════════

  group('D: LedgerBackupService — Legacy format compatibility', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // D1
    test('D1: importFromJson accepts legacy format (block_type field)',
        () async {
      const json = '''
      [
        {
          "block_id": "legacy-genesis",
          "block_type": "genesis",
          "block_index": 0,
          "key_version": 1,
          "data_enc": "legacy-data",
          "identity_seal": null,
          "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
          "created_at": 1000000
        }
      ]''';

      await service.importFromJson(json);
      final block = await db.blockDao.getBlock('legacy-genesis');
      expect(block, isNotNull);
      expect(block!.blockType, BlockType.genesis);
      expect(block.dataEnc, 'legacy-data');
    });

    // D2
    test('D2: importFromJson accepts legacy format with all block types',
        () async {
      const json = '''
      [
        {"block_id":"g","block_type":"genesis","block_index":0,"key_version":1,
         "data_enc":"d","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","created_at":1},
        {"block_id":"y","block_type":"year","block_index":1,"key_version":1,
         "data_enc":"d","prev_hash":"aa","created_at":2},
        {"block_id":"m","block_type":"month","block_index":2,"key_version":1,
         "data_enc":"d","prev_hash":"bb","created_at":3},
        {"block_id":"d","block_type":"day","block_index":3,"key_version":1,
         "data_enc":"d","prev_hash":"cc","created_at":4}
      ]''';

      await service.importFromJson(json);
      final count = await db.blockDao.getBlockCount();
      expect(count, 4);
    });

    // D3
    test('D3: importFromJson rejects legacy JSON with missing block_id',
        () async {
      const json = '''
      [
        {"block_type":"genesis","block_index":0,"key_version":1,
         "data_enc":"d","prev_hash":"aa","created_at":1}
      ]''';

      expect(
        () => service.importFromJson(json),
        throwsA(isA<FormatException>()),
        reason: 'Missing required legacy field "block_id" must be rejected',
      );
    });

    // D4
    test('D4: importFromJson rejects legacy JSON with invalid block_type',
        () async {
      const json = '''
      [
        {"block_id":"bad","block_type":"invalid_type","block_index":0,
         "key_version":1,"data_enc":"d","prev_hash":"aa","created_at":1}
      ]''';

      expect(
        () => service.importFromJson(json),
        throwsA(isA<FormatException>()),
        reason: 'Unknown block_type in legacy format must be rejected',
      );
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group E: Export seal field correctness (blockId vs identitySeal)
  // ═════════════════════════════════════════════════════════════
  //
  // The seal field (day_hash, year_hash, month_hash) in PHPSPEC export
  // must contain the block's actual hash (blockId), NOT the identity seal.
  // identitySeal is a separate concept — a cryptographic identity proof
  // present primarily on genesis blocks.

  group('E: Export seal field — blockId vs identitySeal', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // E1
    test('E1: genesis with different blockId and identitySeal uses '
        'blockId for seal field', () async {
      await _insertBlock(db,
        blockId: 'actual-block-hash-123',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'different-identity-seal-456',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      // Seal field (block_hash for genesis per I-17) must be blockId,
      // NOT identitySeal. Genesis uses block_hash, not day_hash.
      expect(b['block_hash'], equals('actual-block-hash-123'),
          reason: 'Seal field (block_hash) must contain the block hash '
              '(blockId), not the identity seal');
      expect(b.containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      // identitySeal should NOT leak into the seal field
      expect(b['block_hash'], isNot(equals('different-identity-seal-456')),
          reason: 'identity seal must not overwrite the seal hash field');
    });

    // E2
    test('E2: day block with null identitySeal uses blockId for '
        'seal field (regression: was null)', () async {
      await _insertBlock(db,
        blockId: 'day-block-hash-abc',
        type: BlockType.day,
        blockIndex: 0,
        identitySeal: null,
        prevHash: 'aaaa',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      expect(b['day_hash'], equals('day-block-hash-abc'),
          reason: 'Non-genesis blocks typically have null identitySeal — '
              'seal field must not be null, must use blockId');
      expect(b['block_hash'], equals('day-block-hash-abc'),
          reason: 'block_hash must match blockId when identitySeal is null');
    });

    // E3
    test('E3: all block types export correct seal field from blockId',
        () async {
      await _insertBlock(db,
        blockId: 'gen-hash', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'gen-ident');
      await _insertBlock(db,
        blockId: 'year-hash', type: BlockType.year, blockIndex: 1,
        prevHash: 'gen-hash');
      await _insertBlock(db,
        blockId: 'month-hash', type: BlockType.month, blockIndex: 2,
        prevHash: 'year-hash');
      await _insertBlock(db,
        blockId: 'day-hash', type: BlockType.day, blockIndex: 3,
        prevHash: 'month-hash');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;

      // Genesis: block_hash = blockId (I-17), not day_hash
      expect(blocks[0]['block_hash'], equals('gen-hash'),
          reason: 'genesis block_hash = blockId');
      expect(blocks[0].containsKey('day_hash'), isFalse,
          reason: 'Genesis must not emit day_hash');
      // Year: year_hash = blockId
      expect(blocks[1]['year_hash'], equals('year-hash'),
          reason: 'year_summary year_hash = blockId');
      // Month: month_hash = blockId
      expect(blocks[2]['month_hash'], equals('month-hash'),
          reason: 'month_summary month_hash = blockId');
      // Day: day_hash = blockId
      expect(blocks[3]['day_hash'], equals('day-hash'),
          reason: 'day day_hash = blockId');

      // All block_hash fields = blockId
      for (var i = 0; i < blocks.length; i++) {
        final expectedHash = ['gen-hash', 'year-hash', 'month-hash', 'day-hash'][i];
        expect(blocks[i]['block_hash'], equals(expectedHash),
            reason: 'Block $i block_hash must equal blockId');
      }
    });

    // E4
    test('E4: block_hash field uses blockId regardless of block type',
        () async {
      await _insertBlock(db,
        blockId: 'genesis-block-id', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'some-identity-seal');
      await _insertBlock(db,
        blockId: 'day-block-id', type: BlockType.day, blockIndex: 1,
        prevHash: 'genesis-block-id', identitySeal: null);

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;

      expect(blocks[0]['block_hash'], equals('genesis-block-id'),
          reason: 'Genesis block_hash must be blockId, not identitySeal');
      expect(blocks[1]['block_hash'], equals('day-block-id'),
          reason: 'Day block_hash must be blockId');
    });

    // E5
    test('E5: round-trip preserves correct seal when blockId differs '
        'from identitySeal', () async {
      // Genesis with distinct blockId and identitySeal
      await _insertBlock(db,
        blockId: 'genesis-hash-aaa',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'genesis-identity-zzz',
        dataEnc: 'eyJnIjoxfQ==', // {"g":1}
      );
      await _insertBlock(db,
        blockId: 'day-hash-bbb',
        type: BlockType.day,
        blockIndex: 1,
        identitySeal: null,
        prevHash: 'genesis-hash-aaa',
        dataEnc: 'eyJkIjoxfQ==', // {"d":1}
      );

      final exported1 = await service.exportToJson();

      // Import into a fresh DB
      final db2 = AppDatabase.inMemory();
      final service2 = await _makeService(db: db2);
      await service2.importFromJson(exported1);

      // Export again and verify seal fields match
      final exported2 = await service2.exportToJson();
      final blocks2 = jsonDecode(exported2) as List;

      expect(blocks2[0]['block_hash'], equals('genesis-hash-aaa'),
          reason: 'Round-trip: genesis block_hash must be preserved');
      expect(blocks2[0].containsKey('day_hash'), isFalse,
          reason: 'Round-trip: genesis must not emit day_hash');
      expect(blocks2[1]['day_hash'], equals('day-hash-bbb'),
          reason: 'Round-trip: day day_hash must be preserved');
      expect(blocks2[0]['block_hash'], equals('genesis-hash-aaa'),
          reason: 'Round-trip: genesis block_hash must be preserved');
      expect(blocks2[1]['block_hash'], equals('day-hash-bbb'),
          reason: 'Round-trip: day block_hash must be preserved');

      // The prev_hash linkage must remain intact
      expect(blocks2[1]['prev_hash'], equals('genesis-hash-aaa'),
          reason: 'Round-trip: prev_hash linkage must survive');

      await db2.close();
    });

    // E6
    test('E6: export of block with data_enc containing seal hash uses '
        'DB-authoritative blockId (not data_enc value)', () async {
      // Simulate a block where data_enc contains a seal hash that
      // differs from the DB blockId (e.g., old buggy data).
      // The export must use the DB-authoritative blockId.
      final dataEncWithHash = base64.encode(utf8.encode(jsonEncode({
        'type': 'day',
        'day_hash': 'old-wrong-hash-from-data-enc',
        'prev_hash': 'aaaa',
        'entries': <Map<String, dynamic>>[],
      })));

      await _insertBlock(db,
        blockId: 'correct-db-block-id',
        type: BlockType.day,
        blockIndex: 0,
        dataEnc: dataEncWithHash,
        identitySeal: null,
        prevHash: 'aaaa',
      );

      final exported = await service.exportToJson();
      final blocks = jsonDecode(exported) as List;
      final b = blocks[0] as Map<String, dynamic>;

      expect(b['day_hash'], equals('correct-db-block-id'),
          reason: 'Seal field must use DB-authoritative blockId, not '
              'stale value from data_enc');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group F: Genesis Export Correctness
  // ═════════════════════════════════════════════════════════════
  //
  // I-17: Both Python (chain.py) and Flutter (chain.dart) use
  // `block_hash` as the genesis seal field, NOT `day_hash`. PHPSPEC
  // §4.1 says `day_hash` is a "historical convention" — both
  // implementations have moved to `block_hash`.
  //
  // Flutter's LedgerChain.buildGenesisBlock() does NOT include a
  // `date` field in genesis — the seal was computed without it.
  // Adding `date` in export would change the seal data and break
  // verification on import by Python CLI or Web (both of which
  // include `date` in seal computation).
  //
  // For cross-client compatibility, genesis export MUST:
  //   1. Use `block_hash` as the seal field (not `day_hash`)
  //   2. NOT add a `date` field (not in original sealed data)

  group('F: Genesis export — seal field + no excess fields', () {
    late AppDatabase db;
    late LedgerBackupService service;

    setUp(() async {
      db = AppDatabase.inMemory();
      service = await _makeService(db: db);
    });

    tearDown(() async {
      await db.close();
    });

    // F1
    test('F1: Genesis export uses block_hash as the sole seal field, '
        'day_hash is NOT present', () async {
      await _insertBlock(db,
        blockId: 'genesis-block-hash-abc',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'genesis-identity-xyz',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      // block_hash must be present and contain the block's seal hash
      expect(b['block_hash'], equals('genesis-block-hash-abc'),
          reason: 'Genesis seal field must be block_hash (I-17), '
              'matching both Python and Flutter chain implementations');

      // day_hash MUST NOT be present on genesis (it was never in the
      // sealed data — adding it would break verification)
      expect(b.containsKey('day_hash'), isFalse,
          reason: 'Genesis must NOT emit day_hash — the seal was computed '
              'without it. Both Python and Flutter verifiers would include '
              'an unexpected day_hash field in seal computation, '
              'producing a different HMAC and failing verification.');

      // The value in block_hash must be blockId, not identitySeal
      expect(b['block_hash'], isNot(equals('genesis-identity-xyz')),
          reason: 'block_hash must be blockId, not identitySeal');
    });

    // F2
    test('F2: Genesis export does NOT add a date field (not in original '
        'sealed data)', () async {
      // Flutter's LedgerChain.buildGenesisBlock() creates genesis without
      // a `date` field. The seal was computed over: type, day_index,
      // prev_hash, entries, format_version, key_version, username, email,
      // recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback.
      // Adding `date` to the export would cause seal verification to fail
      // on Python CLI (which includes all non-excluded fields in seal
      // computation) and Web (same).
      await _insertBlock(db,
        blockId: 'genesis-no-date',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'seal-val',
        createdAt: 1_700_000_000, // some epoch value exists in DB
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      // date must NOT be present on genesis
      expect(b.containsKey('date'), isFalse,
          reason: 'Genesis export must not add a date field — '
              'Flutter genesis blocks are sealed without date. '
              'Adding it breaks cross-client seal verification.');

      // block_hash must still be present (defense-in-depth)
      expect(b.containsKey('block_hash'), isTrue,
          reason: 'block_hash must still be present on genesis when date '
              'is omitted');
    });

    // F3
    test('F3: Non-genesis blocks still use correct type-specific seal '
        'field names', () async {
      // Regression guard: the seal field name fix for genesis must not
      // affect day, year, or month block seal field names.
      await _insertBlock(db,
        blockId: 'day-hash', type: BlockType.day, blockIndex: 1,
        prevHash: 'aaaa', identitySeal: 'day-ident');
      await _insertBlock(db,
        blockId: 'year-hash', type: BlockType.year, blockIndex: 2,
        prevHash: 'day-hash', identitySeal: 'year-ident');
      await _insertBlock(db,
        blockId: 'month-hash', type: BlockType.month, blockIndex: 3,
        prevHash: 'year-hash', identitySeal: 'month-ident');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;

      // Day block: seal field is day_hash
      expect(blocks[0]['day_hash'], equals('day-hash'),
          reason: 'Day blocks must use day_hash (unchanged)');
      expect(blocks[0]['block_hash'], equals('day-hash'));

      // Year summary: seal field is year_hash
      expect(blocks[1]['year_hash'], equals('year-hash'),
          reason: 'Year summary blocks must use year_hash (unchanged)');
      expect(blocks[1]['block_hash'], equals('year-hash'));

      // Month summary: seal field is month_hash
      expect(blocks[2]['month_hash'], equals('month-hash'),
          reason: 'Month summary blocks must use month_hash (unchanged)');
      expect(blocks[2]['block_hash'], equals('month-hash'));

      // Non-genesis blocks MAY have date (day blocks include date in seal)
      // This is correct — day blocks ARE sealed with date.
    });

    // F4
    test('F4: Genesis export identity_seal preserved as separate field '
        'alongside block_hash', () async {
      await _insertBlock(db,
        blockId: 'gen-block-id',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'gen-identity-proof',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;

      // block_hash = seal hash (blockId)
      expect(b['block_hash'], equals('gen-block-id'),
          reason: 'block_hash = blockId (the cryptographic seal hash)');

      // identity_seal = identity proof (separate from seal hash)
      expect(b['identity_seal'], equals('gen-identity-proof'),
          reason: 'identity_seal must be preserved as a separate field — '
              'it is an identity cryptographic proof, not the block seal');

      // These two fields must be distinct
      expect(b['block_hash'], isNot(equals(b['identity_seal'])),
          reason: 'block_hash and identity_seal serve different purposes '
              'and must not be conflated');
    });

    // F5
    test('F5: Genesis round-trip preserves block_hash and omits day_hash',
        () async {
      await _insertBlock(db,
        blockId: 'rt-genesis-block-hash',
        type: BlockType.genesis,
        blockIndex: 0,
        identitySeal: 'rt-genesis-identity',
        dataEnc: 'eyJnIjoxfQ==', // {"g":1}
      );

      final exported1 = await service.exportToJson();

      // Verify export format is correct before round-tripping
      final blocks1 = jsonDecode(exported1) as List;
      expect(blocks1[0]['block_hash'], equals('rt-genesis-block-hash'),
          reason: 'Pre-round-trip: genesis block_hash = blockId');

      // Import into a fresh DB
      final db2 = AppDatabase.inMemory();
      final service2 = await _makeService(db: db2);
      await service2.importFromJson(exported1);

      // Export again
      final exported2 = await service2.exportToJson();
      final blocks2 = jsonDecode(exported2) as List;

      // After round-trip, block_hash must still be blockId
      expect(blocks2[0]['block_hash'], equals('rt-genesis-block-hash'),
          reason: 'Round-trip: genesis block_hash must be preserved '
              'as blockId');

      // identity_seal must also be preserved
      expect(blocks2[0]['identity_seal'], equals('rt-genesis-identity'),
          reason: 'Round-trip: genesis identity_seal must survive');

      // day_hash must NOT appear after round-trip
      expect(blocks2[0].containsKey('day_hash'), isFalse,
          reason: 'Round-trip: genesis must not gain a day_hash field '
              'that was not in the original sealed data');

      await db2.close();
    });
  });
}
