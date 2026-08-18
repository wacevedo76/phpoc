import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/utils/phpsec_format.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';

/// Regression test for the interleaved-summary day_index round-trip bug.
///
/// Root cause: `PhpSpecFormat.blockToMap` (shared by push + export) emitted
/// `day_index = block.blockIndex` (DB array position). Once month/year
/// summary blocks interleave, a day block's true sealed `day_index` differs
/// from its array index. The exported/pushed block then carried a day_index
/// the `day_hash` was never sealed over → a subsequent pull + verify() failed
/// the block seal with "Integrity Check Failed" (repro'd on the emulator at
/// blocks 132/133). The fix prefers the sealed day_index carried in data_enc.

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

class _SeededStore {
  final List<Map<String, dynamic>> blocks;
  _SeededStore(this.blocks);
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? blocks.length;
    return blocks.sublist(start, e);
  }

  int getBlockCount() => blocks.length;
  Map<String, dynamic>? getLastBlock() => blocks.isEmpty ? null : blocks.last;
  void appendBlocks(List<Map<String, dynamic>> b) => blocks.addAll(b);
  List<Map<String, dynamic>> truncate(int keepCount) => [];
}

void main() {
  group('PhpSpecFormat.blockToMap day_index round-trip', () {
    test('emits the sealed day_index, not the DB array position', () async {
      final crypto = CryptoService();
      await crypto.initialize();
      crypto.setMasterKey(mkHex);

      // Seed 121 prior day blocks so the next day block is sealed with a
      // TRUE day_index of 122 (buildDayBlock uses existing-day-count + 1).
      final seeded = _SeededStore([
        for (var i = 0; i < 121; i++)
          {'type': 'day', 'day_index': i + 1, 'day_hash': 'd' * 64}
      ]);
      final chain = LedgerChain(crypto: crypto, store: seeded);
      final dayBlock = chain.buildDayBlock(
        entries: <Map<String, dynamic>>[
          {'data': {'title': 'Nitrotype', 'start_epoch': 1746684000, 'duration': 1302784}, 'hash': 'x' * 64}
        ],
        prevHash: 'b' * 64,
        dateStr: '2026-05-08',
      );
      expect(dayBlock['day_index'], 122,
          reason: 'sanity: full map carries the true sealed day_index');

      // Persist through the real write path so the DB row is authoritative.
      // The block sits at array position 0 here, but the sealed day_index
      // (122) already differs — the divergence the bug produced in the wild.
      final db = AppDatabase.inMemory();
      final store = LedgerBlockStore(db.blockDao);
      store.appendBlocks([dayBlock]);

      final row = (await db.blockDao.getAllBlocks()).first;
      expect(row.blockType, BlockType.day);
      expect(row.blockIndex, 0, reason: 'sanity: DB array position is 0');

      final pushedMap = PhpSpecFormat.blockToMap(row);
      expect(pushedMap['day_index'], 122,
          reason: 'must emit the sealed day_index (122), NOT the array position (0); '
              'otherwise a pull round-trip fails the day_hash seal');
      await db.close();
    });
  });
}
