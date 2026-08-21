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
  static const kMonth = 'month';
  static const kYear = 'year';
  static const kKeyVersion = 'key_version';
  static const kOriginalHash = 'original_hash';

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

    // Decode the data_enc chain map to recover the faithful `date` and
    // summary identity (`month`/`year`) that were sealed. Storing the full
    // block map in data_enc (see LedgerBackupService._phpSpecToBlock) makes
    // export -> import lossless so an on-device verify() stays GREEN.
    final encodedMap = _decodeDataEncMap(block.dataEnc);

    // Use the DB-authoritative block.blockId for the seal field value,
    // falling back to the dataEnc-embedded hash only when the DB column
    // is empty (E6: blockId wins over any stale seal hash in data_enc).
    final sealValue = block.blockId;

    // Prefer the sealed `day_index` carried in the full block map over the
    // DB array-position `block.blockIndex`. They diverge for day blocks once
    // month/year summary blocks interleave (a day's true sequence can differ
    // from its array index). Emitting the array index would re-write a block
    // with a day_index its `day_hash` was never sealed over, so a downstream
    // pull -> verify() fails the block seal. Fall back to blockIndex only for
    // legacy entries-only data_enc that carries no day_index (mirrors the
    // `date` handling below).
    final sealedDayIndex = encodedMap[kDayIndex];
    final dayIndex = sealedDayIndex is int ? sealedDayIndex : block.blockIndex;

    // `date` is carried from the sealed map when present (genesis is sealed
    // without date on the Flutter side, so it emits none), falling back to
    // the DB createdAt for legacy entries-only data_enc. Must be placed
    // before prev_hash so key order matches the seal payload.
    final result = <String, dynamic>{
      kType: typeStr,
      kDayIndex: dayIndex,
      kPrevHash: block.prevHash,
      kEntries: entries,
      sealField: sealValue,
    };
    final sealedDate = encodedMap[kDate];
    if (sealedDate is String && sealedDate.isNotEmpty) {
      result[kDate] = sealedDate;
    } else if (typeStr != typeGenesis) {
      result[kDate] = FormatUtils.epochToIsoDate(block.createdAt);
    }
    // Canonical summaries carry their calendar identity (ADR-029a); carry
    // it through export so import can restore it losslessly.
    for (final identityKey in const [kMonth, kYear]) {
      if (encodedMap.containsKey(identityKey)) {
        result[identityKey] = encodedMap[identityKey];
      }
    }
    // original_hash is part of the ADR-029a per-type seal set (sealed when
    // present on migrated blocks). Carry it through export so re-import is
    // lossless and on-device verify() recomputes the same seal input as
    // Python/Web over the whitelist.
    if (encodedMap.containsKey(kOriginalHash)) {
      result[kOriginalHash] = encodedMap[kOriginalHash];
    }

    // Include block_hash as a convenience for consumers (same as seal field).
    result[kBlockHash] = sealValue;

    // Preserve identity_seal as a separate field when present.
    if (block.identitySeal != null) {
      result[kIdentitySeal] = block.identitySeal;
    }

    return result;
  }

  /// Decode [dataEnc] into a map if it holds a full block map; otherwise
  /// return an empty map (legacy entries-only or opaque payloads).
  static Map<String, dynamic> _decodeDataEncMap(String dataEnc) {
    try {
      final decoded = utf8.decode(base64.decode(dataEnc));
      final parsed = jsonDecode(decoded);
      if (parsed is Map<String, dynamic>) {
        return parsed;
      }
    } catch (_) {
      // data_enc is opaque or malformed
    }
    return <String, dynamic>{};
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

  /// Extract the seal hash from a block's [dataEnc] field.
  ///
  /// Returns the type-appropriate hash (block_hash, day_hash, etc.)
  /// or null if dataEnc cannot be decoded.
  static String? extractHash(String dataEnc, String typeStr) {
    try {
      final decoded = utf8.decode(base64.decode(dataEnc));
      final parsed = jsonDecode(decoded);
      if (parsed is Map<String, dynamic>) {
        final sealField = sealFieldNames[typeStr] ?? '${typeStr}_hash';
        return parsed[sealField] as String?;
      }
    } catch (_) {
      // data_enc is opaque or malformed
    }
    return null;
  }
}
