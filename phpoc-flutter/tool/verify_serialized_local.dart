// Local, network-free safety check: serialize phone block(s) through the FIXED
// PhpSpecFormat, obfuscate + deobfuscate (the exact push→remote→pull round-trip),
// and confirm the deobfuscated block's block seal matches its stored hash.
// Proves the bytes we'd push to remote will verify — no side effects.
//
//   dart run tool/verify_serialized_local.dart <phone.db> <seedB64> <idx...>

import 'dart:convert';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/utils/phpsec_format.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:sqlite3/sqlite3.dart';

const genesisPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

Future<void> main(List<String> args) async {
  final dbPath = args[0];
  final seedB64 = args[1];
  final targets = args.sublist(2).map(int.parse).toList();

  final crypto = CryptoService();
  await crypto.initialize();
  final mkHex = crypto.deriveMasterKey(seedB64);
  crypto.setMasterKey(mkHex);
  print('MK (hex suffix): …${mkHex.substring(mkHex.length - 8)}');

  // LedgerChain provides verifyBlockSeal via SealableChain; store is unused
  // for verifyBlockSeal, so pass a minimal stub.
  final chain = LedgerChain(crypto: crypto, store: _NoopStore());

  final db = sqlite3.open(dbPath);
  final rows = db.select(
      'SELECT block_id, block_type, block_index, key_version, data_enc, '
      'identity_seal, prev_hash, created_at FROM blocks ORDER BY block_index');
  db.dispose();
  final byIdx = {for (final r in rows) (r['block_index'] as int): r};

  var anyFail = false;
  for (final idx in targets) {
    final r = byIdx[idx];
    if (r == null) {
      print('  idx $idx: not found in phone DB');
      anyFail = true;
      continue;
    }
    final b = Block(
      blockId: r['block_id'] as String,
      blockType: _type(r['block_type'] as String),
      blockIndex: idx,
      keyVersion: r['key_version'] as int? ?? 1,
      dataEnc: r['data_enc'] as String,
      identitySeal: r['identity_seal'] as String?,
      prevHash: r['prev_hash'] as String? ?? genesisPrevHash,
      createdAt: r['created_at'] as int? ?? 0,
    );

    // Exact push serialization (fixed PhpSpecFormat) → obfuscate → deobfuscate.
    final map = PhpSpecFormat.blockToMap(b);
    final serialized = jsonEncodeSortedNoSpaces(map);
    final obf = crypto.obfuscateBlob(serialized, mkHex);
    final deobf = crypto.deobfuscateBlob(obf, mkHex);
    final restored = jsonDecode(deobf) as Map<String, dynamic>;

    final ok = chain.verifyBlockSeal(restored);
    final storedHash =
        (restored[PhpSpecFormat.sealFieldNames['day']!] ?? b.blockId)
            .toString()
            .substring(0, 12);
    print('  idx $idx day_index=${restored['day_index']} stored=$storedHash… '
        'verifyBlockSeal=${ok ? "GREEN" : "FAIL"}');
    if (!ok) anyFail = true;
  }

  print(anyFail ? '\nRESULT: FAIL' : '\nRESULT: ALL GREEN — safe to push');
  if (anyFail) throw StateError('seal verification failed');
}

BlockType _type(String s) => switch (s) {
      'genesis' => BlockType.genesis,
      'day' => BlockType.day,
      'month_summary' => BlockType.month,
      'year_summary' => BlockType.year,
      _ => BlockType.day,
    };

String jsonEncodeSortedNoSpaces(Map<String, dynamic> data) {
  final sortedKeys = data.keys.toList()..sort();
  final pairs = <String>[];
  for (final key in sortedKeys) {
    final value = encodeValueNoSpaces(data[key]);
    pairs.add('${jsonEncode(key)}:$value');
  }
  return '{${pairs.join(',')}}';
}

String encodeValueNoSpaces(dynamic value) {
  if (value == null) return 'null';
  if (value is bool) return value ? 'true' : 'false';
  if (value is num) return value.toString();
  if (value is String) return jsonEncode(value);
  if (value is List) return '[${value.map(encodeValueNoSpaces).join(',')}]';
  if (value is Map) {
    final sorted = value.keys.toList()..sort();
    return '{${sorted.map((k) => '${jsonEncode(k)}:${encodeValueNoSpaces(value[k])}').join(',')}}';
  }
  return jsonEncode(value);
}

class _NoopStore {
  int getBlockCount() => 0;
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) => [];
  Map<String, dynamic>? getLastBlock() => null;
  void appendBlocks(List<Map<String, dynamic>> b) {}
  List<Map<String, dynamic>> truncate(int count) => [];
}
