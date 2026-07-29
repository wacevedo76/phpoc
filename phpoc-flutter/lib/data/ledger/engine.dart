import 'dart:convert';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, computeEntryHash, computeContentHash, epochToDate;
import 'package:phpoc_flutter/data/ledger/index_manager.dart';
import 'package:phpoc_flutter/data/ledger/summary_policy.dart';

/// Unified public API for the ledger engine — commit, verify, revert, query.
///
/// Coordinates LedgerChain, IndexManager, and staging store.
/// Must match Python `domain/ledger/engine.py` behavior.
class LedgerEngine {
  final CryptoService crypto;
  final LedgerChain chain;
  final IndexManager index;
  final dynamic stagingStore;
  final String? identitySecret;
  final String formatVersion;

  LedgerEngine({
    required this.crypto,
    required dynamic store,
    required dynamic indexStore,
    required this.stagingStore,
    this.identitySecret,
    String? formatVersion,
  })  : formatVersion = formatVersion ?? '0.4.0',
        chain = LedgerChain(
          crypto: crypto,
          store: store,
          identitySecret: identitySecret,
        ),
        index = IndexManager(
          store: indexStore,
          crypto: crypto,
        );

  // ═══════════════════════════════════════════════════════════════
  // Commit
  // ═══════════════════════════════════════════════════════════════

  /// Commit staging entries to the ledger chain.
  ///
  /// Groups entries by date, encrypts fields, computes hashes, builds day blocks,
  /// inserts summary blocks, updates the blind index.
  ///
  /// Returns the first 10 chars of the last block hash, or null if no entries.
  String? commit(List<Map<String, dynamic>> entries) {
    if (entries.isEmpty) return null;

    // Validate
    for (final entry in entries) {
      final title = entry['title'];
      if (title is! String) {
        throw Exception('Entry title must be a string');
      }
      final startEpoch = entry['start_epoch'];
      if (startEpoch is! int || startEpoch <= 0) {
        throw Exception('Entry start_epoch must be a positive integer');
      }
    }

    // Group by date (UTC from start_epoch) BEFORE preparing
    final byDate = <String, List<Map<String, dynamic>>>{};
    for (final entry in entries) {
      final epoch = entry['start_epoch'] as int;
      final date = epochToDate(epoch);
      byDate.putIfAbsent(date, () => []).add(entry);
    }

    // Sort dates
    final dates = byDate.keys.toList()..sort();

    // Determine prev_hash
    final lastBlock = chain.getLastBlock();
    String prevHash;
    if (lastBlock != null) {
      prevHash = getBlockHash(lastBlock);
    } else {
      prevHash = '0' * 64;
    }

    final summaryPolicy = YearMonthSummaryPolicy(
      crypto: crypto,
      identitySecret: identitySecret,
    );

    // Build and append blocks for each date
    var lastHash = '';
    for (final date in dates) {
      final rawEntries = byDate[date]!;

      // Prepare entries: encrypt fields, compute hashes
      final prepared = _prepareEntries(rawEntries);

      // Sort entries alphabetically by title
      prepared.sort((a, b) {
        final titleA = (a['data']['title'] ?? '') as String;
        final titleB = (b['data']['title'] ?? '') as String;
        return titleA.compareTo(titleB);
      });

      // Insert summary blocks if needed
      if (lastBlock != null || chain.getBlockCount() > 0) {
        final prevBlock = chain.getLastBlock() ?? lastBlock;
        if (prevBlock != null) {
          final summaries = summaryPolicy.getSummaryBlocks(prevBlock, date);
          if (summaries.isNotEmpty) {
            chain.appendBlocks(summaries);
            // Update prevHash to the last summary's hash
            prevHash = getBlockHash(summaries.last);
          }
        }
      }

      // Build and append day block
      final dayBlock = chain.buildDayBlock(
        entries: prepared,
        prevHash: prevHash,
        dateStr: date,
      );
      chain.append(dayBlock);

      // Update index with entry durations
      for (final entry in prepared) {
        final data = entry['data'] as Map<String, dynamic>;
        final hasEncryptedFields = data['has_encrypted_fields'] as bool? ?? false;
        final title = data['title'] as String? ?? '';
        final duration = data['duration'] as int? ?? 0;

        // Skip encrypted titles in the index
        if (hasEncryptedFields && data.containsKey('title_enc') && !data.containsKey('title')) {
          continue;
        }

        if (title.isNotEmpty && duration > 0) {
          index.update(date, title, duration);
        }
      }

      // Update prev_hash for next iteration
      prevHash = getBlockHash(dayBlock);
      lastHash = prevHash;
    }

    // Return hash prefix (first 10 chars of last block hash)
    if (lastHash.isEmpty) return null;
    return lastHash.length >= 10 ? lastHash.substring(0, 10) : lastHash;
  }

  // ═══════════════════════════════════════════════════════════════
  // Verify
  // ═══════════════════════════════════════════════════════════════

  /// Verify the entire chain (delegates to LedgerChain.verify).
  bool verify() {
    return chain.verify();
  }

  // ═══════════════════════════════════════════════════════════════
  // Revert
  // ═══════════════════════════════════════════════════════════════

  /// Revert the last [count] day blocks, restoring entries to staging.
  ///
  /// Returns the number of entries restored, or -1 if count exceeds
  /// available day blocks.
  int revert(int count) {
    if (count == 0) return 0;

    final dayBlocks = chain.getDayBlocks();
    if (count > dayBlocks.length) return -1;

    final toRevert = dayBlocks.sublist(dayBlocks.length - count);
    final allBlocks = chain.readAll();

    // Decrypt entries and build staging data
    var entryCount = 0;
    final stagingEntries = <Map<String, dynamic>>[];
    for (final block in toRevert) {
      final date = block['date'] as String? ?? '';
      for (final entry in block['entries'] as List<dynamic>? ?? []) {
        stagingEntries.add(_restoreEntryToStaging(entry, date));
        entryCount++;
      }
    }

    // Remove reverted blocks from the chain
    final firstRevertedIdx = allBlocks.indexOf(toRevert.first);
    _truncateFrom(firstRevertedIdx);

    // Prepend restored entries to existing staging
    try {
      final existing = stagingStore.readEntries() as List<dynamic>? ?? [];
      stagingStore.writeEntries([...stagingEntries, ...existing]);
    } catch (_) {
      stagingStore.writeEntries(stagingEntries);
    }

    return entryCount;
  }

  /// Decrypt an entry's data and subtract from the blind index.
  ///
  /// Returns the staging-format entry wrapper {hash, data}.
  Map<String, dynamic> _restoreEntryToStaging(
    Map<String, dynamic> entry,
    String date,
  ) {
    var data = _decryptPerField(
      _decryptForStaging(Map<String, dynamic>.from(entry['data'] as Map)),
    );

    final hasEncryptedFields = data['has_encrypted_fields'] as bool? ?? false;
    final title = data['title'] as String? ?? '';
    final duration = data['duration'] as int? ?? 0;

    if (!hasEncryptedFields && title.isNotEmpty && duration > 0) {
      index.update(date, title, -duration);
    }

    return {'hash': entry['hash'], 'data': data};
  }

  // ═══════════════════════════════════════════════════════════════
  // Query & Index
  // ═══════════════════════════════════════════════════════════════

  /// Return the total number of blocks.
  int getBlockCount() {
    return chain.getBlockCount();
  }

  /// Return only day-type blocks.
  List<Map<String, dynamic>> getDayBlocks() {
    return chain.getDayBlocks();
  }

  /// Return the last block, or null.
  Map<String, dynamic>? getLastBlock() {
    return chain.getLastBlock();
  }

  /// Query the blind index for [fromDate]..[toDate].
  Map<String, int> queryIndex(String fromDate, String toDate) {
    return index.query(fromDate, toDate);
  }

  /// Rebuild the blind index from the chain.
  void rebuildIndex() {
    index.clear();

    for (final block in chain.readAll()) {
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

        // Skip entries with encrypted titles
        if (hasEncryptedFields && title == null && data.containsKey('title_enc')) {
          continue;
        }

        if (title != null && title.isNotEmpty && duration > 0) {
          index.update(date, title, duration);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// Prepare entries for commit: encrypt fields, compute hashes.
  List<Map<String, dynamic>> _prepareEntries(List<Map<String, dynamic>> entries) {
    return entries.map((entry) {
      final data = Map<String, dynamic>.from(entry);

      // Ensure required fields
      final startEpoch = data['start_epoch'] as int;
      final duration = data['duration'] as int? ?? 0;
      final endEpoch = data['end_epoch'] as int?;

      // Compute end_epoch if missing
      final actualEnd = endEpoch ?? (startEpoch + duration);

      // Strip staging-only fields
      data.remove('is_active');
      data.remove('entry_id');
      data.remove('device_uuid');
      data.remove('hash');

      // Encrypt standard fields
      data['startTime_enc'] = crypto.encryptWithCachedKey(startEpoch.toString());
      data['endTime_enc'] = crypto.encryptWithCachedKey(actualEnd.toString());
      data['metadata_enc'] = crypto.encryptWithCachedKey(
        jsonEncode(data['metadata'] ?? <String, dynamic>{})
      );
      data['pauses_enc'] = crypto.encryptWithCachedKey(
        jsonEncode(data['pauses'] ?? <Map<String, dynamic>>[])
      );

      // Remove plaintext standard fields
      data.remove('start_epoch');
      data.remove('end_epoch');
      data.remove('metadata');
      data.remove('pauses');

      // Per-field encryption
      final hasEncryptedFields = data['has_encrypted_fields'] as bool? ?? false;
      if (hasEncryptedFields) {
        // Always encrypt title
        final title = data['title'] as String? ?? '';
        data['title_enc'] = crypto.encryptWithCachedKey(title);
        data.remove('title');

        // Always encrypt tags (as sorted JSON array)
        final tags = data['tags'] as List<dynamic>? ?? <String>[];
        data['tags_enc'] = crypto.encryptWithCachedKey(jsonEncode(tags));
        data.remove('tags');

        // Comment: only encrypt if non-empty
        final comment = data['comment'] as String?;
        if (comment != null && comment.isNotEmpty) {
          data['comment_enc'] = crypto.encryptWithCachedKey(comment);
          data.remove('comment');
        }

        // Duration: only encrypt if non-zero
        if (duration > 0) {
          data['duration_enc'] = crypto.encryptWithCachedKey(duration.toString());
          data.remove('duration');
        }
      }

      // Compute content hash
      data['content_hash'] = computeContentHash(data, crypto);

      // Build {hash, data} wrapper
      final computedHash = computeEntryHash(data);

      return {
        'hash': computedHash,
        'data': data,
      };
    }).toList();
  }

  /// Decrypt standard encrypted fields for staging (plain: prefix).
  Map<String, dynamic> _decryptForStaging(Map<String, dynamic> data) {
    final result = Map<String, dynamic>.from(data);

    // Decrypt standard fields and add plain: prefix
    final encryptable = ['startTime_enc', 'endTime_enc', 'metadata_enc', 'pauses_enc'];
    for (final key in encryptable) {
      if (result.containsKey(key)) {
        final encrypted = result[key] as String?;
        if (encrypted != null && encrypted.isNotEmpty) {
          try {
            final plaintext = crypto.decryptWithCachedKey(encrypted);
            result[key] = 'plain:$plaintext';
          } catch (_) {
            // Keep as-is if decryption fails
          }
        }
      }
    }

    // Ensure pauses_enc exists
    if (!result.containsKey('pauses_enc')) {
      result['pauses_enc'] = 'plain:[]';
    }

    return result;
  }

  /// Decrypt per-field encrypted fields back to plaintext.
  Map<String, dynamic> _decryptPerField(Map<String, dynamic> data) {
    final result = Map<String, dynamic>.from(data);

    // title_enc → title
    if (result.containsKey('title_enc')) {
      final encrypted = result['title_enc'] as String?;
      if (encrypted != null && encrypted.isNotEmpty) {
        try {
          result['title'] = crypto.decryptWithCachedKey(encrypted);
        } catch (_) {}
      }
      result.remove('title_enc');
    }

    // tags_enc → tags
    if (result.containsKey('tags_enc')) {
      final encrypted = result['tags_enc'] as String?;
      if (encrypted != null && encrypted.isNotEmpty) {
        try {
          final plain = crypto.decryptWithCachedKey(encrypted);
          result['tags'] = jsonDecode(plain);
        } catch (_) {}
      }
      result.remove('tags_enc');
    }

    // comment_enc → comment
    if (result.containsKey('comment_enc')) {
      final encrypted = result['comment_enc'] as String?;
      if (encrypted != null && encrypted.isNotEmpty) {
        try {
          result['comment'] = crypto.decryptWithCachedKey(encrypted);
        } catch (_) {}
      }
      result.remove('comment_enc');
    }

    // duration_enc → duration
    if (result.containsKey('duration_enc')) {
      final encrypted = result['duration_enc'] as String?;
      if (encrypted != null && encrypted.isNotEmpty) {
        try {
          final plain = crypto.decryptWithCachedKey(encrypted);
          result['duration'] = int.tryParse(plain) ?? 0;
        } catch (_) {}
      }
      result.remove('duration_enc');
    }

    return result;
  }

  /// Truncate blocks starting from [index].
  List<Map<String, dynamic>> _truncateFrom(int index) {
    final allBlocks = chain.readAll();
    final toRemove = allBlocks.length - index;
    return chain.truncate(toRemove);
  }

}
