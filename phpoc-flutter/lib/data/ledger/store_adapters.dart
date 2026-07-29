import 'dart:convert';

import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show epochToDate;

/// Adapter that converts between chain-format block maps and [Block] database rows.
///
/// The chain stores/reads raw block maps (with `type`, `day_hash`, `entries`,
/// `date`, etc.) while the database stores [Block] rows (with `block_id`,
/// `block_type`, `data_enc`). This adapter marshals between the two formats:
///
/// - **Write:** Raw chain map → derived Block fields (blockId from the
///   block's hash field, blockType from type, blockIndex sequential)
///   + whole map serialized to data_enc JSON.
/// - **Read:** Block row → reconstruct chain map from data_enc JSON +
///   overlay DB-authoritative fields.
class LedgerBlockStore {
  final dynamic _dao;

  LedgerBlockStore(this._dao);

  // ── Write path (chain → DB) ────────────────────────────────

  void appendBlocks(List<Map<String, dynamic>> blocks) {
    var nextIndex = _dao.getBlockCountSync();
    for (final map in blocks) {
      final blockType = _deriveBlockType(map);
      final blockId = _deriveBlockId(map);
      _dao.insertBlockSync(Block(
        blockId: blockId,
        blockType: blockType,
        blockIndex: nextIndex++,
        keyVersion: map['key_version'] as int? ?? 1,
        dataEnc: base64.encode(utf8.encode(json.encode(map))),
        identitySeal: map['identity_seal'] as String?,
        prevHash: map['prev_hash'] as String? ?? '',
        createdAt: map['created_at'] as int? ??
            DateTime.now().millisecondsSinceEpoch,
      ));
    }
  }

  // ── Read path (DB → chain) ─────────────────────────────────

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final dynamic blocksRaw = _dao.getAllBlocksSync();
    final blocks = (blocksRaw as List<dynamic>).cast<Block>();
    final e = end ?? blocks.length;
    return blocks.sublist(start, e).map(_blockToMap).toList();
  }

  // ── Mutations ──────────────────────────────────────────────

  List<Map<String, dynamic>> truncate(int keepCount) {
    final dynamic allRaw = _dao.getAllBlocksSync();
    final all = (allRaw as List<dynamic>).cast<Block>();
    if (keepCount >= all.length) return [];
    final removed = all.sublist(keepCount);
    for (final b in removed) {
      _dao.deleteBlockSync(b.blockId);
    }
    return removed.map(_blockToMap).toList();
  }

  int getBlockCount() => _dao.getBlockCountSync();

  Map<String, dynamic>? getLastBlock() {
    final dynamic blockRaw = _dao.getLastBlockSync();
    final block = blockRaw as Block?;
    return block != null ? _blockToMap(block) : null;
  }

  // ── Field derivation (chain map → Block model) ─────────────

  /// Derive [BlockType] from chain map's `type` field.
  ///
  /// Maps snake_case JSON types to BlockType enum values.
  /// Unknown or missing types default to [BlockType.day].
  static const Map<String, BlockType> _typeMap = {
    'genesis': BlockType.genesis,
    'day': BlockType.day,
    'month_summary': BlockType.month,
    'year_summary': BlockType.year,
  };

  /// Reverse of [_typeMap]: [BlockType] → snake_case chain-format string.
  static String _blockTypeToChainType(BlockType bt) {
    switch (bt) {
      case BlockType.genesis:
        return 'genesis';
      case BlockType.day:
        return 'day';
      case BlockType.month:
        return 'month_summary';
      case BlockType.year:
        return 'year_summary';
    }
  }

  static BlockType _deriveBlockType(Map<String, dynamic> map) {
    final type = map['type'] as String?;
    if (type == null) return BlockType.day;
    return _typeMap[type] ?? BlockType.day;
  }

  /// Derive block ID from chain map's hash field.
  /// Genesis → block_hash, day → day_hash,
  /// year_summary → year_hash, month_summary → month_hash.
  static String _deriveBlockId(Map<String, dynamic> map) {
    final type = map['type'] as String?;
    switch (type) {
      case 'genesis':
        return map['block_hash'] as String? ?? '';
      case 'day':
        return map['day_hash'] as String? ?? '';
      case 'month_summary':
        return map['month_hash'] as String? ?? '';
      case 'year_summary':
        return map['year_hash'] as String? ?? '';
      default:
        return map['day_hash'] as String? ?? '';
    }
  }

  // ── Reconstruction (Block model → chain map) ───────────────

  /// Map [BlockType] → chain-format hash field name.
  static const Map<BlockType, String> _hashKeyByType = {
    BlockType.genesis: 'block_hash',
    BlockType.day: 'day_hash',
    BlockType.year: 'year_hash',
    BlockType.month: 'month_hash',
  };

  /// Reconstruct a chain-format map from a [Block] row.
  ///
  /// Decodes [dataEnc] (base64 → UTF-8 → JSON) as the base chain map,
  /// then overlays DB-authoritative fields. Handles three legacy bugs:
  ///
  /// **Bug A (genesis without type):** Onboarding stores genesis with
  /// data_enc `{"seed":"..."}` (no `type`). Type is inferred from
  /// [b.blockType] via [_blockTypeToChainType].
  ///
  /// **Bug B (legacy summary):** Blocks written with old [_deriveBlockType]
  /// have wrong [b.blockType] (day) and empty [b.blockId]. The correct type
  /// and hash fields survive in data_enc and are preserved here; the
  /// DB-overlay hash falls back to data_enc when [b.blockId] is empty.
  ///
  /// **Bug C (entries-only data_enc):** data_enc may store only the entries
  /// array `[{data, hash}, ...]` instead of a full block map. When decoded
  /// JSON is a List, date is reconstructed from earliest entry start_epoch.
  static Map<String, dynamic> _blockToMap(Block b) {
    Map<String, dynamic> map = _decodeBlockDataEnc(b.dataEnc);

    // Overlay DB-authoritative fields
    map['block_id'] = b.blockId;
    map['prev_hash'] = b.prevHash;
    map['key_version'] = b.keyVersion;
    map['identity_seal'] = b.identitySeal;
    map['block_index'] = b.blockIndex;

    // Type restoration: use data_enc's type when present, otherwise infer
    // from DB blockType (Bug A fix: genesis stored without type field).
    if (!map.containsKey('type') || map['type'] == null) {
      map['type'] = _blockTypeToChainType(b.blockType);
    }

    // Overlay type-specific hash key so getBlockHash() can resolve
    // from the DB-authoritative blockId (fixes summary block lookup).
    _overlayHashFields(map, b);

    return map;
  }

  /// Decode [dataEnc] into a chain-format map, handling both normal blocks
  /// and Bug C (entries-only array).
  static Map<String, dynamic> _decodeBlockDataEnc(String dataEnc) {
    // data_enc contract: base64(UTF8(JSON(payload)))
    // Also tolerates legacy plain-JSON blocks (written before fix).
    try {
      final decoded = utf8.decode(base64.decode(dataEnc));
      return _decodeDataEnc(decoded);
    } catch (_) {
      // Fallback: legacy plain-JSON format
      try {
        return _decodeDataEnc(dataEnc);
      } catch (_) {
        return <String, dynamic>{};
      }
    }
  }

  /// Overlay DB-authoritative hash and index fields on [map] from [b].
  static void _overlayHashFields(Map<String, dynamic> map, Block b) {
    final hashKey = _hashKeyByType[b.blockType];
    if (hashKey != null) {
      map[hashKey] = b.blockId;
    }
    if (b.blockType == BlockType.day) {
      map['day_index'] = b.blockIndex;
    }
  }

  /// Decode a raw JSON string and return a chain-format map.
  ///
  /// If the decoded JSON is a List (entries-only format from legacy
  /// storage — Bug C), reconstructs `date` from the earliest entry's
  /// start_epoch and sets `entries` to the decoded list.
  static Map<String, dynamic> _decodeDataEnc(String raw) {
    final dynamic parsed = json.decode(raw);
    if (parsed is List) {
      return _reconstructFromEntries(parsed);
    }
    return parsed as Map<String, dynamic>;
  }

  /// Reconstruct block-level fields from an entries array.
  ///
  /// - `date`: derived from earliest non-zero start_epoch in entries;
  ///   falls back to '1970-01-01' (sentinel) when no entries have epoch.
  /// - `entries`: the decoded entries list cast to Map.
  static Map<String, dynamic> _reconstructFromEntries(List<dynamic> entries) {
    String date = '1970-01-01';
    if (entries.isNotEmpty) {
      int? earliestEpoch;
      for (final entry in entries) {
        if (entry is Map) {
          final data = entry['data'];
          if (data is Map) {
            final epoch = data['start_epoch'];
            if (epoch is int && epoch > 0) {
              if (earliestEpoch == null || epoch < earliestEpoch) {
                earliestEpoch = epoch;
              }
            }
          }
        }
      }
      if (earliestEpoch != null) {
        date = epochToDate(earliestEpoch);
      }
    }
    return <String, dynamic>{
      'entries': entries.cast<Map<String, dynamic>>(),
      'date': date,
    };
  }
}

/// Adapter for [IndexManager]'s duck-typed API: readIndex() / writeIndex().
class LedgerIndexStore {
  Map<String, dynamic>? _data;

  Map<String, dynamic>? readIndex() => _data;

  void writeIndex(Map<String, dynamic>? data) => _data = data;
}
