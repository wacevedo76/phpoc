import 'dart:convert';

import '../core/crypto/crypto_service.dart';
import '../core/models/block.dart';
import '../data/ledger/chain.dart';
import '../data/ledger/helpers.dart' show computeEntryHash;
import '../data/storage/database.dart';

/// One-time chain migration: re-encrypt all entry field values with the
/// canonical PHPSPEC scheme (HMAC-derived sub-keys) so the ledger is
/// byte-identical across Python/WASM/Flutter clients.
///
/// ## What it does
///
/// 1. Reads every block from the database in order.
/// 2. For each entry in each day block: decrypts `startTime_enc`,
///    `endTime_enc`, `pauses_enc`, and other encrypted fields using
///    the current multi-scheme `decrypt()` (which already handles
///    canonical, Flutter, and legacy formats).
/// 3. Re-encrypts those fields with the canonical HMAC-derived
///    encrypt (matching Python `CryptoManager.encrypt` and WASM
///    `aes_ctr::encrypt`).
/// 4. Recomputes every block hash and identity seal so the chain
///    remains self-consistent.
/// 5. Writes the migrated chain back in a single transaction.
///
/// ## Safety
///
/// - Runs in a database transaction — any error rolls back to the
///   pre-migration state.
/// - Genesis block is untouched (it stores the encrypted seed, not
///   entry fields).
/// - Month/year summary blocks are recomputed but their entry lists
///   (aggregation results) are preserved as-is.
///
/// ## After migration
///
/// - New `encryptWithCachedKey()` calls produce canonical output.
/// - Export produces a PHPSPEC-format chain that Python & WASM
///   decrypt without any fallback paths.
/// - Push to R2 replaces the old chain — any client importing from
///   R2 gets the standardized chain.
class LedgerMigrationService {
  final AppDatabase db;
  final CryptoService crypto;

  LedgerMigrationService({required this.db, required this.crypto});

  /// Run the one-time encryption standardization migration.
  ///
  /// Returns the number of blocks migrated. Throws on failure (the
  /// transaction ensures no partial writes).
  Future<int> migrateChainEncryption() async {
    if (!crypto.hasMasterKey) {
      throw StateError(
        'Master key not cached. Call crypto.setMasterKey() before migration.',
      );
    }

    final rows = await db.blockDao.getAllBlocks();

    if (rows.isEmpty) return 0;

    final migrated = <Block>[];
    String? prevBlockHash;

    for (final block in rows) {
      // ── Genesis: pass through unchanged ──────────────────
      if (block.blockType == BlockType.genesis) {
        prevBlockHash = _extractHash(block);
        migrated.add(block);
        continue;
      }

      // ── Day / month / year: re-encrypt entries ───────────
      final data = _decodeBlockData(block.dataEnc);
      final migratedData = _migrateBlockData(data, block.blockType);

      // Ensure block-level fields match buildDayBlock output
      // (legacy entries-only blocks lack day_index, key_version, etc.)
      if (block.blockType == BlockType.day) {
        migratedData['day_index'] ??= block.blockIndex;
        migratedData['key_version'] ??= block.keyVersion;
        migratedData['type'] ??= 'day';
        if (!migratedData.containsKey('date')) {
          migratedData['date'] = _dateFromBlockIndex(block.blockIndex);
        }
      }

      // Set prev_hash
      if (prevBlockHash != null) {
        migratedData['prev_hash'] = prevBlockHash;
      }

      // Recompute block hash
      final hashKey = _hashKeyForType(block.blockType);
      final newHash = _computeBlockHash(migratedData, hashKey);
      migratedData[hashKey] = newHash;

      // Recompute identity seal
      String? identitySeal;
      try {
        final deviceSecret = crypto.getDeviceSecret(crypto.getMasterKey()!);
        identitySeal = crypto.sign(newHash, deviceSecret);
      } catch (_) {
        identitySeal = block.identitySeal;
      }

      // Encode back to base64
      final newDataEnc = base64.encode(utf8.encode(json.encode(migratedData)));

      migrated.add(Block(
        blockId: newHash,
        blockType: block.blockType,
        blockIndex: block.blockIndex,
        keyVersion: block.keyVersion,
        dataEnc: newDataEnc,
        identitySeal: identitySeal,
        prevHash: prevBlockHash ?? block.prevHash,
        createdAt: block.createdAt,
      ));

      prevBlockHash = newHash;
    }

    // ── Write in a transaction ─────────────────────────────
    await db.transaction(() async {
      db.blockDao.deleteAllBlocksSync();
      for (final block in migrated) {
        db.blockDao.insertBlockSync(block);
      }
    });

    return migrated.length;
  }

  // ── Internal helpers ─────────────────────────────────────

  /// Decode the base64-encoded block data JSON.
  ///
  /// Handles both normal block maps (`{"type":"day","entries":[...]}`)
  /// and legacy entries-only arrays (`[{...},{...}]` from Bug C).
  Map<String, dynamic> _decodeBlockData(String dataEnc) {
    try {
      final jsonStr = utf8.decode(base64.decode(dataEnc));
      final parsed = json.decode(jsonStr);
      if (parsed is List) {
        // Legacy entries-only format — wrap into a Map
        return _reconstructFromEntries(parsed);
      }
      return parsed as Map<String, dynamic>;
    } catch (e) {
      throw FormatException('Failed to decode block data: $e');
    }
  }

  /// Reconstruct block-level fields from a legacy entries-only array.
  Map<String, dynamic> _reconstructFromEntries(List<dynamic> entries) {
    // Derive date from earliest non-zero start_epoch
    String date = '1970-01-01';
    if (entries.isNotEmpty) {
      int? earliestEpoch;
      for (final entry in entries) {
        if (entry is Map) {
          final data = entry['data'] as Map?;
          if (data != null) {
            // Try encrypted field first, then plaintext fallback
            final enc = data['startTime_enc'] as String?;
            final pt = data['start_epoch'] as int?;
            int? epoch;
            if (enc != null && enc.isNotEmpty) {
              try {
                epoch = int.tryParse(crypto.decryptWithCachedKey(enc));
              } catch (_) {}
            }
            epoch ??= pt;
            if (epoch != null && epoch > 0) {
              earliestEpoch = earliestEpoch == null
                  ? epoch
                  : (epoch < earliestEpoch ? epoch : earliestEpoch);
            }
          }
        }
      }
      if (earliestEpoch != null && earliestEpoch > 0) {
        final dt = DateTime.fromMillisecondsSinceEpoch(earliestEpoch);
        date =
            '${dt.year.toString().padLeft(4, "0")}'
            '-${dt.month.toString().padLeft(2, "0")}'
            '-${dt.day.toString().padLeft(2, "0")}';
      }
    }

    return <String, dynamic>{
      'type': 'day',
      'date': date,
      'entries': entries,
    };
  }

  /// Re-encrypt encrypted fields in all entries of [data].
  Map<String, dynamic> _migrateBlockData(
    Map<String, dynamic> data,
    BlockType blockType,
  ) {
    final entries = data['entries'];
    if (entries is! List || entries.isEmpty) {
      return Map<String, dynamic>.from(data);
    }

    final migratedEntries = entries.map((entry) {
      if (entry is! Map) return entry;

      final entryData = entry['data'];
      if (entryData is! Map) return entry;

      final migratedEntryData =
          _migrateEntryData(Map<String, dynamic>.from(entryData));

      // Recompute entry hash from migrated data so hashes stay consistent
      // with the re-encrypted fields.
      final newHash = computeEntryHash(migratedEntryData);

      return {
        'hash': newHash,
        'data': migratedEntryData,
      };
    }).toList();

    final result = Map<String, dynamic>.from(data);
    result['entries'] = migratedEntries;
    return result;
  }

  /// Decrypt then re-encrypt all encrypted fields in a single
  /// entry's data dict.
  Map<String, dynamic> _migrateEntryData(Map<String, dynamic> data) {
    // Fields stored as encrypted hex blobs: decrypt → re-encrypt
    const encryptedFields = [
      'startTime_enc',
      'endTime_enc',
      'pauses_enc',
      'metadata_enc',
      'device_uuid_enc',
      'end_device_uuid_enc',
    ];

    for (final field in encryptedFields) {
      final value = data[field];
      if (value is String && value.isNotEmpty && !value.startsWith('plain:')) {
        try {
          final plaintext = crypto.decryptWithCachedKey(value);
          data[field] = crypto.encryptWithCachedKey(plaintext);
        } catch (_) {
          // If decryption fails, leave the field as-is
        }
      }
    }

    // Also handle per-field encryptable fields (title_enc, tags_enc, etc.)
    const perFieldEncrypted = [
      'title_enc',
      'tags_enc',
      'comment_enc',
      'duration_enc',
    ];

    for (final field in perFieldEncrypted) {
      final value = data[field];
      if (value is String && value.isNotEmpty && !value.startsWith('plain:')) {
        try {
          final plaintext = crypto.decryptWithCachedKey(value);
          data[field] = crypto.encryptWithCachedKey(plaintext);
        } catch (_) {
          // Leave as-is
        }
      }
    }

    return data;
  }

  /// Extract the block hash from a stored block.
  /// Falls back to DB blockId when data_enc is a legacy entries array.
  String _extractHash(Block block) {
    final data = _decodeBlockData(block.dataEnc);
    final hashKey = _hashKeyForType(block.blockType);
    return (data[hashKey] as String?) ?? block.blockId;
  }

  /// Determine the hash field name for a block type.
  String _hashKeyForType(BlockType type) {
    switch (type) {
      case BlockType.genesis:
        return 'block_hash';
      case BlockType.day:
        return 'day_hash';
      case BlockType.month:
        return 'month_hash';
      case BlockType.year:
        return 'year_hash';
    }
  }

  /// Compute a block hash for [data] excluding the hash and identity_seal keys.
  /// Uses JSON with sorted keys, matching [LedgerChain.computeSeal].
  String _computeBlockHash(Map<String, dynamic> data, String hashKey) {
    final sealData = <String, dynamic>{};
    for (final entry in data.entries) {
      if (entry.key != hashKey && entry.key != 'identity_seal') {
        sealData[entry.key] = entry.value;
      }
    }
    final sorted = _sortMap(sealData);
    final jsonStr = json.encode(sorted);
    // Use deriveSealKey → HMAC-SHA256, matching LedgerChain.computeSeal
    return crypto.seal(jsonStr, crypto.getMasterKey()!);
  }

  /// Recursively sort map keys for deterministic output.
  dynamic _sortMap(dynamic value) {
    if (value is Map) {
      final sorted = <String, dynamic>{};
      final keys = value.keys.cast<String>().toList()..sort();
      for (final key in keys) {
        sorted[key] = _sortMap(value[key]);
      }
      return sorted;
    } else if (value is List) {
      return value.map(_sortMap).toList();
    }
    return value;
  }

  /// Fallback date for blocks missing a date field.
  String _dateFromBlockIndex(int blockIndex) {
    // Approximate: day 1 = 2025-08-01, each index adds a day
    final base = DateTime(2025, 8, 1);
    final dt = base.add(Duration(days: blockIndex - 1));
    return '${dt.year.toString().padLeft(4, "0")}'
        '-${dt.month.toString().padLeft(2, "0")}'
        '-${dt.day.toString().padLeft(2, "0")}';
  }
}
