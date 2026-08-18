// Diagnostic + repair for the day_index corruption bug.
//
// Reads the phone's local DB (source of truth — correct sealed day_index),
// re-serializes blocks through the FIXED `PhpSpecFormat.blockToMap`, and
// re-pushes the corrupted blocks to the remote Worker so a fresh Restore
// verifies cleanly. Also verifies ground truth by pulling + deobfuscating
// the current remote blobs first.
//
// Usage:
//   dart run tool/repair_remote_blocks.dart <phone.db> <seedBase64> <workerUrl> <apiKey> [startIdx]
//
// Defaults to repairing indices [startIdx..lastBlock] (pass 132 to only fix
// blocks 132/133, or omit to repair the whole chain).

import 'dart:convert';
import 'dart:typed_data';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/core/utils/phpsec_format.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:sqlite3/sqlite3.dart';

const genesisPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

Block _blockFromRow(List<dynamic> r) {
  // Row: block_id, block_type, block_index, key_version, data_enc,
  //      identity_seal, prev_hash, created_at
  final typeStr = r[1] as String;
  final blockType = switch (typeStr) {
    'genesis' => BlockType.genesis,
    'day' => BlockType.day,
    'month_summary' => BlockType.month,
    'year_summary' => BlockType.year,
    _ => BlockType.day,
  };
  return Block(
    blockId: r[0] as String,
    blockType: blockType,
    blockIndex: (r[2] as int),
    keyVersion: (r[3] as int? ?? 1),
    dataEnc: r[4] as String,
    identitySeal: r[5] as String?,
    prevHash: (r[6] as String? ?? genesisPrevHash),
    createdAt: (r[7] as int? ?? 0),
  );
}

Future<void> main(List<String> args) async {
  if (args.length < 4) {
    print('usage: dart run tool/repair_remote_blocks.dart '
        '<phone.db> <seedB64> <workerUrl> <apiKey> [startIdx]');
    return;
  }
  final dbPath = args[0];
  final seedB64 = args[1];
  final workerUrl = args[2];
  final apiKey = args[3];
  final dryRun = args.contains('--dry-run');
  final startIdx = args.length > 4 && args[4] != '--dry-run'
      ? int.parse(args[4])
      : 0;
  final crypto = CryptoService();
  await crypto.initialize();
  final mkHex = crypto.deriveMasterKey(seedB64);
  print('MK hex: $mkHex');
  crypto.setMasterKey(mkHex);

  final transport = HttpTransport(baseUrl: workerUrl, apiKey: apiKey);

  // 1. Load phone DB (source of truth).
  final db = sqlite3.open(dbPath);
  final rows = db.select(
      'SELECT block_id, block_type, block_index, key_version, data_enc, '
      'identity_seal, prev_hash, created_at FROM blocks ORDER BY block_index');
  final blocks = <Block>[for (final r in rows) _blockFromRow(r.values)];
  final lastIdx = blocks.last.blockIndex;
  print('phone DB: ${blocks.length} blocks (0..$lastIdx)');

  // 2. Before fixing, pull + deobfuscate the current remote blobs for the
  //    target indices to confirm ground-truth (the corruption).
  for (final i in [for (var x = startIdx; x <= lastIdx; x++) x]) {
    final path = 'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
    final blob = await transport.pull(path);
    if (blob == null) {
      print('  remote $path: MISSING');
      continue;
    }
    try {
      final s = crypto.deobfuscateBlob(blob, mkHex);
      final m = jsonDecode(s) as Map<String, dynamic>;
      final local = blocks[i];
      final localMap = PhpSpecFormat.blockToMap(local);
      final di = m['day_index'];
      final diLocal = localMap['day_index'];
      final flag = di == diLocal ? 'OK' : '** CORRUPT ** day_index remote=$di vs phone=$diLocal';
      print('  remote $path day_index=$di  (phone=$diLocal)  $flag');
    } catch (e) {
      print('  remote $path: deobfuscate failed: $e');
    }
  }

  // 3. Re-push corrected blocks [startIdx..lastIdx] through the FIXED
  //    serializer. If starting from 0, also re-push a fresh plaintext
  //    hash_index (block hashes in chain order, unchanged by the fix —
  //    only day_index inside the blob changes).  --dry-run skips writes.
  print('\nRe-pushing blocks $startIdx..$lastIdx via fixed PhpSpecFormat...'
      ' (${dryRun ? 'DRY RUN — no writes' : 'WRITING to remote'})');
  for (var i = startIdx; i <= lastIdx; i++) {
    final block = blocks[i];
    final map = PhpSpecFormat.blockToMap(block);
    final serialized = jsonEncodeSortedNoSpaces(map);
    final obfuscated = crypto.obfuscateBlob(serialized, mkHex);
    final path = 'ledger/blocks/${i.toString().padLeft(6, '0')}.json';
    print(dryRun
        ? '  (dry-run) would push $path day_index=${map['day_index']} hash=${block.blockId}'
        : '  pushing $path day_index=${map['day_index']} hash=${block.blockId}');
    if (!dryRun) await transport.push(path, obfuscated);
  }
  if (startIdx == 0 && !dryRun) {
    final allHashes = <String>[
      for (final b in blocks) b.blockId,
    ];
    final hi = jsonEncode(allHashes);
    await transport.push('ledger/hash_index.json',
        Uint8List.fromList(utf8.encode(hi)));
    print('re-pushed hash_index.json (${allHashes.length} hashes)');
  }

  print('\nDone. Fetched remote now corrected; run Restore from Cloud on the '
      'emulator and verify: dart run tool/diag_verify.dart /tmp/em_post_diag.db');
}

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
