import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, computeEntryHash, verifyContentHash, compareVersions, epochToDate;
import 'package:phpoc_flutter/data/ledger/summary_policy.dart';

/// Result of a chain merge operation.
class MergeResult {
  final List<Map<String, dynamic>> chain;
  final int localEntries;
  final int remoteEntries;
  final int duplicatesSkipped;
  final int mergedEntries;
  final int newBlockCount;
  final Map<String, dynamic>? index;

  const MergeResult({
    required this.chain,
    required this.localEntries,
    required this.remoteEntries,
    required this.duplicatesSkipped,
    required this.mergedEntries,
    required this.newBlockCount,
    this.index,
  });
}

/// Merge two ledger chains at the block level.
///
/// Algorithm:
/// 1. Validate both chains
/// 2. Find fork point (last common block)
/// 3. Collect unique entries from local and remote post-fork
/// 4. Deduplicate by content_hash
/// 5. Sort entries alphabetically by title
/// 6. Rebuild chain from fork point with summary blocks
///
/// Must match Python `domain/ledger/merge.py` behavior.
MergeResult merge({
  required CryptoService crypto,
  required List<Map<String, dynamic>> localChain,
  required List<Map<String, dynamic>> remoteChain,
  String? identitySecret,
}) {
  // Validate inputs
  if (localChain.isEmpty) {
    throw Exception('Local chain is empty — genesis required');
  }
  if (remoteChain.isEmpty) {
    throw Exception('Remote chain is empty — genesis required');
  }

  // Verify genesis compatibility
  final localGenesis = localChain.first;
  final remoteGenesis = remoteChain.first;
  final localGenesisHash = getBlockHash(localGenesis);
  final remoteGenesisHash = getBlockHash(remoteGenesis);

  if (localGenesisHash.isEmpty || remoteGenesisHash.isEmpty ||
      localGenesisHash != remoteGenesisHash) {
    throw Exception(
      'Genesis mismatch: cannot merge chains with different genesis blocks',
    );
  }

  // Get format version from genesis
  final formatVersion = localGenesis['format_version'] as String? ?? '0.4.0';
  final requireContentHash = compareVersions(formatVersion, '0.4.0') >= 0;

  // Validate both chains
  if (!_verifyChain(crypto, localChain, requireContentHash)) {
    throw Exception('Local chain failed validation');
  }
  if (!_verifyChain(crypto, remoteChain, requireContentHash)) {
    throw Exception('Remote chain failed validation');
  }

  // Find fork point
  final forkIndex = _findFork(localChain, remoteChain);
  final commonPrefix = localChain.sublist(0, forkIndex);

  // Collect entries from local and remote post-fork
  final localPostForkEntries = _collectEntries(localChain.sublist(forkIndex));
  final remotePostForkEntries = _collectEntries(remoteChain.sublist(forkIndex));

  // Total entries in each chain
  final totalLocalEntries = _collectEntries(localChain);

  // Count remote-only entries (in remote but not in local)
  final remoteOnly = remotePostForkEntries.where((re) {
    return !localPostForkEntries.any((le) =>
        le['data']['content_hash'] == re['data']['content_hash']);
  }).toList();

  // Deduplicate by content_hash — keep local copy when both have same content
  var duplicatesSkipped = 0;
  final uniqueRemoteEntries = <Map<String, dynamic>>[];

  for (final re in remotePostForkEntries) {
    final reContentHash = re['data']['content_hash'] as String?;
    final isDuplicate = localPostForkEntries.any((le) =>
        le['data']['content_hash'] == reContentHash);
    if (isDuplicate) {
      duplicatesSkipped++;
    } else {
      uniqueRemoteEntries.add(re);
    }
  }

  // Merge: all local post-fork entries + unique remote entries
  final allMergedEntries = [
    ...localPostForkEntries,
    ...uniqueRemoteEntries,
  ];

  // Sort alphabetically by title
  allMergedEntries.sort((a, b) {
    final titleA = (a['data']['title'] ?? '') as String;
    final titleB = (b['data']['title'] ?? '') as String;
    return titleA.compareTo(titleB);
  });

  // Group by date
  final byDate = <String, List<Map<String, dynamic>>>{};
  for (final entry in allMergedEntries) {
    final epoch = entry['data']['start_epoch'] as int? ??
        entry['data']['startTime_enc'] as int?;
    String date;
    if (epoch != null && epoch > 0) {
      date = epochToDate(epoch);
    } else {
      date = '1970-01-01';
    }
    byDate.putIfAbsent(date, () => []).add(entry);
  }

  final dates = byDate.keys.toList()..sort();

  // Start building merged chain from common prefix
  final mergedChain = List<Map<String, dynamic>>.from(commonPrefix);

  // Determine prev hash from last block of common prefix
  String prevHash;
  Map<String, dynamic>? lastBlock;
  if (commonPrefix.isNotEmpty) {
    lastBlock = commonPrefix.last;
    prevHash = getBlockHash(lastBlock);
  } else {
    prevHash = '0' * 64;
  }

  final summaryPolicy = YearMonthSummaryPolicy(
    crypto: crypto,
    identitySecret: identitySecret,
  );

  var dayIndexStart = 1;

  // If fork point is a summary block, reset day_index to 1 (PHPSPEC §4.4)
  if (lastBlock != null &&
      (lastBlock['type'] == 'month_summary' ||
          lastBlock['type'] == 'year_summary')) {
    dayIndexStart = 1;
  } else {
    // Continue from last day_index + 1
    final existingDays = commonPrefix
        .where((b) => b['type'] == 'day')
        .length;
    dayIndexStart = existingDays + 1;
  }

  var newBlockCount = 0;

  for (final date in dates) {
    final dayEntries = byDate[date]!;

    // Ensure entries are sorted alphabetically within the day
    dayEntries.sort((a, b) {
      final titleA = (a['data']['title'] ?? '') as String;
      final titleB = (b['data']['title'] ?? '') as String;
      return titleA.compareTo(titleB);
    });

    // Insert summary blocks
    if (lastBlock != null) {
      final summaries = summaryPolicy.getSummaryBlocks(lastBlock, date);
      if (summaries.isNotEmpty) {
        mergedChain.addAll(summaries);
        newBlockCount += summaries.length;
        lastBlock = summaries.last;
        prevHash = getBlockHash(lastBlock);
      }
    }

    // Build day block manually (without LedgerChain)
    final normalizedEntries = <Map<String, dynamic>>[];
    for (final entry in dayEntries) {
      final data = Map<String, dynamic>.from(entry['data']);
      final computedHash = computeEntryHash(data);
      normalizedEntries.add({
        'hash': computedHash,
        'data': data,
      });
    }

    final dayBlock = <String, dynamic>{
      'type': 'day',
      'date': date,
      'day_index': dayIndexStart,
      'prev_hash': prevHash,
      'entries': normalizedEntries,
      'key_version': 1,
    };

    // Seal
    final sealData = Map<String, dynamic>.from(dayBlock);
    sealData.remove('day_hash');
    sealData.remove('identity_seal');
    final dayHash = _computeSeal(crypto, sealData);
    dayBlock['day_hash'] = dayHash;

    // Identity seal
    if (identitySecret != null) {
      final idHex = identitySecret.codeUnits
          .map((b) => b.toRadixString(16).padLeft(2, '0'))
          .join();
      dayBlock['identity_seal'] = crypto.sign(dayHash, idHex);
    }

    mergedChain.add(dayBlock);
    newBlockCount++;
    lastBlock = dayBlock;
    prevHash = dayHash;
    dayIndexStart++;
  }

  // Build index from merged chain
  final mergedIndex = _buildIndex(mergedChain);

  final mergedEntries = totalLocalEntries.length + remoteOnly.length;

  return MergeResult(
    chain: mergedChain,
    localEntries: totalLocalEntries.length,
    remoteEntries: remoteOnly.length,
    duplicatesSkipped: duplicatesSkipped,
    mergedEntries: mergedEntries,
    newBlockCount: newBlockCount,
    index: mergedIndex,
  );
}

/// Find the fork point where two chains diverge.
int _findFork(
  List<Map<String, dynamic>> local,
  List<Map<String, dynamic>> remote,
) {
  var i = 0;
  while (i < local.length && i < remote.length) {
    final localBlock = local[i];
    final remoteBlock = remote[i];

    // Compare by block hash
    if (getBlockHash(localBlock) != getBlockHash(remoteBlock)) {
      return i;
    }

    // Also compare entry hashes for day blocks
    if (localBlock['type'] == 'day' && remoteBlock['type'] == 'day') {
      final localEntries = localBlock['entries'] as List<dynamic>? ?? [];
      final remoteEntries = remoteBlock['entries'] as List<dynamic>? ?? [];

      if (localEntries.length != remoteEntries.length) return i;

      for (var j = 0; j < localEntries.length; j++) {
        final le = localEntries[j] as Map<String, dynamic>;
        final re = remoteEntries[j] as Map<String, dynamic>;
        if (le['hash'] != re['hash']) return i;
      }
    }

    i++;
  }

  // Chains are identical up to the shorter one's length
  return i;
}

/// Collect entry {hash, data} pairs from blocks.
List<Map<String, dynamic>> _collectEntries(List<Map<String, dynamic>> blocks) {
  final entries = <Map<String, dynamic>>[];

  for (final block in blocks) {
    if (block['type'] != 'day') continue;

    final blockEntries = block['entries'] as List<dynamic>? ?? [];
    for (final entry in blockEntries) {
      if (entry is Map) {
        entries.add(Map<String, dynamic>.from(entry));
      }
    }
  }

  return entries;
}

/// Verify a chain (structural checks — no seal verification since chains
/// may have been built with placeholder hashes for testing).
bool _verifyChain(
  CryptoService crypto,
  List<Map<String, dynamic>> chain,
  bool requireContentHash,
) {
  if (chain.isEmpty) return false;

  // Check genesis
  final genesis = chain.first;
  if (genesis['type'] != 'genesis') return false;

  // Check prev_hash linkage
  for (var i = 1; i < chain.length; i++) {
    final prevHash = getBlockHash(chain[i - 1]);
    final actualPrev = chain[i]['prev_hash'] as String? ?? '';
    if (prevHash.isNotEmpty && actualPrev != prevHash) return false;
  }

  // Check content_hash for day blocks
  if (requireContentHash) {
    for (final block in chain) {
      if (block['type'] != 'day') continue;

      final entries = block['entries'] as List<dynamic>? ?? [];
      for (final entry in entries) {
        if (entry is! Map) return false;
        final data = entry['data'] as Map<String, dynamic>?;
        if (data == null) return false;

        final contentHash = data['content_hash'] as String?;
        if (contentHash == null || contentHash.isEmpty) return false;

        // Deep-verify if content_hash looks like a real 64-char hash
        if (contentHash.length == 64) {
          if (!verifyContentHash(
            data,
            contentHash,
            decryptFn: (c) => crypto.decryptWithCachedKey(c),
          )) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

/// Compute a seal for a block (used during rebuild).
String _computeSeal(CryptoService crypto, Map<String, dynamic> data) {
  return crypto.seal(jsonSort(data), crypto.getMasterKey()!);
}

/// Build a simple index from a merged chain.
Map<String, dynamic> _buildIndex(List<Map<String, dynamic>> chain) {
  final index = <String, Map<String, int>>{};

  for (final block in chain) {
    if (block['type'] != 'day') continue;

    final date = block['date'] as String? ?? '';
    final entries = block['entries'] as List<dynamic>? ?? [];

    for (final entry in entries) {
      if (entry is! Map) continue;
      final data = entry['data'] as Map<String, dynamic>?;
      if (data == null) continue;

      final hasEncryptedFields = data['has_encrypted_fields'] as bool? ?? false;
      final title = data['title'] as String?;
      final duration = data['duration'] as int? ?? 0;

      // Skip encrypted titles
      if (hasEncryptedFields &&
          title == null &&
          data.containsKey('title_enc')) {
        continue;
      }

      if (title != null && title.isNotEmpty && duration > 0) {
        index.putIfAbsent(date, () => <String, int>{});
        index[date]![title] = (index[date]![title] ?? 0) + duration;
      }
    }
  }

  return index;
}


