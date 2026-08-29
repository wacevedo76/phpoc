import 'dart:convert';

import '../core/models/block.dart';
import '../core/utils/phpsec_format.dart';
import '../data/storage/database.dart';

/// Ledger backup service — export/import the full ledger chain in PHPSPEC format.
///
/// **PHPSPEC is the canonical format** (per PHPSPEC §4). Export emits PHPSPEC
/// block objects. Import accepts PHPSPEC format and converts to the internal
/// [Block] model for database storage.
///
/// Export: reads all blocks from the database, converts to PHPSPEC format
/// (decrypting `data_enc` to extract the `entries` array when possible).
///
/// Import: parses a PHPSPEC JSON array of blocks, maps field names to the
/// internal model, and rebuilds the `blocks` table in a transaction. Index
/// entries are cleared during import.
class LedgerBackupService {
  final AppDatabase db;

  LedgerBackupService({required this.db});

  // ═════════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════════

  /// Export all blocks to a PHPSPEC-format JSON string.
  ///
  /// Returns a JSON array of PHPSPEC block objects ordered by
  /// [Block.blockIndex]. An empty database returns `"[]"`.
  Future<String> exportToJson() async {
    final blocks = await db.blockDao.getAllBlocks();
    final list = blocks.map(_blockToPhpSpec).toList();
    return const JsonEncoder.withIndent('  ').convert(list);
  }

  /// Import blocks from a PHPSPEC-format JSON string, replacing the
  /// current ledger.
  ///
  /// Accepts PHPSPEC format (§4): `type`, `day_index`, `date`, `entries`,
  /// `prev_hash`, `{type}_hash`, `signature` (optional), `identity`
  /// (genesis), `format_version` (genesis).
  ///
  /// Also accepts the legacy internal format for backward compatibility:
  /// `block_id`, `block_type`, `block_index`, `data_enc`, `identity_seal`,
  /// `prev_hash`, `created_at`, `key_version`.
  ///
  /// Validates JSON structure and required fields before any writes.
  /// Runs in a transaction — failure rolls back entirely.
  ///
  /// Throws [FormatException] if [json] is malformed or any block has
  /// missing/invalid fields.
  Future<void> importFromJson(String json) async {
    final List<dynamic> parsed;
    try {
      parsed = jsonDecode(json) as List<dynamic>;
    } catch (e) {
      throw const FormatException('Invalid JSON: expected a JSON array');
    }

    // No-op on empty imports — importing zero blocks would wipe the ledger,
    // so leave any existing data untouched rather than replacing it with
    // nothing (B1 contract: importing `[]` is a safe no-op).
    if (parsed.isEmpty) {
      return;
    }

    // Validate all blocks before writing anything
    final blocks = <Block>[];
    for (var i = 0; i < parsed.length; i++) {
      final obj = parsed[i];
      if (obj is! Map<String, dynamic>) {
        throw FormatException('Block at index $i is not a JSON object');
      }
      blocks.add(_jsonToBlock(obj, i));
    }

    // In a transaction: clear existing blocks + index, insert new.
    // The transaction ensures atomicity — if any insert fails, the
    // deletes roll back, so existing blocks are preserved.
    await db.transaction(() async {
      await db.customStatement('DELETE FROM index_entries');
      await db.customStatement('DELETE FROM blocks');
      for (final block in blocks) {
        await db.blockDao.insertBlock(block);
      }
    });
  }

  // ═════════════════════════════════════════════════════════════
  // PHPSPEC export: internal Block → PHPSPEC map
  // ═════════════════════════════════════════════════════════════

  Map<String, dynamic> _blockToPhpSpec(Block block) {
    final result = PhpSpecFormat.blockToMap(block);

    // Genesis-specific fields
    if (block.blockType == BlockType.genesis) {
      // Prefer the nested identity carried in data_enc (canonical web-shaped
      // genesis). Only fall back to the legacy entries-embedded identity when
      // the canonical nested object is absent.
      if (!result.containsKey(PhpSpecFormat.kIdentity)) {
        final entries = PhpSpecFormat.extractEntries(block.dataEnc);
        final identityData = _extractIdentityFromEntries(entries);
        if (identityData != null) {
          result[PhpSpecFormat.kIdentity] = identityData;
        }
      }
      result[PhpSpecFormat.kFormatVersion] = '0.4.0';
    }

    return result;
  }

  // ═════════════════════════════════════════════════════════════
  // PHPSPEC import: JSON map → internal Block
  // ═════════════════════════════════════════════════════════════

  Block _jsonToBlock(Map<String, dynamic> json, int index) {
    // Detect format: PHPSPEC uses "type", legacy uses "block_type"
    if (json.containsKey(PhpSpecFormat.kType)) {
      return _phpSpecToBlock(json, index);
    }
    if (json.containsKey('block_type')) {
      return _legacyToBlock(json, index);
    }
    throw FormatException(
        'Block at index $index: unrecognized format — '
        'expected PHPSPEC ("type") or legacy ("block_type") field');
  }

  /// Parse PHPSPEC-format block JSON into internal [Block] model.
  Block _phpSpecToBlock(Map<String, dynamic> json, int index) {
    // ── type → blockType ─────────────────────────────────────
    final typeStr = json[PhpSpecFormat.kType];
    if (typeStr is! String) {
      throw FormatException(
          'Block at index $index: missing or invalid "type"');
    }
    final blockType = PhpSpecFormat.phpSpecToBlockType[typeStr];
    if (blockType == null) {
      throw FormatException(
          'Block at index $index: unknown type "$typeStr"');
    }

    // ── day_index → blockIndex ───────────────────────────────
    // Summary blocks (month_summary, year_summary) omit day_index
    // — they use month/year fields instead. Also, day_index values
    // from day blocks may collide with array positions of summary
    // blocks (e.g., month_summary at index 2 then day with day_index=2).
    // Use the array index (chain ordinal) for ALL blocks to guarantee
    // a unique blocks.block_index (SQLite UNIQUE constraint) and preserve
    // chain order. day_index is preserved inside data_enc only.
    final dayIndex = index;

    // ── prev_hash → prevHash ─────────────────────────────────
    final prevHash = json[PhpSpecFormat.kPrevHash];
    if (prevHash is! String) {
      throw FormatException(
          'Block at index $index: missing or invalid "prev_hash"');
    }

    // ── {type}_hash → blockId (the block's seal hash) ────────
    // block_hash is the explicit convenience field; fall back to
    // the type-specific seal field (day_hash, year_hash, etc.).
    final sealField =
        PhpSpecFormat.sealFieldNames[typeStr] ?? '${typeStr}_hash';
    final sealValue = json[sealField] as String?;
    final blockHash = json[PhpSpecFormat.kBlockHash] as String?;
    final blockId = blockHash ?? sealValue ?? 'block_$index';

    // ── identity_seal → identitySeal ─────────────────────────
    // Explicit field (present on genesis blocks). Falls back to
    // the seal field for backward compatibility with pre-fix exports
    // where identity_seal was incorrectly stored in the seal field.
    final identitySeal =
        (json['identity_seal'] ?? sealValue) as String?;

    // ── date → createdAt (epoch seconds) ─────────────────────
    final dateStr = json[PhpSpecFormat.kDate];
    final createdAt = dateStr is String
        ? _isoDateToEpoch(dateStr, index)
        : 0;

    // ── full canonical block map → data_enc (base64 JSON) ───
    // Persist the WHOLE canonical map so `_blockToMap` can faithfully
    // reconstruct the chain for `verify()`. See [_serializeCanonicalMap].
    final dataEnc = _serializeCanonicalMap(
      type: typeStr,
      prevHash: prevHash,
      blockId: blockId,
      sealField: sealField,
      source: json,
    );

    return Block(
      blockId: blockId,
      blockType: blockType,
      blockIndex: dayIndex,
      keyVersion: 1,
      dataEnc: dataEnc,
      identitySeal: identitySeal,
      prevHash: prevHash,
      createdAt: createdAt,
    );
  }

  /// Serialize the canonical map into a `data_enc` payload.
  ///
  /// Encodes the full block map (type, prev_hash, seal fields, identity,
  /// and any of day_index/date/month/year/entries present in [source]) so
  /// `LedgerBlockStore._blockToMap` can reconstruct `date`, `month`/`year`,
  /// and resolvable seals for `verify()`. Only fields present in [source]
  /// are carried: a genesis has no sealed `date`, and summaries carry
  /// `month`/`year` instead of `day_index`. Legacy entries-only `data_enc`
  /// (Bug C) is still handled as a read fallback in `store_adapters.dart`.
  String _serializeCanonicalMap({
    required String type,
    required String prevHash,
    required String blockId,
    required String sealField,
    required Map<String, dynamic> source,
  }) {
    final blockMap = <String, dynamic>{
      PhpSpecFormat.kType: type,
      PhpSpecFormat.kPrevHash: prevHash,
      PhpSpecFormat.kBlockHash: blockId,
      PhpSpecFormat.kKeyVersion: 1,
      sealField: blockId,
    };
    for (final field in const [
      PhpSpecFormat.kDayIndex,
      PhpSpecFormat.kDate,
      PhpSpecFormat.kMonth,
      PhpSpecFormat.kYear,
      PhpSpecFormat.kIdentitySeal,
      PhpSpecFormat.kEntries,
      // Nested genesis `identity` must survive the data_enc round-trip or the
      // exported/verified genesis loses identity.{recovery_seed_enc,
      // identity_pub_key, identity_secret_enc_fallback} (R1 cross-client
      // parity — Web verifies the Flutter wire genesis against this object).
      PhpSpecFormat.kIdentity,
      // original_hash is part of the ADR-029a per-type seal set (sealed when
      // present on migrated blocks). It must survive the data_enc round-trip
      // or _blockToMap reconstructs the chain WITHOUT it and the sealer
      // recomputes a different hash than Python/Web over the same block.
      PhpSpecFormat.kOriginalHash,
    ]) {
      if (source.containsKey(field)) {
        blockMap[field] = source[field];
      }
    }
    return base64.encode(utf8.encode(jsonEncode(blockMap)));
  }

  /// Parse legacy-format block JSON into internal [Block] model.
  /// Maintained for backward compatibility with pre-PHPSPEC exports.
  Block _legacyToBlock(Map<String, dynamic> json, int index) {
    final blockId = json['block_id'];
    if (blockId is! String || blockId.isEmpty) {
      throw FormatException(
          'Block at index $index: missing or invalid "block_id"');
    }

    final blockTypeStr = json['block_type'];
    if (blockTypeStr is! String) {
      throw FormatException(
          'Block at index $index: missing or invalid "block_type"');
    }
    final blockType = BlockType.values.asNameMap()[blockTypeStr];
    if (blockType == null) {
      throw FormatException(
          'Block at index $index: unknown block_type "$blockTypeStr"');
    }

    final blockIndex = json['block_index'];
    if (blockIndex is! int) {
      throw FormatException(
          'Block at index $index: missing or invalid "block_index"');
    }

    final dataEnc = json['data_enc'];
    if (dataEnc is! String) {
      throw FormatException(
          'Block at index $index: missing or invalid "data_enc"');
    }

    final prevHash = json['prev_hash'];
    if (prevHash is! String) {
      throw FormatException(
          'Block at index $index: missing or invalid "prev_hash"');
    }

    final keyVersion = json['key_version'] as int? ?? 1;
    final identitySeal = json['identity_seal'] as String?;
    final createdAt = json['created_at'] as int? ?? 0;

    return Block(
      blockId: blockId,
      blockType: blockType,
      blockIndex: blockIndex,
      keyVersion: keyVersion,
      dataEnc: dataEnc,
      identitySeal: identitySeal,
      prevHash: prevHash,
      createdAt: createdAt,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // Helpers
  // ═════════════════════════════════════════════════════════════

  /// Convert ISO date string (YYYY-MM-DD) to epoch seconds.
  /// Returns 0 and throws [FormatException] on invalid dates.
  int _isoDateToEpoch(String dateStr, int blockIndex) {
    try {
      final parts = dateStr.split('-');
      if (parts.length != 3) throw const FormatException('bad date format');
      final year = int.parse(parts[0]);
      final month = int.parse(parts[1]);
      final day = int.parse(parts[2]);
      final dt = DateTime.utc(year, month, day);
      return dt.millisecondsSinceEpoch ~/ 1000;
    } catch (e) {
      throw FormatException(
          'Block at index $blockIndex: invalid date "$dateStr"');
    }
  }

  /// Try to extract identity data from genesis entries.
  ///
  /// In PHPSPEC format, identity is a top-level field on the Genesis block.
  /// This helper handles the case where identity data was embedded in entries.
  Map<String, dynamic>? _extractIdentityFromEntries(List<dynamic> entries) {
    for (final entry in entries) {
      if (entry is Map<String, dynamic>) {
        final data = entry['data'];
        if (data is Map<String, dynamic> && data.containsKey('username')) {
          return data;
        }
      }
    }
    return null;
  }
}
