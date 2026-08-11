import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';

/// LedgerBackupService PHPSPEC import storage-fidelity — Phase 2 (RED).
///
/// Regression suite for **Flutter Storage Fidelity for Canonical Summon**
/// (`docs/planning/FLUTTER_STORAGE_FIDELITY_PHASE1.md`).
///
/// The bug: `LedgerBackupService._phpSpecToBlock` serializes ONLY the `entries`
/// array into `data_enc`:
///
///   dataEnc = base64(utf8(jsonEncode(entriesList)))
///
/// discarding `type`, `date`, `month`/`year`, `day_index`, and the seal-hash
/// fields. When `LedgerBlockStore._blockToMap` later reconstructs the chain
/// map for `LedgerChain.verify()`, canonical summaries (which seal over
/// `month`/`year`) and day blocks (which seal over `date`) cannot be
/// faithfully rebuilt → the cloud-restored chain fails `verify()`.
///
/// The fix direction: `_phpSpecToBlock` must persist the FULL canonical block
/// map into `data_enc` (same `base64(utf8(json(map)))` shape the write path
/// of `LedgerBlockStore` and the `extractEntries`/`extractHash` helpers
/// already expect) so `_blockToMap` reconstructs `date`, `month`/`year`, and
/// reproduceable seals.
///
///   Group A:  data_enc payload is a full block map, not an entries array
///   Group B:  `LedgerBlockStore` reconstruction preserves summary identity
///   Group C:  `LedgerChain.verify()` passes on a cloud-restored 0.4.0 chain
///   Group D:  GREEN regression guards (linkage, no spurious fields)
///
/// Expected RED: A1–A3, B1–B2, C1–C5 (all fail under the CURRENT buggy
/// `_phpSpecToBlock`). Group D guards stable behavior and starts GREEN.

// ── Constants ──────────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

// ── In-memory store fake for building a source chain map set ──

class _FakeStore {
  final List<Map<String, dynamic>> _blocks = [];

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    if (start < 0) start = 0;
    return _blocks.sublist(start, e > _blocks.length ? _blocks.length : e);
  }

  void appendBlocks(List<Map<String, dynamic>> blocks) => _blocks.addAll(blocks);

  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }

  int getBlockCount() => _blocks.length;

  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;
}

// ── Chain-map builders (valid 0.4.0 seals via CryptoService) ──

CryptoService _freshCrypto() => (CryptoService()..initialize())..setMasterKey(mkHex);

LedgerChain _chain(CryptoService crypto) =>
    LedgerChain(crypto: crypto, store: _FakeStore());

/// Build a validly-sealed 0.4.0 genesis chain map (no `date`, matching the
/// Flutter `buildGenesisBlock` seal over {type, day_index, prev_hash, entries}).
Map<String, dynamic> _buildGenesis(CryptoService crypto) {
  return _chain(crypto).buildGenesisBlock(
    username: 'u',
    email: 'e@e.com',
    recoverySeedEnc: 'seed',
    identityPubKey: 'pk',
    identitySecretEncFallback: 'fb',
    formatVersion: '0.4.0',
  );
}

/// Wrap entry data with a valid 0.4.0 content_hash.
Map<String, dynamic> _wrapEntry(
  Map<String, dynamic> data,
  CryptoService crypto,
) {
  final withHash = Map<String, dynamic>.from(data)
    ..['content_hash'] = computeContentHash(data, crypto);
  return {'hash': computeEntryHash(withHash), 'data': withHash};
}

/// Build a validly-sealed day chain map for [dateStr].
Map<String, dynamic> _buildDay(
  CryptoService crypto, {
  required String prevHash,
  required String dateStr,
  List<dynamic>? entries,
}) {
  return _chain(crypto).buildDayBlock(
    entries: entries ?? [_wrapEntry({'title': 'Task', 'duration': 100}, crypto)],
    prevHash: prevHash,
    dateStr: dateStr,
  );
}

/// Build a validly-sealed month_summary map (seal over {type, month, date, prev_hash}).
Map<String, dynamic> _buildMonth(
  CryptoService crypto, {
  required String prevHash,
  String month = '2025-01',
  String date = '2025-01-31',
}) {
  final chain = _chain(crypto);
  final sealData = <String, dynamic>{
    'type': 'month_summary',
    'month': month,
    'date': date,
    'prev_hash': prevHash,
  };
  final monthHash = chain.computeSeal(sealData);
  return {
    'type': 'month_summary',
    'month': month,
    'date': date,
    'prev_hash': prevHash,
    'month_hash': monthHash,
    'key_version': 1,
    'entries': <dynamic>[],
  };
}

/// Build a validly-sealed year_summary map (seal over {type, year, date, prev_hash}).
Map<String, dynamic> _buildYear(
  CryptoService crypto, {
  required String prevHash,
  int year = 2025,
  String date = '2025-12-31',
}) {
  final chain = _chain(crypto);
  final sealData = <String, dynamic>{
    'type': 'year_summary',
    'year': year,
    'date': date,
    'prev_hash': prevHash,
  };
  final yearHash = chain.computeSeal(sealData);
  return {
    'type': 'year_summary',
    'year': year,
    'date': date,
    'prev_hash': prevHash,
    'year_hash': yearHash,
    'key_version': 1,
    'entries': <dynamic>[],
  };
}

/// Serialize a chain map into a PHPSPEC object for `importFromJson`.
///
/// Emits the canonical seal-hash field, `month`/`year` for summaries, and
/// `date`/`day_index`/`prev_hash`/`entries`. This is the shape a Python/CLI
/// cloud export carries and is independent of the Flutter `blockToMap`
/// exporter, isolating the import/storage-fidelity bug.
Map<String, dynamic> _toPhpSpec(Map<String, dynamic> map) {
  final type = map['type'] as String;
  final sealField = switch (type) {
    'genesis' => 'block_hash',
    'day' => 'day_hash',
    'month_summary' => 'month_hash',
    'year_summary' => 'year_hash',
    _ => '${type}_hash',
  };
  final out = <String, dynamic>{
    'type': type,
    'prev_hash': map['prev_hash'],
    'entries': map['entries'] ?? <dynamic>[],
  };
  if (map.containsKey('day_index')) out['day_index'] = map['day_index'];
  if (map.containsKey('date')) out['date'] = map['date'];
  if (map.containsKey('month')) out['month'] = map['month'];
  if (map.containsKey('year')) out['year'] = map['year'];
  out[sealField] = map[sealField];
  out['block_hash'] = map[sealField];
  return out;
}

String _encodeImport(List<Map<String, dynamic>> chainMaps) =>
    jsonEncode(chainMaps.map(_toPhpSpec).toList());

/// Build the canonical 4-block chain (genesis + day + month + year) maps.
List<Map<String, dynamic>> _canonicalChain(CryptoService crypto) {
  final gen = _buildGenesis(crypto);
  final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
  final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
  final year = _buildYear(crypto, prevHash: month['month_hash'] as String);
  return [gen, day, month, year];
}

/// Fresh in-memory DB + service.
Future<(AppDatabase, LedgerBackupService)> _fresh() async {
  final db = AppDatabase.inMemory();
  return (db, LedgerBackupService(db: db));
}

/// Import [json] into [db] then reconstruct a chain over [db.blockDao].
LedgerChain _restoredChain(AppDatabase db, CryptoService crypto) {
  return LedgerChain(
    crypto: crypto,
    store: LedgerBlockStore(db.blockDao),
  );
}

void main() {
  // ═════════════════════════════════════════════════════════════
  // Group A: data_enc payload is a full block map, not an entries array
  // ═════════════════════════════════════════════════════════════
  group('A: imported data_enc is a full canonical block map', () {
    test('A1: importing a day block persists type/date/hash in data_enc, '
        'not a bare entries array', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final json = _encodeImport([gen, day]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final blocks = await db.blockDao.getAllBlocks();
      expect(blocks, hasLength(2));
      final dayBlock = blocks.last;
      final decoded = jsonDecode(utf8.decode(base64.decode(dayBlock.dataEnc)));
      expect(decoded, isA<Map<String, dynamic>>(),
          reason: 'data_enc must carry a full block map, not an entries list');
      expect(decoded['type'], 'day',
          reason: 'data_enc must retain the block type for _blockToMap');
      expect(decoded['date'], '2025-01-15',
          reason: 'data_enc must retain the day date so seal fields reconstruct');
      expect(decoded['entries'], isA<List>());

      await db.close();
    });

    test('A2: importing a month_summary persists month+date+month_hash in '
        'data_enc', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final json = _encodeImport([gen, day, month]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final blocks = await db.blockDao.getAllBlocks();
      final monthBlock = blocks.last;
      final decoded = jsonDecode(utf8.decode(base64.decode(monthBlock.dataEnc)));
      expect(decoded, isA<Map<String, dynamic>>());
      expect(decoded['type'], 'month_summary');
      expect(decoded['month'], '2025-01',
          reason: 'month identity must survive in data_enc (canonical summary)');
      expect(decoded['date'], '2025-01-31');
      expect(decoded['month_hash'], month['month_hash'],
          reason: 'month_hash must survive in data_enc');

      await db.close();
    });

    test('A3: importing a year_summary persists year+date+year_hash in '
        'data_enc', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final year = _buildYear(crypto, prevHash: month['month_hash'] as String);
      final json = _encodeImport([gen, day, month, year]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final blocks = await db.blockDao.getAllBlocks();
      final yearBlock = blocks.last;
      final decoded = jsonDecode(utf8.decode(base64.decode(yearBlock.dataEnc)));
      expect(decoded, isA<Map<String, dynamic>>());
      expect(decoded['type'], 'year_summary');
      expect(decoded['year'], 2025,
          reason: 'year identity must survive in data_enc (canonical summary)');
      expect(decoded['date'], '2025-12-31');
      expect(decoded['year_hash'], year['year_hash'],
          reason: 'year_hash must survive in data_enc');

      await db.close();
    });

    test('A4: original_hash is preserved in data_enc (ADR-029a seal field)',
        () async {
      // Migrated blocks carry a preserved `original_hash` (part of the
      // per-type ADR-029a seal whitelist). It must survive the import
      // data_enc round-trip or _blockToMap reconstructs the chain WITHOUT it
      // and verify() recomputes a different hash than Python/Web.
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String,
          dateStr: '2025-01-15')
        ..['original_hash'] = 'a' * 64; // simulate a migrated day block
      // Feed the RAW chain (as a migrated ledger file would be parsed by
      // importFromFile) — bypassing the export-only test helper so the
      // original_hash reaches _phpSpecToBlock exactly as on the device.
      final json = jsonEncode([gen, day]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final blocks = await db.blockDao.getAllBlocks();
      final dayBlock = blocks.last;
      final decoded =
          jsonDecode(utf8.decode(base64.decode(dayBlock.dataEnc)));
      expect(decoded, isA<Map<String, dynamic>>());
      expect(decoded['original_hash'], 'a' * 64,
          reason: 'original_hash must survive in data_enc so verify() seals '
              'over the same whitelist input as Python/Web (Ph-7 e2e)');

      await db.close();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group B: LedgerBlockStore reconstruction preserves summary identity
  // ═════════════════════════════════════════════════════════════
  group('B: reconstructed chain map preserves canonical summary identity', () {
    test('B1: restored month_summary map retains month/date and a resolvable '
        'month_hash', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final json = _encodeImport([gen, day, month]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      final maps = restored.readAll();
      expect(maps, hasLength(3));
      final monthMap = maps.last;
      expect(monthMap['type'], 'month_summary');
      expect(monthMap['month'], '2025-01',
          reason: 'blockToMap must surface month from data_enc');
      expect(monthMap['date'], '2025-01-31',
          reason: 'blockToMap must surface date from data_enc');
      expect(monthMap['month_hash'], isNotEmpty,
          reason: 'month_hash must be resolvable via the DB blockId overlay');
      expect(getBlockHash(monthMap), month['month_hash']);

      await db.close();
    });

    test('B2: restored year_summary map retains year/date and a resolvable '
        'year_hash', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final year = _buildYear(crypto, prevHash: month['month_hash'] as String);
      final json = _encodeImport([gen, day, month, year]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      final maps = restored.readAll();
      expect(maps, hasLength(4));
      final yearMap = maps.last;
      expect(yearMap['type'], 'year_summary');
      expect(yearMap['year'], 2025,
          reason: 'blockToMap must surface year from data_enc');
      expect(yearMap['date'], '2025-12-31');
      expect(yearMap['year_hash'], isNotEmpty);
      expect(getBlockHash(yearMap), year['year_hash']);

      await db.close();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group C: chain.verify() passes on a cloud-restored 0.4.0 chain
  // ═════════════════════════════════════════════════════════════
  group('C: full chain verifies after PHPSPEC import (storage fidelity)', () {
    test('C1: genesis + day chain verifies after import', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final json = _encodeImport([gen, day]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      expect(restored.verify(), isTrue,
          reason: 'after a faithful PHPSPEC restore, a day block must '
              'reconstruct its date + seal and verify() (A1 storage fidelity)');

      await db.close();
    });

    test('C2: + month_summary verifies after import (month fidelity)', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final json = _encodeImport([gen, day, month]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      expect(restored.verify(), isTrue,
          reason: 'a canonical month_summary must VERIFY after import — its '
              'month+date+prev_hash must be reconstructable from data_enc');

      await db.close();
    });

    test('C3: + year_summary verifies after import (year fidelity)', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final year = _buildYear(crypto, prevHash: month['month_hash'] as String);
      final json = _encodeImport([gen, day, month, year]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      expect(restored.verify(), isTrue,
          reason: 'a canonical year_summary must VERIFY after import — its '
              'year+date must be reconstructable from data_enc');

      await db.close();
    });

    test('C4: multi-month summaries across the full chain verify', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final dJan = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final mJan = _buildMonth(crypto, prevHash: dJan['day_hash'] as String, month: '2025-01', date: '2025-01-31');
      final dFeb = _buildDay(crypto, prevHash: mJan['month_hash'] as String, dateStr: '2025-02-10');
      final mFeb = _buildMonth(crypto, prevHash: dFeb['day_hash'] as String, month: '2025-02', date: '2025-02-28');
      final year = _buildYear(crypto, prevHash: mFeb['month_hash'] as String);
      final maps = [gen, dJan, mJan, dFeb, mFeb, year];
      final json = _encodeImport(maps);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      expect(restored.readAll(), hasLength(6));
      expect(restored.verify(), isTrue,
          reason: 'a full chain with interleaved days and canonical monthly+'
              'yearly summaries must verify() after a faithful cloud restore');

      await db.close();
    });

    test('C5: restore of a real export→import roundtrip verifies', () async {
      final crypto = _freshCrypto();
      final chainMaps = _canonicalChain(crypto);

      // Persist via the reference write path (LedgerBlockStore full-map
      // data_enc), then export exact PHPSPEC, then import into a fresh DB.
      final (srcDb, _) = await _fresh();
      LedgerBlockStore(srcDb.blockDao).appendBlocks(chainMaps);
      final exporter = LedgerBackupService(db: srcDb);
      final exported = await exporter.exportToJson();
      await srcDb.close();

      final (dstDb, service) = await _fresh();
      await service.importFromJson(exported);

      // NOTE: the Flutter exporter does NOT yet emit month/year for
      // summaries, so this full roundtrip can only pass once the IMPORTER
      // rebuilds month/year from data_enc AND the exporter carries them.
      // Under storage-fidelity this is the gold standard: export→import
      // must be lossless enough that verify() remains GREEN.
      final restored = _restoredChain(dstDb, crypto);
      expect(restored.verify(), isTrue,
          reason: 'a genuine export→import roundtrip must not degrade a '
              'verifiable 0.4.0 chain (lossless storage fidelity)');

      await dstDb.close();
    });

    test('C6: migrated chain with original_hash on EVERY block verifies',
        () async {
      // Ph-7 e2e regression: the real re-migrated ledger stamps `original_hash`
      // on every block (ADR-029a provenance). It must survive the
      // import→_blockToMap reconstruction, or verify() seals over a DIFFERENT
      // field set than Python/Web and fails.
      // set than Python/Web and fails. This mirrors the on-device
      // `integration_test/onboard_verify_test.dart` Path-A scenario.
      final crypto = _freshCrypto();
      final maps = _canonicalChain(crypto).map((m) {
        final withOh = Map<String, dynamic>.from(m)
          ..['original_hash'] = 'b' * 64;
        return withOh;
      }).toList();
      // Raw chain JSON (as a migrated file would be parsed), not the
      // export-only test helper, so original_hash reaches import.
      final json = jsonEncode(maps);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      final rebuilt = restored.readAll();
      expect(rebuilt, hasLength(4));
      for (final m in rebuilt) {
        expect(m['original_hash'], 'b' * 64,
            reason: 'original_hash must survive import→_blockToMap on every '
                'block type (${m['type']}) so verify() seals the whitelist');
      }

      await db.close();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // Group D: GREEN regression guards (stable behavior already correct)
  // ═════════════════════════════════════════════════════════════
  group('D: regression guards', () {
    test('D1: import preserves prev_hash linkage across all blocks', () async {
      final crypto = _freshCrypto();
      final chainMaps = _canonicalChain(crypto);
      final json = _encodeImport(chainMaps);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      final maps = restored.readAll();
      for (var i = 1; i < maps.length; i++) {
        expect(maps[i]['prev_hash'], getBlockHash(maps[i - 1]),
            reason: 'prev_hash linkage must survive import (block $i)');
      }

      await db.close();
    });

    test('D2: importing a summary must not fabricate spurious day_index', () async {
      final crypto = _freshCrypto();
      final gen = _buildGenesis(crypto);
      final day = _buildDay(crypto, prevHash: gen['block_hash'] as String, dateStr: '2025-01-15');
      final month = _buildMonth(crypto, prevHash: day['day_hash'] as String);
      final year = _buildYear(crypto, prevHash: month['month_hash'] as String);
      final json = _encodeImport([gen, day, month, year]);

      final (db, service) = await _fresh();
      await service.importFromJson(json);

      final restored = _restoredChain(db, crypto);
      final maps = restored.readAll();
      final summaries = maps.where((m) =>
          m['type'] == 'month_summary' || m['type'] == 'year_summary').toList();
      for (final s in summaries) {
        expect(s.containsKey('month') || s.containsKey('year'), isTrue,
            reason: 'summaries carry their calendar identity, not a day_index');
      }

      await db.close();
    });
  });
}
