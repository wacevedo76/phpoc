import 'dart:convert';

import '../models/block.dart';
import 'format_utils.dart';

/// PHPSPEC format constants and helpers.
///
/// Shared between [LedgerBackupService] and [LedgerPushService] to ensure
/// consistent serialization. Both services must produce identical PHPSPEC
/// JSON for the same block data.
///
/// When modifying serialization logic, update BOTH services and their tests.
class PhpSpecFormat {
  PhpSpecFormat._();

  // ── PHPSPEC field name constants (per PHPSPEC §4) ────────────

  static const kType = 'type';
  static const kDayIndex = 'day_index';
  static const kDate = 'date';
  static const kPrevHash = 'prev_hash';
  static const kEntries = 'entries';
  static const kSignature = 'signature';
  static const kIdentity = 'identity';
  static const kFormatVersion = 'format_version';
  static const kBlockHash = 'block_hash';
  static const kIdentitySeal = 'identity_seal';

  // ── PHPSPEC type strings ────────────────────────────────────

  static const typeGenesis = 'genesis';
  static const typeDay = 'day';
  static const typeYearSummary = 'year_summary';
  static const typeMonthSummary = 'month_summary';

  /// Map [BlockType] → PHPSPEC type string.
  static const blockTypeToPhpSpec = {
    BlockType.genesis: typeGenesis,
    BlockType.day: typeDay,
    BlockType.year: typeYearSummary,
    BlockType.month: typeMonthSummary,
  };

  /// Map PHPSPEC type string → [BlockType].
  static const phpSpecToBlockType = {
    typeGenesis: BlockType.genesis,
    typeDay: BlockType.day,
    typeYearSummary: BlockType.year,
    typeMonthSummary: BlockType.month,
  };

  /// Map PHPSPEC type string → seal field name.
  ///
  /// Genesis uses `block_hash` (I-17), matching both Python and Flutter
  /// chain implementations. The seal is computed over the block's data
  /// fields without `day_hash` or `date`, so using `day_hash` would
  /// break cross-client seal verification.
  static const sealFieldNames = {
    typeGenesis: 'block_hash',
    typeDay: 'day_hash',
    typeYearSummary: 'year_hash',
    typeMonthSummary: 'month_hash',
  };

  // ── Block serialization ─────────────────────────────────────

  /// Build the common PHPSPEC map for a [block].
  ///
  /// Returns a map with: type, day_index, prev_hash, entries,
  /// the type-appropriate seal field (= blockId), block_hash (= blockId),
  /// date (non-genesis only), and identity_seal (when non-null).
  ///
  /// Callers add genesis-specific fields (identity, format_version,
  /// signature) and choose their own JSON encoding strategy.
  static Map<String, dynamic> blockToMap(Block block) {
    final typeStr = blockTypeToPhpSpec[block.blockType] ?? block.blockType.name;
    final sealField = sealFieldNames[typeStr] ?? '${typeStr}_hash';
    final entries = extractEntries(block.dataEnc);

    final result = <String, dynamic>{
      kType: typeStr,
      kDayIndex: block.blockIndex,
      kPrevHash: block.prevHash,
      kEntries: entries,
      sealField: block.blockId,
    };

    // Only non-genesis blocks include date (genesis is sealed without it).
    if (block.blockType != BlockType.genesis) {
      result[kDate] = FormatUtils.epochToIsoDate(block.createdAt);
    }

    // Include block_hash as a convenience for consumers (same as seal field).
    result[kBlockHash] = block.blockId;

    // Preserve identity_seal as a separate field when present.
    if (block.identitySeal != null) {
      result[kIdentitySeal] = block.identitySeal;
    }

    return result;
  }

  // ── Entry extraction ────────────────────────────────────────

  /// Decode entries from a block's [dataEnc] field.
  ///
  /// Contract: dataEnc = base64(UTF8(JSON(chainBlockMap))) where
  /// chainBlockMap contains an 'entries' key. Also tolerates the
  /// legacy format where dataEnc decodes directly to a JSON list.
  ///
  /// Returns an empty list on any decode error.
  static List<dynamic> extractEntries(String dataEnc) {
    try {
      final decoded = utf8.decode(base64.decode(dataEnc));
      final parsed = jsonDecode(decoded);
      if (parsed is Map<String, dynamic>) {
        return (parsed['entries'] as List<dynamic>?) ?? [];
      } else if (parsed is List) {
        return parsed; // legacy: base64(UTF8(JSON([entries...])))
      }
    } catch (_) {
      // data_enc is opaque or malformed
    }
    return [];
  }
}
