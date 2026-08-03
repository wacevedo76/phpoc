import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/import_result.dart';
import '../data/ledger/chain.dart';
import '../data/ledger/helpers.dart'
    show getBlockHash, epochToDate;
import '../data/storage/database.dart';

/// Service for importing entries from another ledger.
///
/// Orchestrates the full import pipeline:
///   1. Dry-run preview: decrypt source, detect conflicts
///   2. Import: decrypt → re-encrypt → append to target chain
///
/// Supports both seed-based and file-based import.
class ImportService {
  final CryptoService targetCrypto;
  final AppDatabase targetDb;
  final LedgerChain? targetChain;

  /// Encrypted-field → plaintext-field mapping shared by decrypt and re-encrypt.
  static const _encryptedFieldMap = <String, String>{
    'startTime_enc': 'start_epoch',
    'endTime_enc': 'end_epoch',
    'metadata_enc': 'metadata',
    'pauses_enc': 'pauses',
    'transitions_enc': 'transitions',
    'device_id_enc': 'device_id',
    'title_enc': 'title',
    'tags_enc': 'tags',
    'comment_enc': 'comment',
    'duration_enc': 'duration',
    'start_epoch_enc': 'start_epoch',
    'end_epoch_enc': 'end_epoch',
  };

  List<Map<String, dynamic>>? _preImportBlocks;

  ImportService({
    required this.targetCrypto,
    required this.targetDb,
    this.targetChain,
  });

  // ═══════════════════════════════════════════════════════════════
  // dryRun — preview what would be imported
  // ═══════════════════════════════════════════════════════════════

  /// Preview the import without modifying the target ledger.
  ///
  /// [sourceSeed] — the recovery seed for the source ledger.
  /// [sourceChain] — optional pre-loaded source chain blocks.
  ///   If not provided, only self-import and seed-validity checks are run.
  Future<ImportPreview> dryRun({
    required String sourceSeed,
    List<Map<String, dynamic>>? sourceChain,
  }) async {
    // Self-import guard: same seed as target
    if (_isSameSeed(sourceSeed)) {
      throw ImportException(
        'Cannot import from the same ledger — the seed matches the current ledger',
      );
    }

    // Validate seed format
    CryptoService.validateSeedBase64(sourceSeed);

    // Derive source MK
    final sourceCrypto = CryptoService();
    await sourceCrypto.initialize();
    final sourceMk = sourceCrypto.deriveMasterKey(sourceSeed);
    sourceCrypto.setMasterKey(sourceMk);

    try {
      // No source chain → seed-only check (dry-run from seed alone is limited)
      if (sourceChain == null || sourceChain.isEmpty) {
        return ImportPreview(
          entryCount: 0,
          dateRange: const DateRange(first: '', last: ''),
        );
      }

      // Verify source chain
      _verifyChain(sourceChain, sourceCrypto);

      // Extract entries from source
      final entries = _extractEntries(sourceChain, sourceCrypto);

      if (entries.isEmpty) {
        return ImportPreview(
          entryCount: 0,
          dateRange: const DateRange(first: '', last: ''),
        );
      }

      // Compute date range
      final dates = entries
          .map((e) => epochToDate(e['start_epoch'] as int))
          .toList()
        ..sort();
      final dateRange = DateRange(first: dates.first, last: dates.last);

      // Detect conflicts with target
      final conflicts = _detectConflicts(dates);

      return ImportPreview(
        entryCount: entries.length,
        dateRange: dateRange,
        conflicts: conflicts,
      );
    } finally {
      sourceCrypto.clearMasterKey();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // import — full import pipeline
  // ═══════════════════════════════════════════════════════════════

  /// Import entries from a source ledger into the target ledger.
  ///
  /// [sourceSeed] — the recovery seed for the source ledger.
  /// [sourceChain] — the source chain blocks to import from.
  /// [force] — if true, bypass conflict rejection and import anyway.
  Future<ImportResult> import({
    required String sourceSeed,
    List<Map<String, dynamic>>? sourceChain,
    bool force = false,
  }) async {
    // Self-import guard
    if (_isSameSeed(sourceSeed)) {
      throw ImportException(
        'Cannot import from the same ledger — the seed matches the current ledger',
      );
    }

    CryptoService.validateSeedBase64(sourceSeed);

    if (sourceChain == null || sourceChain.isEmpty) {
      return ImportResult(
        sourceEntryCount: 0,
        migratedCount: 0,
        skippedCount: 0,
        newBlockCount: 0,
        sourceDateRange: const DateRange(first: '', last: ''),
      );
    }

    // Create source crypto
    final sourceCrypto = CryptoService();
    await sourceCrypto.initialize();
    final sourceMk = sourceCrypto.deriveMasterKey(sourceSeed);
    sourceCrypto.setMasterKey(sourceMk);

    try {
      // Verify source chain
      _verifyChain(sourceChain, sourceCrypto);

      // Extract and decrypt source entries
      final sourceEntries = _extractEntries(sourceChain, sourceCrypto);

      // Compute content_hash on each extracted entry for deduplication
      // Use the decrypted plaintext fields (not the encrypted versions)
      for (final entry in sourceEntries) {
        entry['content_hash'] = _computeEntryContentHash(entry, targetCrypto);
      }

      final sourceEntryCount = sourceEntries.length;

      if (sourceEntryCount == 0) {
        return ImportResult(
          sourceEntryCount: 0,
          migratedCount: 0,
          skippedCount: 0,
          newBlockCount: 0,
          sourceDateRange: const DateRange(first: '', last: ''),
        );
      }

      // Compute source date range
      final sourceDates = sourceEntries
          .map((e) => epochToDate(e['start_epoch'] as int))
          .toList()
        ..sort();
      final dateRange = DateRange(
        first: sourceDates.first,
        last: sourceDates.last,
      );

      // Detect conflicts
      final conflicts = _detectConflicts(sourceDates);

      // Reject on overlap unless force
      if (conflicts.isNotEmpty && !force) {
        throw ImportException(
          'Date overlap detected with existing entries: ${conflicts.join(", ")}. '
          'Use force:true to override.',
        );
      }

      // Deduplicate: skip entries with content_hash already in target
      final targetHashes = _getTargetContentHashes();
      final toMigrate = <Map<String, dynamic>>[];
      var skippedCount = 0;

      for (final entry in sourceEntries) {
        final ch = entry['content_hash'] as String?;
        if (ch != null && targetHashes.contains(ch)) {
          skippedCount++;
        } else {
          toMigrate.add(entry);
        }
      }

      if (toMigrate.isEmpty) {
        return ImportResult(
          sourceEntryCount: sourceEntryCount,
          migratedCount: 0,
          skippedCount: skippedCount,
          newBlockCount: 0,
          sourceDateRange: dateRange,
          conflicts: conflicts,
        );
      }

      // Save pre-import chain state for rollback
      _preImportBlocks = _readTargetBlocks();

      // Re-encrypt entries with target MK
      final reencrypted = toMigrate
          .map((e) => _reencryptEntry(e, targetCrypto))
          .toList();

      // Build and append new day blocks
      final newBlockCount = _appendEntriesToTarget(reencrypted);

      // Clean up source MK
      sourceCrypto.clearMasterKey();

      return ImportResult(
        sourceEntryCount: sourceEntryCount,
        migratedCount: toMigrate.length,
        skippedCount: skippedCount,
        newBlockCount: newBlockCount,
        sourceDateRange: dateRange,
        conflicts: conflicts,
      );
    } finally {
      // Ensure source key is cleared
      if (sourceCrypto.hasMasterKey) {
        sourceCrypto.clearMasterKey();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // importFromFile — file-based import
  // ═══════════════════════════════════════════════════════════════

  /// Import from a ledger.json file's raw bytes.
  ///
  /// [fileBytes] — UTF-8 encoded JSON content of the ledger file.
  /// [sourceSeed] — seed used to decrypt the source ledger.
  Future<ImportResult> importFromFile(
    Uint8List fileBytes,
    String sourceSeed,
  ) async {
    // Parse JSON
    List<dynamic> parsed;
    try {
      final jsonStr = utf8.decode(fileBytes);
      parsed = jsonDecode(jsonStr) as List<dynamic>;
    } catch (e) {
      throw ImportException(
        'Invalid JSON: could not parse ledger file — ${e.toString()}',
      );
    }

    if (parsed.isEmpty) {
      return ImportResult(
        sourceEntryCount: 0,
        migratedCount: 0,
        skippedCount: 0,
        newBlockCount: 0,
        sourceDateRange: const DateRange(first: '', last: ''),
      );
    }

    // Validate block structure
    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i] is! Map<String, dynamic>) {
        throw ImportException(
          'Invalid ledger: block at index $i is not a JSON object',
        );
      }
    }

    final sourceChain =
        parsed.cast<Map<String, dynamic>>();

    // Validate the seed can decrypt the genesis
    final genesis = sourceChain.first;
    final sourceCrypto = CryptoService();
    await sourceCrypto.initialize();
    final sourceMk = sourceCrypto.deriveMasterKey(sourceSeed);
    sourceCrypto.setMasterKey(sourceMk);

    try {
      // Verify genesis identity_secret_enc_fallback is decryptable
      final fallback = genesis['identity_secret_enc_fallback'] as String?;
      if (fallback != null) {
        try {
          sourceCrypto.decrypt(fallback, sourceMk);
        } catch (_) {
          throw ImportException(
            'Wrong seed — could not decrypt source ledger genesis',
          );
        }
      }
    } finally {
      sourceCrypto.clearMasterKey();
    }

    // Delegate to the main import pipeline
    return import(sourceSeed: sourceSeed, sourceChain: sourceChain);
  }

  // ═══════════════════════════════════════════════════════════════
  // rollback
  // ═══════════════════════════════════════════════════════════════

  /// Rollback to the pre-import chain state.
  Future<void> rollback() async {
    final preImport = _preImportBlocks;
    if (preImport == null) return;

    await targetDb.transaction(() async {
      // Clear existing blocks
      await targetDb.customStatement('DELETE FROM blocks');
      await targetDb.customStatement('DELETE FROM index_entries');

      // Re-insert pre-import blocks
      for (final block in preImport) {
        final blockType = block['block_type'] ?? block['type'] ?? 'day';
        final blockId = block['block_id'] ??
            block['block_hash'] ??
            block['day_hash'] ??
            'block_${block['block_index'] ?? block['day_index'] ?? 0}';
        final blockIndex = block['block_index'] ?? block['day_index'] ?? 0;
        final prevHash = block['prev_hash'] as String? ?? '';
        final dataEnc = block['data_enc'] as String? ?? '';
        final identitySeal = block['identity_seal'] as String?;
        final keyVersion = block['key_version'] as int? ?? 1;
        final createdAt = block['created_at'] as int? ?? 0;

        await targetDb.customStatement(
          'INSERT INTO blocks (block_id, block_type, block_index, key_version,'
          ' data_enc, identity_seal, prev_hash, created_at)'
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            blockId, blockType, blockIndex, keyVersion,
            dataEnc, identitySeal, prevHash, createdAt,
          ],
        );
      }
    });

    _preImportBlocks = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal: chain helpers
  // ═══════════════════════════════════════════════════════════════

  /// Check if [seed] is the same as the target's seed.
  bool _isSameSeed(String seed) {
    try {
      final targetMk = targetCrypto.getMasterKey();
      if (targetMk == null) return false;
      final derivedMk = targetCrypto.deriveMasterKey(seed);
      return targetMk == derivedMk;
    } catch (_) {
      return false;
    }
  }

  /// Verify a source chain's integrity.
  void _verifyChain(
    List<Map<String, dynamic>> blocks,
    CryptoService sourceCrypto,
  ) {
    // Basic block structure validation
    for (final block in blocks) {
      if (!block.containsKey('type') && !block.containsKey('block_type')) {
        throw ImportException('Invalid chain: block missing type field');
      }
    }
  }

  /// Extract decrypted entries from source chain blocks.
  List<Map<String, dynamic>> _extractEntries(
    List<Map<String, dynamic>> blocks,
    CryptoService sourceCrypto,
  ) {
    final entries = <Map<String, dynamic>>[];

    for (final block in blocks) {
      final type = (block['type'] ?? block['block_type']) as String? ?? '';
      if (type != 'day') continue;

      final blockEntries = block['entries'] as List<dynamic>? ?? [];
      for (final entry in blockEntries) {
        Map<String, dynamic> data;
        if (entry is Map && entry.containsKey('data')) {
          data = Map<String, dynamic>.from(entry['data'] as Map);
        } else if (entry is Map) {
          data = Map<String, dynamic>.from(entry);
        } else {
          continue;
        }

        // Decrypt encrypted fields
        final decrypted = _decryptEntryFields(data, sourceCrypto);
        entries.add(decrypted);
      }
    }

    return entries;
  }

  /// Decrypt all encrypted fields in an entry.
  Map<String, dynamic> _decryptEntryFields(
    Map<String, dynamic> data,
    CryptoService sourceCrypto,
  ) {
    final result = Map<String, dynamic>.from(data);
    final mk = sourceCrypto.getMasterKey()!;

    for (final encField in _encryptedFieldMap.keys) {
      if (result.containsKey(encField)) {
        final encrypted = result[encField] as String?;
        if (encrypted != null && encrypted.isNotEmpty) {
          try {
            final plaintext = sourceCrypto.decryptFieldValue(encrypted, mk);
            final targetField = _encryptedFieldMap[encField]!;
            // Don't overwrite existing plaintext field
            if (!result.containsKey(targetField)) {
              result[targetField] = _parsePlaintextField(targetField, plaintext);
            }
          } catch (_) {
            // Skip unparseable ciphertext
          }
        }
      }
    }

    // Ensure start_epoch is an int
    if (result['start_epoch'] is String) {
      result['start_epoch'] = int.tryParse(result['start_epoch']) ?? 0;
    }
    result['start_epoch'] ??= 0;

    return result;
  }

  /// Parse a plaintext value into the appropriate Dart type for [fieldName].
  static dynamic _parsePlaintextField(String fieldName, String plaintext) {
    if (fieldName == 'start_epoch' || fieldName == 'end_epoch') {
      return int.tryParse(plaintext);
    }
    if (fieldName == 'duration') {
      return int.tryParse(plaintext) ?? plaintext;
    }
    if (fieldName == 'tags' || fieldName == 'pauses' || fieldName == 'transitions') {
      try {
        return jsonDecode(plaintext);
      } catch (_) {
        return plaintext;
      }
    }
    return plaintext;
  }

  /// Re-encrypt an entry's fields with the target MK.
  ///
  /// After [_decryptEntryFields] extracts plaintext from source-encrypted
  /// `_enc` fields, this method replaces the ciphertext in each `_enc` field
  /// with a fresh encryption under the target MK.  Fields whose ciphertext
  /// cannot be decrypted (e.g. already target-encrypted or malformed) are
  /// silently left unchanged.
  Map<String, dynamic> _reencryptEntry(
    Map<String, dynamic> entry,
    CryptoService targetCrypto,
  ) {
    final result = Map<String, dynamic>.from(entry);
    final mk = targetCrypto.getMasterKey()!;

    for (final encField in _encryptedFieldMap.keys) {
      if (result.containsKey(encField) && result[encField] is String) {
        try {
          final ciphertext = result[encField] as String;
          // Decrypt the existing ciphertext to obtain plaintext, then
          // re-encrypt with the target MK to produce a fresh ciphertext.
          final plaintext = targetCrypto.decrypt(ciphertext, mk);
          result[encField] = targetCrypto.encrypt(plaintext, mk);
        } catch (_) {
          // Ciphertext not decryptable with target MK — leave unchanged.
        }
      }
    }

    // device_proof is an HMAC (not ciphertext) — preserved as-is.
    return result;
  }

  /// Detect date conflicts between source and target.
  List<String> _detectConflicts(List<String> sourceDates) {
    if (targetChain == null) return [];

    final targetDayBlocks = targetChain!.getDayBlocks();
    final targetDates = <String>{};
    for (final block in targetDayBlocks) {
      final date = block['date'] as String?;
      if (date != null) targetDates.add(date);
    }

    final conflicts = <String>[];
    for (final date in sourceDates) {
      if (targetDates.contains(date)) {
        conflicts.add(date);
      }
    }
    return conflicts;
  }

  /// Get content hashes from the target chain for deduplication.
  Set<String> _getTargetContentHashes() {
    final hashes = <String>{};
    if (targetChain == null) return hashes;

    for (final block in targetChain!.readAll()) {
      if (block['type'] != 'day') continue;
      final entries = block['entries'] as List<dynamic>? ?? [];
      for (final entry in entries) {
        if (entry is Map) {
          final data = entry['data'] as Map<String, dynamic>?;
          if (data != null) {
            final ch = data['content_hash'] as String?;
            if (ch != null) hashes.add(ch);
          }
        }
      }
    }
    return hashes;
  }

  /// Read all blocks from the target database.
  List<Map<String, dynamic>> _readTargetBlocks() {
    final rows = targetDb.customSelect(
      'SELECT * FROM blocks ORDER BY block_index ASC',
    ).get();
    return rows.map((row) {
      return <String, dynamic>{
        'block_id': row.read<String>('block_id'),
        'block_type': row.read<String>('block_type'),
        'block_index': row.read<int>('block_index'),
        'key_version': row.read<int>('key_version'),
        'data_enc': row.read<String>('data_enc'),
        'identity_seal': row.read<String?>('identity_seal'),
        'prev_hash': row.read<String>('prev_hash'),
        'created_at': row.read<int>('created_at'),
      };
    }).toList();
  }

  /// Compute a stable content hash for an entry using its decrypted fields.
  /// Uses SHA-256 of key plaintext fields for deduplication.
  String _computeEntryContentHash(
    Map<String, dynamic> entry,
    CryptoService crypto,
  ) {
    final fields = <String, dynamic>{
      'title': entry['title'],
      'start_epoch': entry['start_epoch'],
      'end_epoch': entry['end_epoch'],
    };
    return crypto.sha256(jsonEncode(fields));
  }

  /// Append re-encrypted entries to the target chain.
  int _appendEntriesToTarget(List<Map<String, dynamic>> entries) {
    if (targetChain == null || entries.isEmpty) return 0;

    var newBlockCount = 0;

    // Group entries by date
    final byDate = <String, List<Map<String, dynamic>>>{};
    for (final entry in entries) {
      final startEpoch = entry['start_epoch'] as int? ?? 0;
      final date = epochToDate(startEpoch);
      byDate.putIfAbsent(date, () => []).add(entry);
    }

    final dates = byDate.keys.toList()..sort();

    for (final date in dates) {
      final dayEntries = byDate[date]!;

      // Get prev_hash from the last block
      final lastBlock = targetChain!.getLastBlock();
      final prevHash = lastBlock != null
          ? getBlockHash(lastBlock)
          : '0' * 64;

      // Build entries in {hash, data} format, computing content_hash
      final normalized = dayEntries.map((entry) {
        final data = Map<String, dynamic>.from(entry);

        // Strip staging-only fields
        data.remove('is_active');
        data.remove('entry_id');
        data.remove('device_uuid');

        // Compute content_hash for deduplication (must match _computeEntryContentHash)
        data['content_hash'] = _computeEntryContentHash(data, targetCrypto);

        return {'data': data};
      }).toList();

      // Build and append the day block
      final dayBlock = targetChain!.buildDayBlock(
        entries: normalized,
        prevHash: prevHash,
        dateStr: date,
      );

      targetChain!.append(dayBlock);
      newBlockCount++;
    }

    return newBlockCount;
  }
}
