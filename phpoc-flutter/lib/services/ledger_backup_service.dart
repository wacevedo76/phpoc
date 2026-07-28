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

    // Validate all blocks before writing anything
    final blocks = <Block>[];
    for (var i = 0; i < parsed.length; i++) {
      final obj = parsed[i];
      if (obj is! Map<String, dynamic>) {
        throw FormatException('Block at index $i is not a JSON object');
      }
      blocks.add(_jsonToBlock(obj, i));
    }

    // In a transaction: clear existing blocks + index, insert new
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
      final entries = PhpSpecFormat.extractEntries(block.dataEnc);
      final identityData = _extractIdentityFromEntries(entries);
      if (identityData != null) {
        result[PhpSpecFormat.kIdentity] = identityData;
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
    final dayIndex = json[PhpSpecFormat.kDayIndex];
    if (dayIndex is! int) {
      throw FormatException(
          'Block at index $index: missing or invalid "day_index"');
    }

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

    // ── entries → data_enc (base64 JSON) ─────────────────────
    final entries = json[PhpSpecFormat.kEntries];
    final entriesList = (entries is List) ? entries : <dynamic>[];
    final entriesJson = jsonEncode(entriesList);
    final dataEnc = base64.encode(utf8.encode(entriesJson));

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
