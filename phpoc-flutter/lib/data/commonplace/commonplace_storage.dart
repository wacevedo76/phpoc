import 'dart:convert';
import 'dart:io';

/// Separate-file persistence for the Commonplace chain (ADR-031).
///
/// Reads and writes a standalone `commonplace.json` export (default file name
/// per user spec). The store implements the same block-store contract the
/// ledger layer uses (`readBlocks`/`appendBlocks`/`truncate`/`getBlockCount`/
/// `getLastBlock`) so [CommonplaceChain] and [CommonplaceEngine] operate over
/// it directly.
///
/// On-disk content is the sealed chain — every Commonplace content field is
/// already encrypted at rest, so no plaintext title/entry/tags/ad-hoc reaches
/// the file (D2). Staging is never serialized (D11): only the genesis + sealed
/// day blocks are written.
///
/// The file path is decoupled from master-key derivation (ADR-031 §10): any
/// location stores the same chain, and the same seed → same MK unlocks it.
class CommonplaceStorage {
  final String filePath;
  final String masterKeyHex;

  Map<String, dynamic>? _genesis;
  final List<Map<String, dynamic>> _blocks = [];

  CommonplaceStorage({required this.filePath, required this.masterKeyHex});

  // ═══════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════

  /// Persist the current chain (genesis + day blocks) to [filePath].
  Future<void> save() async {
    final out = <String, dynamic>{
      'type': 'commonplace_chain',
      if (_genesis != null) 'genesis': _genesis,
      'blocks': _blocks,
    };
    await File(
      filePath,
    ).create(recursive: true).then((f) => f.writeAsString(jsonEncode(out)));
  }

  /// Load a `commonplace.json` into this store.
  ///
  /// A missing file leaves the store fresh (genesis-able). A corrupt file
  /// surfaces an error rather than crashing.
  Future<void> load() async {
    final f = File(filePath);
    if (!await f.exists()) {
      _genesis = null;
      _blocks.clear();
      return;
    }

    final raw = await f.readAsString();
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (e) {
      throw Exception('Corrupt commonplace.json: $e');
    }
    if (decoded is! Map<String, dynamic>) {
      throw Exception('Corrupt commonplace.json: expected a JSON object');
    }

    _blocks.clear();
    _genesis = null;

    final genesis = decoded['genesis'];
    if (genesis is Map<String, dynamic>) {
      _genesis = genesis;
      _blocks.add(genesis);
    }

    final blocks = decoded['blocks'];
    if (blocks is List) {
      for (final b in blocks) {
        if (b is Map<String, dynamic>) {
          final block = Map<String, dynamic>.from(b);
          // A genesis stored inside `blocks` (when present) is the same object
          // as `genesis`; keep it once. Day blocks are all non-genesis.
          if (block['type'] == 'commonplace_genesis' && _genesis != null) {
            continue;
          }
          _blocks.add(block);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Block-store contract
  // ═══════════════════════════════════════════════════════════════

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    if (e > _blocks.length) return List.from(_blocks.sublist(start));
    if (start > e) return <Map<String, dynamic>>[];
    return List.from(_blocks.sublist(start, e));
  }

  void appendBlocks(List<Map<String, dynamic>> blocks) {
    _blocks.addAll(blocks);
  }

  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = List<Map<String, dynamic>>.from(_blocks.sublist(keepCount));
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }

  int getBlockCount() => _blocks.length;

  /// Replace the ENTIRE chain (genesis slot + block list) from [rebuilt].
  ///
  /// Used by RekeyService to persist a re-encrypted Commonplace chain in place
  /// while keeping the on-disk `genesis`/`blocks` split consistent (a stale
  /// [genesis] would otherwise shadow the rebuilt genesis on [load]) (CPS-R).
  void replaceAll(List<Map<String, dynamic>> rebuilt) {
    _genesis = null;
    _blocks.clear();
    for (final b in rebuilt) {
      if (b['type'] == 'commonplace_genesis' && _genesis == null) {
        _genesis = b;
      }
      _blocks.add(b);
    }
  }

  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : Map<String, dynamic>.from(_blocks.last);

  /// Genesis block, or null if none built/loaded yet.
  Map<String, dynamic>? get genesis => _genesis;
}
