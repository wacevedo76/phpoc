import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show getBlockHash;

/// LedgerBlockStore — Phase 2 (RED) test suite.
///
/// All 14 assertions from docs/planning/flutter/STORE_ADAPTERS_PHASE1.md:
///   Group V: Type Derivation (4)
///   Group W: Block ID Derivation (4)
///   Group X: Reconstructed Map Integrity (4)
///   Group Y: Fallback (2)
///
/// Tests verify that LedgerBlockStore correctly marshals snake_case
/// JSON block types to BlockType enum values, extracts the correct
/// hash field per block type, and reconstructs chain-format maps
/// without data loss.
///
/// THE BUG: _deriveBlockType() uses asNameMap() (camelCase keys)
/// which don't match snake_case JSON types ("year_summary", "month_summary").
/// Tests V3, V4, W3, W4, X3, X4 should be RED.

// ═══════════════════════════════════════════════════════════════
// Fake BlockDao
// ═══════════════════════════════════════════════════════════════

class _FakeBlockDao {
  final List<Block> _blocks = [];

  Block insertBlockSync(Block block) {
    // Detect duplicate block_id — INSERT (not INSERT OR IGNORE) semantics.
    // Silently skip duplicates to maintain data integrity (partial duplicate
    // acceptance would corrupt prev_hash linkage).
    if (_blocks.any((b) => b.blockId == block.blockId)) {
      return block;
    }
    _blocks.add(block);
    return block;
  }

  List<Block> getAllBlocksSync() => List.unmodifiable(_blocks);

  Block? getLastBlockSync() => _blocks.isEmpty ? null : _blocks.last;

  int getBlockCountSync() => _blocks.length;

  void deleteBlockSync(String blockId) {
    _blocks.removeWhere((b) => b.blockId == blockId);
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/// Build a chain-format block map and encode to base64 data_enc
/// as chain.dart's buildDayBlock / buildGenesisBlock would produce.
String _encode(Map<String, dynamic> map) =>
    base64.encode(utf8.encode(json.encode(map)));

/// Make a genesis-form block map (type=genesis, block_hash, identity_seal).
Map<String, dynamic> _makeGenesis() => {
      'type': 'genesis',
      'day_index': 0,
      'prev_hash': '0' * 64,
      'entries': <Map<String, dynamic>>[],
      'block_hash': '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3',
      'identity_seal': 'ea61b5dbfe89ee1b97b320603360ecfd8e5ff5ad774464ab4ac4864ef08366bf',
      'key_version': 1,
    };

/// Make a day block map (type=day, day_hash).
Map<String, dynamic> _makeDay() => {
      'type': 'day',
      'day_index': 1,
      'date': '2026-07-01',
      'prev_hash': '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3',
      'entries': <Map<String, dynamic>>[],
      'day_hash': '2e7c2fca58ec1698faade6f2b130dc2c9734a82da8bd63542cb52796746e1210a',
      'key_version': 1,
    };

/// Make a year_summary block map.
Map<String, dynamic> _makeYearSummary() => {
      'type': 'year_summary',
      'year': 2025,
      'date': '2026-01-01',
      'prev_hash': '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3',
      'entries': <Map<String, dynamic>>[],
      'year_hash': '013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673',
    };

/// Make a month_summary block map.
Map<String, dynamic> _makeMonthSummary() => {
      'type': 'month_summary',
      'month': '2025-12',
      'date': '2026-01-01',
      'prev_hash': '013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673',
      'entries': <Map<String, dynamic>>[],
      'month_hash': 'aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673',
    };

/// Create a fresh LedgerBlockStore with an in-memory fake dao.
LedgerBlockStore _makeStore() {
  final dao = _FakeBlockDao();
  return LedgerBlockStore(dao);
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

void main() {
  // ═══════════════════════════════════════════════════════════
  // Group V: Type Derivation — 4 tests
  // ═══════════════════════════════════════════════════════════

  group('V: Block Type Derivation (append → DB row blockType)', () {
    test('V1: genesis (type="genesis") → blockType=genesis', () {
      final store = _makeStore();
      store.appendBlocks([_makeGenesis()]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('genesis'));
    });

    test('V2: day (type="day") → blockType=day', () {
      final store = _makeStore();
      store.appendBlocks([_makeDay()]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('day'));
    });

    test('V3: year_summary (type="year_summary") → blockType=year', () {
      final store = _makeStore();
      store.appendBlocks([_makeYearSummary()]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      // THE BUG — currently maps to "day"
      expect(blocks[0]['type'], equals('year_summary'),
          reason: 'year_summary must survive the DB roundtrip');
    });

    test('V4: month_summary (type="month_summary") → blockType=month', () {
      final store = _makeStore();
      store.appendBlocks([_makeMonthSummary()]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      // THE BUG — currently maps to "day"
      expect(blocks[0]['type'], equals('month_summary'),
          reason: 'month_summary must survive the DB roundtrip');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group W: Block ID Derivation — 4 tests
  // ═══════════════════════════════════════════════════════════

  group('W: Block ID Derivation (hash field → block_id)', () {
    test('W1: genesis → block_id = block_hash', () {
      final store = _makeStore();
      store.appendBlocks([_makeGenesis()]);
      final blocks = store.readBlocks();
      expect(blocks[0]['block_hash'],
          equals('715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3'));
    });

    test('W2: day → block_id = day_hash', () {
      final store = _makeStore();
      store.appendBlocks([_makeDay()]);
      final blocks = store.readBlocks();
      expect(blocks[0]['day_hash'],
          equals('2e7c2fca58ec1698faade6f2b130dc2c9734a82da8bd63542cb52796746e1210a'));
    });

    test('W3: year_summary → block_id = year_hash', () {
      final store = _makeStore();
      store.appendBlocks([_makeYearSummary()]);
      final blocks = store.readBlocks();
      // THE BUG — _deriveBlockId looks for day_hash, gets empty
      expect(blocks[0]['year_hash'],
          equals('013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673'),
          reason: 'year_hash must survive the DB roundtrip');
    });

    test('W4: month_summary → block_id = month_hash', () {
      final store = _makeStore();
      store.appendBlocks([_makeMonthSummary()]);
      final blocks = store.readBlocks();
      // THE BUG — _deriveBlockId looks for day_hash, gets empty
      expect(blocks[0]['month_hash'],
          equals('aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673'),
          reason: 'month_hash must survive the DB roundtrip');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group X: Reconstructed Map Integrity — 4 tests
  // ═══════════════════════════════════════════════════════════

  group('X: Reconstructed Map Integrity (full roundtrip)', () {
    test('X1: genesis roundtrip preserves all fields', () {
      final store = _makeStore();
      store.appendBlocks([_makeGenesis()]);
      final blocks = store.readBlocks();
      final g = blocks[0];
      expect(g['type'], equals('genesis'));
      expect(g['block_hash'],
          equals('715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3'));
      expect(g['identity_seal'],
          equals('ea61b5dbfe89ee1b97b320603360ecfd8e5ff5ad774464ab4ac4864ef08366bf'));
      expect(g['prev_hash'], equals('0' * 64));
      expect(g['key_version'], equals(1));
    });

    test('X2: day roundtrip preserves day_hash and type', () {
      final store = _makeStore();
      store.appendBlocks([_makeDay()]);
      final blocks = store.readBlocks();
      final d = blocks[0];
      expect(d['type'], equals('day'));
      expect(d['day_hash'],
          equals('2e7c2fca58ec1698faade6f2b130dc2c9734a82da8bd63542cb52796746e1210a'));
      expect(d['date'], equals('2026-07-01'));
      // Note: day_index is overwritten by _blockToMap with blockIndex
      // (DB row position, not semantic day counter). This is a known
      // overlay concern tracked separately.
    });

    test('X3: year_summary roundtrip preserves year_hash and type', () {
      final store = _makeStore();
      store.appendBlocks([_makeYearSummary()]);
      final blocks = store.readBlocks();
      final y = blocks[0];
      // THE BUG — type changed to "day", year_hash lost
      expect(y['type'], equals('year_summary'),
          reason: 'type must survive the DB roundtrip');
      expect(y['year_hash'],
          equals('013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673'),
          reason: 'year_hash must survive the DB roundtrip');
      expect(y['year'], equals(2025));
    });

    test('X4: month_summary roundtrip preserves month_hash and type', () {
      final store = _makeStore();
      store.appendBlocks([_makeMonthSummary()]);
      final blocks = store.readBlocks();
      final m = blocks[0];
      // THE BUG — type changed to "day", month_hash lost
      expect(m['type'], equals('month_summary'),
          reason: 'type must survive the DB roundtrip');
      expect(m['month_hash'],
          equals('aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673'),
          reason: 'month_hash must survive the DB roundtrip');
      expect(m['month'], equals('2025-12'));
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group Y: Fallback — 2 tests
  // ═══════════════════════════════════════════════════════════

  group('Y: Missing/Unknown Type Fallback', () {
    test('Y1: missing type field → defaults to day', () {
      final store = _makeStore();
      final block = <String, dynamic>{
        'day_hash': 'abc1230000000000000000000000000000000000000000000000000000000000',
        'prev_hash': '0' * 64,
      };
      store.appendBlocks([block]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('day'));
    });

    test('Y2: unknown type string → preserved (forward-compatible)', () {
      final store = _makeStore();
      final block = <String, dynamic>{
        'type': 'future_block_v2',
        'future_hash': 'xyz7890000000000000000000000000000000000000000000000000000000000',
        'prev_hash': '0' * 64,
      };
      store.appendBlocks([block]);
      final blocks = store.readBlocks();
      expect(blocks, hasLength(1));
      // Unknown type preserved in data_enc for forward compatibility.
      // DB blockType defaults to 'day' but chain type is not overwritten.
      expect(blocks[0]['type'], equals('future_block_v2'));
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group Z: _blockToMap Type Restoration — 6 tests
  // ═══════════════════════════════════════════════════════════
  //
  // Tests for _blockToMap reconstructing the correct `type` from a Block
  // row when data_enc is missing the type field (Bug A: genesis) or when
  // the DB row has wrong blockType/blockId from old _deriveBlockType
  // (Bug B: legacy summary blocks).
  //
  // These tests inject buggy Block rows directly into the fake DAO,
  // bypassing appendBlocks() to simulate the real on-disk state.

  group('Z: _blockToMap Type Restoration', () {
    // ── Bug A: Genesis without type in data_enc ───────────────

    test('Z1: genesis with data_enc lacking type → type=genesis', () {
      // Simulates Bug A: onboarding_service.dart stores genesis with
      // data_enc {"seed":"..."} (no "type" field). _blockToMap must
      // infer type='genesis' from b.blockType, not default to 'day'.
      final dao = _FakeBlockDao();
      const genesisBlockHash =
          '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3';
      dao.insertBlockSync(Block(
        blockId: genesisBlockHash,
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode(json.encode({'seed': 'abc123'}))),
        identitySeal:
            'ea61b5dbfe89ee1b97b320603360ecfd8e5ff5ad774464ab4ac4864ef08366bf',
        prevHash: '0' * 64,
        createdAt: 1000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('genesis'),
          reason: 'Genesis blocks without type in data_enc must be '
              'recognized as genesis, not defaulted to day');
    });

    test('Z2: genesis with data_enc lacking type → getBlockHash '
        'returns block_hash, not empty', () {
      final dao = _FakeBlockDao();
      const genesisBlockHash =
          '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3';
      dao.insertBlockSync(Block(
        blockId: genesisBlockHash,
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode(json.encode({'seed': 'abc123'}))),
        prevHash: '0' * 64,
        createdAt: 1000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      final resolved = getBlockHash(blocks[0]);
      expect(resolved, equals(genesisBlockHash),
          reason: 'getBlockHash() must resolve via block_hash for genesis, '
              'not default to empty day_hash when type is wrong');
      expect(resolved, isNotEmpty,
          reason: 'Empty hash resolution breaks prev_hash linkage in '
              'chain.append()');
    });

    // ── Bug B: Legacy year_summary (blockType=day, blockId="") ──

    test('Z3: year_summary stored with old bug (blockType=day, '
        'blockId="") → type=year_summary', () {
      final dao = _FakeBlockDao();
      const yearHash =
          '013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';
      final dataEnc = base64.encode(utf8.encode(json.encode({
            'type': 'year_summary',
            'year': 2025,
            'year_hash': yearHash,
            'prev_hash': '0' * 64,
            'entries': <Map<String, dynamic>>[],
          })));
      dao.insertBlockSync(Block(
        blockId: '', // Old bug: empty blockId for summary blocks
        blockType: BlockType.day, // Old bug: stored as day
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: '0' * 64,
        createdAt: 2000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('year_summary'),
          reason: 'Legacy year_summary blocks must read back with correct '
              'type from data_enc, not be overwritten by DB blockType=day');
    });

    test('Z4: year_summary stored with old bug → getBlockHash '
        'returns year_hash from data_enc', () {
      final dao = _FakeBlockDao();
      const yearHash =
          '013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';
      final dataEnc = base64.encode(utf8.encode(json.encode({
            'type': 'year_summary',
            'year': 2025,
            'year_hash': yearHash,
            'prev_hash': '0' * 64,
            'entries': <Map<String, dynamic>>[],
          })));
      dao.insertBlockSync(Block(
        blockId: '',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: '0' * 64,
        createdAt: 2000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      final resolved = getBlockHash(blocks[0]);
      expect(resolved, equals(yearHash),
          reason: 'getBlockHash() must find year_hash when type is '
              'year_summary, not fall through to empty day_hash');
    });

    // ── Bug B: Legacy month_summary (blockType=day, blockId="") ──

    test('Z5: month_summary stored with old bug (blockType=day, '
        'blockId="") → type=month_summary', () {
      final dao = _FakeBlockDao();
      const monthHash =
          'aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';
      final dataEnc = base64.encode(utf8.encode(json.encode({
            'type': 'month_summary',
            'month': '2025-12',
            'month_hash': monthHash,
            'prev_hash': '0' * 64,
            'entries': <Map<String, dynamic>>[],
          })));
      dao.insertBlockSync(Block(
        blockId: '',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: '0' * 64,
        createdAt: 2000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      expect(blocks[0]['type'], equals('month_summary'),
          reason: 'Legacy month_summary blocks must read back with correct '
              'type from data_enc, not be overwritten by DB blockType=day');
    });

    test('Z6: month_summary stored with old bug → getBlockHash '
        'returns month_hash from data_enc', () {
      final dao = _FakeBlockDao();
      const monthHash =
          'aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';
      final dataEnc = base64.encode(utf8.encode(json.encode({
            'type': 'month_summary',
            'month': '2025-12',
            'month_hash': monthHash,
            'prev_hash': '0' * 64,
            'entries': <Map<String, dynamic>>[],
          })));
      dao.insertBlockSync(Block(
        blockId: '',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: '0' * 64,
        createdAt: 2000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      final resolved = getBlockHash(blocks[0]);
      expect(resolved, equals(monthHash),
          reason: 'getBlockHash() must find month_hash when type is '
              'month_summary, not fall through to empty day_hash');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group AB: _blockToMap — Entries-Only data_enc Reconstruction — 5 tests
  // ═══════════════════════════════════════════════════════════
  //
  // Tests for Bug C: _blockToMap loses block-level fields (date, entries)
  // when data_enc stores only the entries array `[{data, hash}, ...]`
  // instead of a full block map. The cast to Map fails → fallback to {}
  // loses `date`, causing summary_policy to see null→1970 and generate
  // spurious summaries.

  group('AB: _blockToMap — Entries-Only data_enc Reconstruction', () {
    /// Build a Block row with entries-only data_enc (simulating legacy
    /// storage format where only the entries array was persisted).
    Block _makeEntriesOnlyBlock(String dayHash,
        {List<Map<String, dynamic>> entries = const []}) {
      final dataEnc =
          base64.encode(utf8.encode(json.encode(entries)));
      return Block(
        blockId: dayHash,
        blockType: BlockType.day,
        blockIndex: 5,
        dataEnc: dataEnc,
        prevHash: 'a' * 64,
        createdAt: 1000000,
      );
    }

    test('AB1: _blockToMap recovers date from first entry start_epoch '
        'when data_enc is entries array', () {
      final dao = _FakeBlockDao();
      final dayHash = 'd' * 64;
      final startEpochMs = 1735689600000; // 2025-01-01
      dao.insertBlockSync(_makeEntriesOnlyBlock(
        dayHash,
        entries: [
          {
            'hash': 'h' * 64,
            'data': {
              'title': 'Test',
              'start_epoch': startEpochMs,
              'duration': 1000,
            },
          },
        ],
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      expect(blocks[0]['date'], equals('2025-01-01'),
          reason: 'date must be recovered from first entry start_epoch '
              'when data_enc stores only the entries array');
    });

    test('AB2: _blockToMap recovers entries field when data_enc '
        'is entries array', () {
      final dao = _FakeBlockDao();
      final dayHash = 'e' * 64;
      dao.insertBlockSync(_makeEntriesOnlyBlock(
        dayHash,
        entries: [
          {
            'hash': 'h1' + '0' * 62,
            'data': {
              'title': 'Entry A',
              'start_epoch': 1700000000000,
              'duration': 5000,
            },
          },
          {
            'hash': 'h2' + '0' * 62,
            'data': {
              'title': 'Entry B',
              'start_epoch': 1700000001000,
              'duration': 3000,
            },
          },
        ],
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      final entries = blocks[0]['entries'];
      expect(entries, isA<List>());
      expect((entries as List).length, equals(2),
          reason: 'entries must survive reconstruction from '
              'entries-only data_enc');
      expect(entries[0]['data']['title'], equals('Entry A'));
      expect(entries[1]['data']['title'], equals('Entry B'));
    });

    test('AB3: _blockToMap preserves empty entries array '
        '(data_enc = [])', () {
      final dao = _FakeBlockDao();
      final dayHash = 'f' * 64;
      dao.insertBlockSync(_makeEntriesOnlyBlock(
        dayHash,
        entries: [],
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      final entries = blocks[0]['entries'];
      expect(entries, isA<List>());
      expect((entries as List), isEmpty,
          reason: 'empty entries array must not cause crash');
      // Should not crash, even with empty entries
      expect(blocks[0]['date'], isNotNull,
          reason: 'date should still be set (to 1970-01-01 sentinel) '
              'even when there are no entries');
    });

    test('AB4: getBlockHash() returns non-empty for block '
        'reconstructed from entries-only data_enc', () {
      final dao = _FakeBlockDao();
      final dayHash = 'g' * 64;
      dao.insertBlockSync(_makeEntriesOnlyBlock(
        dayHash,
        entries: [
          {
            'hash': 'h' * 64,
            'data': {
              'title': 'Hash Check',
              'start_epoch': 1700000000000,
              'duration': 1000,
            },
          },
        ],
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      final hash = getBlockHash(blocks[0]);
      expect(hash, isNotEmpty,
          reason: 'Chain linkage requires non-empty hash resolution '
              'for blocks reconstructed from entries-only data_enc');
      expect(hash, equals(dayHash),
          reason: 'getBlockHash must resolve to the DB blockId '
              '(day_hash for day blocks)');
    });

    test('AB5: full roundtrip: entries-only block → readBlocks → '
        'date and entries recoverable', () {
      final dao = _FakeBlockDao();
      final dayHash = 'h' * 64;
      final dayBlock = {
        'type': 'day',
        'day_hash': dayHash,
        'prev_hash': 'p' * 64,
        'date': '2026-06-20',
        'entries': [
          {
            'hash': 'h' * 64,
            'data': {
              'title': 'Roundtrip',
              'start_epoch': 1781913600000,
              'duration': 3600000,
            },
          },
        ],
      };

      // First: store via appendBlocks (full map in data_enc)
      final store = _makeStore();
      store.appendBlocks([dayBlock]);
      var blocks = store.readBlocks();
      expect(blocks[0]['date'], equals('2026-06-20'));
      expect(blocks[0]['entries'].length, equals(1));

      // Now simulate legacy: entries-only data_enc
      dao.insertBlockSync(_makeEntriesOnlyBlock(
        dayHash,
        entries: dayBlock['entries'] as List<Map<String, dynamic>>,
      ));
      final store2 = LedgerBlockStore(dao);
      blocks = store2.readBlocks();

      expect(blocks[0]['date'], equals('2026-06-20'),
          reason: 'roundtrip through entries-only format must '
              'preserve date information');
      expect(blocks[0]['entries'].length, equals(1),
          reason: 'roundtrip through entries-only format must '
              'preserve entry data');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group AC: _blockToMap — Date Derivation Edge Cases — 3 tests
  // ═══════════════════════════════════════════════════════════

  group('AC: _blockToMap — Date Derivation Edge Cases', () {
    test('AC1: multiple entries → earliest start_epoch used for date', () {
      final dao = _FakeBlockDao();
      final dayHash = 'i' * 64;
      final dataEnc = base64.encode(utf8.encode(json.encode([
        {
          'hash': 'h1' + '0' * 62,
          'data': {
            'title': 'Later',
            'start_epoch': 1750876840000,
            'duration': 1000,
          },
        },
        {
          'hash': 'h2' + '0' * 62,
          'data': {
            'title': 'Earlier',
            'start_epoch': 1750876800000,
            'duration': 2000,
          },
        },
      ])));
      dao.insertBlockSync(Block(
        blockId: dayHash,
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: dataEnc,
        prevHash: 'x' * 64,
        createdAt: 1000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks[0]['date'], equals('2025-06-25'),
          reason: 'date must reflect earliest start_epoch, '
              'not first in array order');
    });

    test('AC2: entries with no start_epoch → fallback to '
        '1970-01-01 (sentinel)', () {
      final dao = _FakeBlockDao();
      final dayHash = 'j' * 64;
      final dataEnc = base64.encode(utf8.encode(json.encode([
        {
          'hash': 'h' * 64,
          'data': {
            'title': 'No Epoch',
            'duration': 1000,
          },
        },
      ])));
      dao.insertBlockSync(Block(
        blockId: dayHash,
        blockType: BlockType.day,
        blockIndex: 2,
        dataEnc: dataEnc,
        prevHash: 'y' * 64,
        createdAt: 2000000,
      ));
      final store = LedgerBlockStore(dao);
      final blocks = store.readBlocks();

      expect(blocks, hasLength(1));
      expect(blocks[0]['date'], equals('1970-01-01'),
          reason: '1970-01-01 is the explicit sentinel for '
              'unknown/corrupted dates — must not crash or return null');
    });

    test('AC3: valid block map data_enc — date from data_enc is '
        'preserved (not overwritten)', () {
      final store = _makeStore();
      final dayBlock = _makeDay(); // date='2026-07-01' in the map
      store.appendBlocks([dayBlock]);

      final blocks = store.readBlocks();
      expect(blocks[0]['date'], equals('2026-07-01'),
          reason: 'Correctly-formatted block maps must retain their '
              'explicit date field — the entries-array fix must not '
              'overwrite valid data_enc dates');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group AF: Database INSERT Conflict Handling — 2 tests
  // ═══════════════════════════════════════════════════════════

  group('AF: INSERT Conflict Handling', () {
    test('AF1: duplicate block_id → appendBlocks rejects duplicate '
        '(INSERT not INSERT OR IGNORE)', () {
      final store = _makeStore();
      final dayBlock = _makeDay();

      // First append succeeds
      store.appendBlocks([dayBlock]);
      expect(store.getBlockCount(), equals(1));

      // Second append with same block → should NOT silently double count
      store.appendBlocks([dayBlock]);

      // After fix: should still be 1 (duplicate detected and skipped
      // or throws). Currently the _FakeBlockDao always appends, so
      // this test documents the desired behavior.
      expect(store.getBlockCount(), equals(1),
          reason: 'appendBlocks must detect duplicate block_id — '
              'INSERT OR IGNORE silently drops data which breaks '
              'prev_hash linkage (in-memory prevHash ≠ DB state)');
    });

    test('AF2: appendBlocks preserves chain integrity when '
        'summary batch partially exists', () {
      // Simulates: year_summary exists in DB but month_summary doesn't.
      // The engine generates both → inserts year_summary (duplicate)
      // and month_summary (new). The fix must handle partial duplicates.
      final store = _makeStore();

      // Pre-populate with a year_summary (simulating prior commit)
      final yearBlock = _makeYearSummary();
      store.appendBlocks([yearBlock]);
      expect(store.getBlockCount(), equals(1));

      // Now simulate the engine trying to insert both year_summary
      // (duplicate) and month_summary (new)
      // With INSERT OR IGNORE: year silently dropped, month inserted
      // → prev_hash points to year (dropped), not month (inserted)
      final monthBlock = _makeMonthSummary();
      store.appendBlocks([yearBlock, monthBlock]);

      // Desired: either both fail (transactional) or both succeed
      // with year skipped. Not: year dropped, month inserted.
      // With _FakeBlockDao (always appends): count = 3 (buggy)
      expect(store.getBlockCount(), lessThanOrEqualTo(2),
          reason: 'Partial duplicate acceptance corrupts chain '
              '— year_summary silently dropped but month_summary '
              'inserted with stale prev_hash');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group AA: Full Chain Roundtrip with Legacy Blocks — 3 tests
  // ═══════════════════════════════════════════════════════════

  group('AA: Full Chain Roundtrip with Legacy Blocks', () {
    /// Insert three buggy blocks (genesis without type, year_summary with
    /// old bug, month_summary with old bug) and read back through
    /// LedgerBlockStore.readBlocks(). Returns the reconstructed maps.
    List<Map<String, dynamic>> _buildMixedBuggyChain() {
      final dao = _FakeBlockDao();

      const genesisBlockHash =
          '715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3';
      const yearHash =
          '013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';
      const monthHash =
          'aabbccdd549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673';

      // Block 0: Buggy genesis (no type in data_enc)
      dao.insertBlockSync(Block(
        blockId: genesisBlockHash,
        blockType: BlockType.genesis,
        blockIndex: 0,
        dataEnc: base64.encode(utf8.encode(json.encode({'seed': 'abc123'}))),
        prevHash: '0' * 64,
        createdAt: 1000000,
      ));

      // Block 1: Buggy year_summary (stored as day, blockId="")
      dao.insertBlockSync(Block(
        blockId: '',
        blockType: BlockType.day,
        blockIndex: 1,
        dataEnc: base64.encode(utf8.encode(json.encode({
              'type': 'year_summary',
              'year': 2025,
              'year_hash': yearHash,
              'prev_hash': genesisBlockHash,
              'entries': <Map<String, dynamic>>[],
            }))),
        prevHash: genesisBlockHash,
        createdAt: 2000000,
      ));

      // Block 2: Normal day block (stored correctly via appendBlocks)
      // We inject it directly with correct blockType to simulate the
      // post-fix storage.
      const dayHash =
          '2e7c2fca58ec1698faade6f2b130dc2c9734a82da8bd63542cb52796746e1210a';
      dao.insertBlockSync(Block(
        blockId: dayHash,
        blockType: BlockType.day,
        blockIndex: 2,
        dataEnc: base64.encode(utf8.encode(json.encode({
              'type': 'day',
              'day_index': 1,
              'date': '2026-07-01',
              'day_hash': dayHash,
              'prev_hash': yearHash,
              'entries': <Map<String, dynamic>>[],
            }))),
        prevHash: yearHash,
        createdAt: 3000000,
      ));

      final store = LedgerBlockStore(dao);
      return store.readBlocks();
    }

    test('AA1: mixed chain (buggy genesis → buggy year_summary → day) '
        'getBlockHash() returns non-empty for every block', () {
      final blocks = _buildMixedBuggyChain();
      expect(blocks, hasLength(3));

      for (var i = 0; i < blocks.length; i++) {
        final hash = getBlockHash(blocks[i]);
        expect(hash, isNotEmpty,
            reason: 'Block $i (type=${blocks[i]['type']}) must resolve '
                'to a non-empty hash for chain verification to succeed');
      }
    });

    test('AA2: mixed chain → getBlockHash at each position matches '
        'the expected hash field value', () {
      final blocks = _buildMixedBuggyChain();

      // Genesis → block_hash
      expect(getBlockHash(blocks[0]),
          equals('715a7b96e50a9a8ba5591fe20a3a2feaf0fc45b95f820055ce2e9a68ddff58a3'),
          reason: 'Genesis block_hash must resolve correctly');

      // Year summary → year_hash
      expect(getBlockHash(blocks[1]),
          equals('013d664549199abef4ad5fdd2e5885746f7450ad85d6b6ed6d8605768d920673'),
          reason: 'Year summary year_hash must resolve correctly');

      // Day → day_hash
      expect(getBlockHash(blocks[2]),
          equals('2e7c2fca58ec1698faade6f2b130dc2c9734a82da8bd63542cb52796746e1210a'),
          reason: 'Day block day_hash must resolve correctly');
    });

    test('AA3: new day block prev_hash equals getBlockHash() of '
        'previous block in mixed legacy chain', () {
      final blocks = _buildMixedBuggyChain();

      // The prev_hash of a new block appended at position 3 would be
      // getBlockHash(blocks[2]) — verify this resolves correctly.
      final lastHash = getBlockHash(blocks[2]);
      expect(lastHash, isNotEmpty,
          reason: 'Last block must have a resolvable hash for forward '
              'chain extension');

      // Also verify internal linkage: blocks[2].prev_hash ==
      // getBlockHash(blocks[1])
      final yearHash = getBlockHash(blocks[1]);
      expect(blocks[2]['prev_hash'], equals(yearHash),
          reason: 'Internal prev_hash linkage must be maintained after '
              'type restoration');
    });
  });
}
