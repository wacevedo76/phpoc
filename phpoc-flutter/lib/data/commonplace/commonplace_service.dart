import 'dart:convert';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_storage.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show epochToDate;

/// Application-layer service for the Commonplace Book (ADR-031).
///
/// Mirrors `SyncService`'s relationship to the ledger engine: it owns a
/// block store (file-backed `[CommonplaceStorage]` or an in-memory fake) and
/// a `[CommonplaceEngine]`, and presents the UI with a small, stable surface —
/// read, add, verify, genesis bootstrap, and a decrypt-and-scan tag index.
///
/// Schely notes:
/// - Adding a passage is **add-not-in-place** (D5): `addEntry` always seals a
///   new committed entry; there is no in-place update of an existing passage.
/// - The Commonplace schema is `title` / `tags` / `entry` (the passage) with an
///   optional `ad_hoc` map — there is **no `comment` field** (ADR-031).
/// - Genesis is bootstrapped lazily by `ensureGenesis`, drawing the same
///   shared master key as the activity ledger (one seed → one MK → both books).
class CommonplaceService {
  /// File path pre-resolved in [main] before [runApp], used by
  /// [commonplaceServiceProvider] to decide a real `commonplace.json` store
  /// vs an in-memory fake (tests). Mirrors [AppDatabase.preResolvedPath].
  static String? preResolvedPath;

  final CryptoService crypto;
  final dynamic store;
  final String? identitySecret;

  late final CommonplaceEngine engine;

  CommonplaceService({
    required this.crypto,
    required this.store,
    this.identitySecret,
  }) {
    engine = CommonplaceEngine(
      crypto: crypto,
      store: store,
      identitySecret: identitySecret,
    );
  }

  /// True if the underlying block store already holds a genesis (or any block).
  bool get _hasChain => engine.getBlockCount() > 0;

  /// Bootstrap a fresh `commonplace.json` chain with a genesis block.
  ///
  /// No-op if a genesis already exists (guards against double-seeding across
  /// app restarts). Throws only if a genesis is genuinely absent and building
  /// one fails (e.g. no master key cached).
  Future<void> ensureGenesis({
    required String username,
    required String email,
    required String recoverySeedEnc,
    required String identityPubKey,
    required String identitySecretEncFallback,
  }) async {
    if (_hasChain) return;
    engine.buildGenesis(
      username: username,
      email: email,
      recoverySeedEnc: recoverySeedEnc,
      identityPubKey: identityPubKey,
      identitySecretEncFallback: identitySecretEncFallback,
    );
    await _persist();
  }

  /// Seal a single Commonplace passage as a new committed entry (append-only).
  ///
  /// Builds a raw entry dict (`timestamp_ms`, `date`, schema) and commits it
  /// to the sealed chain. Tags are normalized (trimmed + lower-cased) before
  /// sealing so the tag index and chips operate on consistent tokens.
  /// [adHoc], when present, is stored verbatim on the sealed entry and returns
  /// on read-back.
  Future<void> addEntry({
    required String title,
    required String entry,
    List<String> tags = const [],
    Map<String, dynamic>? adHoc,
  }) async {
    final ts = DateTime.now().millisecondsSinceEpoch;
    final normalizedTags = tags
        .map((t) => t.trim().toLowerCase())
        .where((t) => t.isNotEmpty)
        .toList();

    final rawEntry = <String, dynamic>{
      'type': 'commonplace',
      'timestamp_ms': ts,
      'date': epochToDate(ts),
      'title': title,
      'entry': entry,
      'tags': normalizedTags,
      if (adHoc != null && adHoc.isNotEmpty) 'ad_hoc': adHoc,
    };

    engine.commit([rawEntry]);
    await _persist();
  }

  /// All committed Commonplace entries, decrypted, in chain order.
  Future<List<Map<String, dynamic>>> readEntries() async {
    return engine.readEntries();
  }

  /// Verify the integrity of the entire Commonplace chain.
  bool verify() => engine.verify();

  /// The hex hash of the last block, or null if the chain is empty.
  String? getLastHash() {
    final last = engine.getLastBlock();
    if (last == null) return null;
    return engine.chain.getBlockHashFor(last);
  }

  /// Total number of Commonplace entries (committed passages).
  int getEntryCount() => engine.readEntries().length;

  /// Reset the entire Commonplace chain (remove every block), idempotently —
  /// safe when `commonplace.json` is absent/empty (CPS-C1/C2/ C5). Persists
  /// the emptied chain to the file-backed store so the reset survives restart.
  Future<void> clearAll() async {
    final count = engine.getBlockCount();
    if (count > 0) {
      engine.chain.truncate(count);
    }
    await _persist();
  }

  /// Atomically replace the entire Commonplace chain with [rebuilt] blocks
  /// (used by RekeyService to persist a re-encrypted chain under the new MK,
  /// CPS-R1..R7). For a file-backed store this rewrites both the genesis slot
  /// and the block list in memory then persists; for in-memory fakes it
  /// truncates and appends via the raw store — calling `appendBlocks`
  /// unconditionally so a store-level failure still surfaces (CPS-R6).
  Future<void> replaceChainWith(List<Map<String, dynamic>> rebuilt) async {
    final fileStore = store is CommonplaceStorage
        ? store as CommonplaceStorage
        : null;
    if (fileStore != null) {
      fileStore.replaceAll(rebuilt);
      await fileStore.save();
      return;
    }
    final existing = engine.getBlockCount();
    if (existing > 0) {
      engine.chain.truncate(existing);
    }
    // Direct store append — bypasses the chain's empty-list short-circuit so a
    // store failure (e.g. a throwing fake in tests) truly aborts the re-key.
    store.appendBlocks(rebuilt);
    await _persist();
  }

  /// Serialize the current Commonplace chain to the portable backup shape
  /// `{"type": "commonplace_chain", "genesis": …, "blocks": …}` — the same
  /// shape [CommonplaceStorage.save] produces (CPS-B2).
  String exportForBackup() {
    final all = engine.chain.readAll();
    Map<String, dynamic>? genesis;
    final blocks = <Map<String, dynamic>>[];
    for (final b in all) {
      if (b['type'] == 'commonplace_genesis' && genesis == null) {
        genesis = b;
      } else {
        blocks.add(b);
      }
    }
    return jsonEncode(<String, dynamic>{
      'type': 'commonplace_chain',
      'genesis': genesis,
      'blocks': blocks,
    });
  }

  /// Replace the current Commonplace chain from a [backup] produced by
  /// [exportForBackup] / [CommonplaceStorage.save] (CPS-B3/B4). Throws a
  /// [FormatException] unless the payload is a `commonplace_chain` object.
  Future<void> restoreFromBackup(String backup) async {
    final decoded = jsonDecode(backup);
    if (decoded is! Map<String, dynamic> ||
        decoded['type'] != 'commonplace_chain') {
      throw FormatException('Not a valid Commonplace backup');
    }
    final rebuilt = <Map<String, dynamic>>[];
    final genesis = decoded['genesis'];
    if (genesis is Map<String, dynamic>) rebuilt.add(genesis);
    final blocks = decoded['blocks'];
    if (blocks is List) {
      rebuilt.addAll(
        blocks.whereType<Map<String, dynamic>>().where(
          (b) => b['type'] != 'commonplace_genesis',
        ),
      );
    }
    await replaceChainWith(rebuilt);
  }

  /// Decrypt-and-scan tag index: `tag → entryCount` from committed entries.
  ///
  /// Not the deferred blind index — this scans and decrypts every committed
  /// entry (bounded by the book's size in this slice) to build the topic list.
  Map<String, int> buildTagIndex() {
    final index = <String, int>{};
    for (final entry in engine.readEntries()) {
      final tags = (entry['tags'] as List<dynamic>? ?? const [])
          .map((t) => t.toString())
          .toSet();
      if (tags.isEmpty) {
        index['untagged'] = (index['untagged'] ?? 0) + 1;
        continue;
      }
      for (final tag in tags) {
        index[tag] = (index[tag] ?? 0) + 1;
      }
    }
    return index;
  }

  // ═══════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════

  /// Persist the chain to the file-backed `[CommonplaceStorage]`, if present.
  ///
  /// `store` is `dynamic` because it is shared with the engine/chain, which
  /// accept either the real `[CommonplaceStorage]` or an in-memory test fake.
  /// Only the real file-backed store needs a `save()`; fakes hold state in
  /// memory and are already mutated by the engine.
  Future<void> _persist() async {
    final fileStore = store is CommonplaceStorage
        ? store as CommonplaceStorage
        : null;
    await fileStore?.save();
  }
}
