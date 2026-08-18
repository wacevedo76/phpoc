// Diagnostic: run the real LedgerChain.verify() against a dumped emulator
// phpoc.db using the canonical MK derived from the recovery seed.
//
// Usage:
//   dart run tool/diag_verify.dart /tmp/em_live_appdb.db
//
// Read-only with respect to the source DB.

import 'dart:io';
import 'dart:convert';
import 'package:sqlite3/sqlite3.dart' as sqlite;
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, verifyEntryHashTwoWay, verifyContentHash;

/// Canonical recovery seed (dev ledger). MK = base64-decode(seed).
const _seed = 'APuJ75EWteCJm9ix0/xHY+/JojRehcXwZR5XiQWmeU0=';

class DiagStore {
  DiagStore(String dbPath) {
    final db = sqlite.sqlite3.open(dbPath);
    final cols = db.select('SELECT * FROM blocks LIMIT 0').columnNames;
    final rows = db.select('SELECT * FROM blocks ORDER BY block_index');
    _blocks = rows.map((r) {
      final map = <String, Object?>{};
      for (var i = 0; i < cols.length; i++) {
        map[cols[i]] = r[i];
      }
      return Block(
        blockId: map['block_id'] as String,
        blockType: BlockType.values.asNameMap()[map['block_type'] as String]!,
        blockIndex: map['block_index'] as int,
        keyVersion: (map['key_version'] as int? ?? 1),
        dataEnc: map['data_enc'] as String,
        identitySeal: map['identity_seal'] as String?,
        prevHash: map['prev_hash'] as String? ?? '',
        createdAt: (map['created_at'] as int? ?? 0),
      );
    }).toList();
    db.dispose();
  }
  late final List<Block> _blocks;

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e).map(_toMap).toList();
  }
  int getBlockCount() => _blocks.length;
  Map<String, dynamic>? getLastBlock() => _blocks.isEmpty ? null : _toMap(_blocks.last);
  void appendBlocks(List<Map<String, dynamic>> blocks) {}
  List<Map<String, dynamic>> truncate(int keepCount) => [];

  /// Mirrors LedgerBlockStore._blockToMap exactly.
  static Map<String, dynamic> _toMap(Block b) {
    Map<String, dynamic> map = _decode(b.dataEnc);
    map['block_id'] = b.blockId;
    map['prev_hash'] = b.prevHash;
    map['key_version'] = b.keyVersion;
    map['identity_seal'] = b.identitySeal;
    map['block_index'] = b.blockIndex;
    if (!map.containsKey('type') || map['type'] == null) {
      map['type'] = switch (b.blockType) {
        BlockType.genesis => 'genesis',
        BlockType.day => 'day',
        BlockType.month => 'month_summary',
        BlockType.year => 'year_summary',
      };
    }
    final hashKey = switch (b.blockType) {
      BlockType.genesis => 'block_hash',
      BlockType.day => 'day_hash',
      BlockType.year => 'year_hash',
      BlockType.month => 'month_hash',
    };
    map[hashKey] = b.blockId;
    if (b.blockType == BlockType.day && !map.containsKey('day_index')) {
      map['day_index'] = b.blockIndex;
    }
    return map;
  }

  static Map<String, dynamic> _decode(String dataEnc) {
    try {
      return _json(utf8.decode(base64.decode(dataEnc)));
    } catch (_) {
      try {
        return _json(dataEnc);
      } catch (_) {
        return <String, dynamic>{};
      }
    }
  }

  static Map<String, dynamic> _json(String raw) {
    final p = json.decode(raw);
    if (p is List) {
      String date = '1970-01-01';
      if (p.isNotEmpty) {
        for (final e in p) {
          if (e is! Map) continue;
          final d = e['data'];
          if (d is Map) {
            final ep = d['start_epoch'];
            if (ep is int && ep > 0) {
              final dd = DateTime.fromMillisecondsSinceEpoch(ep * 1000, isUtc: true);
              date = '${dd.year.toString().padLeft(4, '0')}-${dd.month.toString().padLeft(2, '0')}-${dd.day.toString().padLeft(2, '0')}';
              break;
            }
          }
        }
      }
      return {'entries': p.cast<Map<String, dynamic>>(), 'date': date};
    }
    return p as Map<String, dynamic>;
  }
}

Future<void> main(List<String> args) async {
  if (args.length != 1) {
    stderr.writeln('usage: dart run tool/diag_verify.dart <phpoc.db>');
    exit(2);
  }
  final dbPath = args[0];
  if (!File(dbPath).existsSync()) {
    stderr.writeln('no such file: $dbPath');
    exit(2);
  }

  final crypto = CryptoService();
  await crypto.initialize();
  final mkHex = _toHex(base64.decode(_seed));
  crypto.setMasterKey(mkHex);

  final store = DiagStore(dbPath);
  final chain = LedgerChain(crypto: crypto, store: store); // identitySecret: null
  final blocks = store.readBlocks();

  print('blocks loaded: ${blocks.length}');
  print('MK hex: $mkHex');

  var failures = 0;
  for (var i = 0; i < blocks.length; i++) {
    final block = blocks[i];
    if (i > 0) {
      final expected = getBlockHash(blocks[i - 1]);
      final actual = block['prev_hash'] as String? ?? '';
      if (expected.isNotEmpty && actual != expected) {
        print('FAIL[$i] prev_hash: expected $expected got $actual');
        failures++;
        continue;
      }
    }
    if (!chain.verifyBlockSeal(block)) {
      print('FAIL[$i] BLOCK SEAL type=${block['type']} day_index=${block['day_index']} '
          'stored_hash=${(block['day_hash'] ?? block['block_hash'] ?? '').toString().substring(0, 12)}…');
      failures++;
      continue;
    }
    if (block['type'] == 'day') {
      final entries = block['entries'] as List<dynamic>? ?? [];
      for (var j = 0; j < entries.length; j++) {
        final e = entries[j];
        if (e is! Map) {
          print('FAIL[$i] entry $j not a map');
          failures++;
          break;
        }
        final data = e['data'] as Map<String, dynamic>?;
        final hash = e['hash'] as String?;
        if (data == null || hash == null) {
          print('FAIL[$i] entry $j missing data/hash');
          failures++;
          break;
        }
        if (!verifyEntryHashTwoWay(data, hash)) {
          print('FAIL[$i] ENTRY hash idx=$j hash=$hash');
          failures++;
        }
        final ch = data['content_hash'] as String?;
        if (ch == null || ch.isEmpty) {
          print('FAIL[$i] entry $j MISSING content_hash');
          failures++;
        } else if (!verifyContentHash(data, ch, decryptFn: (c) => crypto.decryptWithCachedKey(c))) {
          print('FAIL[$i] CONTENT hash idx=$j');
          failures++;
        }
      }
    }
  }

  print('---');
  final full = chain.verify();
  print('full-chain verify(): $full');
  if (failures == 0 && full) {
    print('ALL CHECKS PASSED');
  } else {
    print('FAILURES: $failures');
  }
  print('---');
  print('genesis type=${blocks[0]['type']} date=${blocks[0]['date']}');
  print('day blocks: ${blocks.where((b) => b['type'] == 'day').length}/${blocks.length}');
}

String _toHex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
