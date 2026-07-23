import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';

/// LedgerBackupService tests — Groups A (7) + B (9) + C (3) + D (4) = 23 assertions.
///
/// Covers:
///   A1–A7:  PHPSPEC Export
///   B1–B9:  PHPSPEC Import
///   C1–C3:  Integration (round-trip, atomicity)
///   D1–D4:  Legacy format backward compatibility

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
      expect(b.containsKey('date'), isTrue);
      expect(b.containsKey('prev_hash'), isTrue);
      expect(b.containsKey('entries'), isTrue);
      expect(b.containsKey('day_hash'), isTrue,
          reason: 'Genesis uses "day_hash" per PHPSPEC §4.1 convention');
      expect(b.containsKey('block_hash'), isTrue);
      expect(b.containsKey('format_version'), isTrue,
          reason: 'Genesis must include format_version');
    });

    // A3
    test('A3: exportToJson of multiple blocks preserves count and PHPSPEC '
        'field names', () async {
      await _insertBlock(db,
        blockId: 'g', type: BlockType.genesis, blockIndex: 0,
        dataEnc: 'eyJnIjoxfQ==', // {"g":1}
        identitySeal: 'seal0',
      );
      await _insertBlock(db,
        blockId: 'd1', type: BlockType.day, blockIndex: 1,
        dataEnc: 'eyJkIjoxfQ==', identitySeal: 'seal1',
        prevHash: 'aaaa',
      );
      await _insertBlock(db,
        blockId: 'd2', type: BlockType.day, blockIndex: 2,
        dataEnc: 'eyJkIjoyfQ==', identitySeal: 'seal2',
        prevHash: 'bbbb',
      );

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks, hasLength(3));
      expect(blocks[0]['type'], 'genesis');
      expect(blocks[1]['type'], 'day');
      expect(blocks[2]['type'], 'day');
      expect(blocks[0]['day_hash'], 'seal0');
      expect(blocks[1]['day_hash'], 'seal1');
      expect(blocks[2]['day_hash'], 'seal2');
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

    // A5
    test('A5: exportToJson includes all block types with correct seal '
        'field names', () async {
      await _insertBlock(db,
        blockId: 'gen', type: BlockType.genesis, blockIndex: 0,
        identitySeal: 'seal-gen');
      await _insertBlock(db,
        blockId: 'year', type: BlockType.year, blockIndex: 1,
        prevHash: 'aaaa', identitySeal: 'seal-year');
      await _insertBlock(db,
        blockId: 'month', type: BlockType.month, blockIndex: 2,
        prevHash: 'bbbb', identitySeal: 'seal-month');
      await _insertBlock(db,
        blockId: 'day', type: BlockType.day, blockIndex: 3,
        prevHash: 'cccc', identitySeal: 'seal-day');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      expect(blocks, hasLength(4));
      expect(blocks.map((b) => b['type']),
          containsAll(['genesis', 'year_summary', 'month_summary', 'day']));
      // Each type uses its own seal field name
      expect(blocks[0]['day_hash'], 'seal-gen');
      expect(blocks[1]['year_hash'], 'seal-year');
      expect(blocks[2]['month_hash'], 'seal-month');
      expect(blocks[3]['day_hash'], 'seal-day');
    });

    // A6
    test('A6: exportToJson handles null identity_seal', () async {
      await _insertBlock(db,
        blockId: 'no-seal', type: BlockType.day, blockIndex: 0,
        identitySeal: null, prevHash: 'aaaa');

      final json = await service.exportToJson();
      final blocks = jsonDecode(json) as List;
      final b = blocks[0] as Map<String, dynamic>;
      expect(b['day_hash'], isNull,
          reason: 'Null identity_seal must serialize as null in PHPSPEC');
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
      expect(b.containsKey('date'), isTrue);
      expect(b.containsKey('prev_hash'), isTrue);
      expect(b.containsKey('entries'), isTrue);
      expect(b.containsKey('day_hash'), isTrue);
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
      expect(block.blockIndex, 5);
      expect(block.identitySeal, 'hmac-seal-value');
      expect(block.prevHash,
          'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
      expect(block.createdAt, greaterThan(0));
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
}
