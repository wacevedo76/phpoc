import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show
        computeEntryHash,
        computeContentHash,
        verifyEntryHashTwoWay,
        verifyContentHash,
        compareVersions,
        secretToHex;
import 'package:phpoc_flutter/data/ledger/sealable_chain.dart';
import 'package:phpoc_flutter/data/ledger/chain_reconcile.dart';
import 'dart:convert';

/// The Commonplace chain — a separate, sealed append-only chain (ADR-031).
///
/// Holds its own `commonplace.json` sequence: a `commonplace_genesis` block
/// followed by `commonplace` day blocks. It shares the same Master Key as the
/// activity ledger (same seed → same MK) but is a structurally independent
/// chain with its own genesis, entry schema (`title`/`tags`/`entry`, optional
/// `ad_hoc`), and history — never mixing with the activity ledger (D7).
///
/// Mirrors `LedgerChain` (Axiom B5) so cross-client parity stays cheap.
class CommonplaceChain with SealableChain {
  @override
  final CryptoService crypto;
  final dynamic store;
  final String? identitySecret;
  final String? _identitySecretHex;

  CommonplaceChain({
    required this.crypto,
    required this.store,
    this.identitySecret,
  }) : _identitySecretHex = secretToHex(identitySecret);

  /// Hex identity secret for SealableChain / identity-signing parity.
  @override
  String? get identitySecretHex => _identitySecretHex;

  /// Canonical per-type seal-field whitelist (ADR-029a) for Commonplace blocks.
  @override
  final Map<String, List<String>> sealFieldsByType = {
    'commonplace_genesis': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
    'commonplace': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
  };

  /// The value key that holds a Commonplace block's own seal.
  @override
  String? hashKeyFor(String? type) {
    switch (type) {
      case 'commonplace_genesis':
        return 'block_hash';
      case 'commonplace':
        return 'day_hash';
      default:
        return null;
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // Block Building
  // ═══════════════════════════════════════════════════════════════

  /// Build and APPEND the Commonplace genesis block.
  ///
  /// Unlike `LedgerChain.buildGenesisBlock` (which only returns the block),
  /// the Commonplace genesis is appended immediately so a freshly created
  /// chain is immediately verifiable and day blocks can link onto it.
  ///
  /// Throws if the chain already has blocks.
  Map<String, dynamic> buildGenesis({
    required String username,
    required String email,
    required String recoverySeedEnc,
    required String identityPubKey,
    required String identitySecretEncFallback,
    String formatVersion = '0.4.0',
  }) {
    if (getBlockCount() > 0) {
      throw Exception(
          'Commonplace chain already has blocks — cannot create genesis');
    }

    final gen = <String, dynamic>{
      'type': 'commonplace_genesis',
      'day_index': 0,
      'prev_hash': '0' * 64,
      'entries': <Map<String, dynamic>>[],
      'format_version': formatVersion,
      'key_version': 1,
      'username': username,
      'email': email,
      'recovery_seed_enc': recoverySeedEnc,
      'identity_pub_key': identityPubKey,
      'identity_secret_enc_fallback': identitySecretEncFallback,
    };

    // Compute block_hash: seal over the canonical genesis fields.
    final blockHash = sealBlock(gen);
    gen['block_hash'] = blockHash;

    // Identity seal over block_hash (optional signing parity with ledger).
    if (_identitySecretHex != null) {
      gen['identity_seal'] = crypto.sign(blockHash, _identitySecretHex);
    }

    store.appendBlocks([gen]);
    return gen;
  }

  /// Build a Commonplace day block (does NOT append unless caller appends).
  ///
  /// [entries] may contain pre-hashed `{hash, data}` maps or raw dicts. Raw
  /// Commonplace entries (schema `{title, tags, entry[, ad_hoc], timestamp_ms}`)
  /// are encrypted here — `title`/`entry`/`tags`/`ad_hoc` become `_enc` fields
  /// so nothing is plaintext at rest (D2) — and their content hashes are
  /// computed over the encrypted data. Already-encrypted `{hash, data}` maps
  /// pass through with content hashes recomputed. The block carries
  /// type=commonplace.
  Map<String, dynamic> buildDayBlock({
    required List<dynamic> entries,
    required String prevHash,
    required String dateStr,
    int? keyVersion,
  }) {
    final existingDays = countDayBlocks();
    final dayIndex = existingDays == 0 ? 1 : existingDays + 1;
    final kv = keyVersion ?? 1;

    // Normalize entries: encrypt raw fields, strip staging-only fields, and
    // always recompute content + entry hashes from data.
    final normalizedEntries = <Map<String, dynamic>>[];
    for (final entry in entries) {
      Map<String, dynamic> data;
      bool alreadySealed = false;
      if (entry is Map && entry.containsKey('data')) {
        data = Map<String, dynamic>.from(entry['data'] as Map);
        alreadySealed = true;
      } else {
        data = Map<String, dynamic>.from(entry as Map);
      }

      // Strip staging-only fields.
      data.remove('is_active');
      data.remove('unsealed');
      data.remove('entry_id');
      data.remove('device_uuid');
      data.remove('hash');

      if (!alreadySealed) {
        data = _encryptCommonplaceEntry(data, dateStr: dateStr);
      }

      // Compute & record the content hash over the encrypted entry data.
      data['content_hash'] = computeContentHash(data, crypto);

      final computedHash = computeEntryHash(data);
      normalizedEntries.add({
        'hash': computedHash,
        'data': data,
      });
    }

    final block = <String, dynamic>{
      'type': 'commonplace',
      'date': dateStr,
      'day_index': dayIndex,
      'prev_hash': prevHash,
      'entries': normalizedEntries,
      'key_version': kv,
    };

    final dayHash = sealBlock(block);
    block['day_hash'] = dayHash;

    if (_identitySecretHex != null) {
      block['identity_seal'] = crypto.sign(dayHash, _identitySecretHex);
    }

    return block;
  }

  // ═══════════════════════════════════════════════════════════════
  // Mutations
  // ═══════════════════════════════════════════════════════════════

  /// Append a single Commonplace block, verifying prev_hash linkage.
  ///
  /// Rejects blocks whose type is not `commonplace` or `commonplace_genesis`
  /// (the activity logger's block types must not leak into this chain,
  /// ADR-029a per-type whitelist).
  void append(Map<String, dynamic> block) {
    _assertAllowedType(block);
    final last = getLastBlock();
    if (last != null) {
      final expectedPrev = getBlockHashFor(last);
      final actualPrev = block['prev_hash'] as String? ?? '';
      if (expectedPrev.isNotEmpty && actualPrev != expectedPrev) {
        throw Exception(
          'prev_hash mismatch: expected $expectedPrev, got $actualPrev',
        );
      }
    }
    store.appendBlocks([block]);
  }

  /// Append multiple Commonplace blocks with full linkage verification.
  void appendBlocks(List<Map<String, dynamic>> blocks) {
    if (blocks.isEmpty) return;
    for (final b in blocks) {
      _assertAllowedType(b);
    }

    final last = getLastBlock();

    // Bridge linkage.
    if (last != null) {
      final expectedPrev = getBlockHashFor(last);
      final firstPrev = blocks.first['prev_hash'] as String? ?? '';
      if (expectedPrev.isNotEmpty && firstPrev != expectedPrev) {
        throw Exception(
          'Bridge prev_hash mismatch: expected $expectedPrev, got $firstPrev',
        );
      }
    }

    // Internal linkage.
    for (var i = 1; i < blocks.length; i++) {
      final expected = getBlockHashFor(blocks[i - 1]);
      final actual = blocks[i]['prev_hash'] as String? ?? '';
      if (expected.isNotEmpty && actual != expected) {
        throw Exception(
          'Internal prev_hash mismatch at index $i: '
          'expected $expected, got $actual',
        );
      }
    }

    store.appendBlocks(blocks);
  }

  /// Remove [removeCount] blocks from the end of the chain.
  List<Map<String, dynamic>> truncate(int removeCount) {
    final currentCount = getBlockCount();
    if (currentCount == 0) return [];

    int keepCount = currentCount - removeCount;
    if (keepCount < 0) keepCount = 0;
    if (keepCount == 0 && removeCount > currentCount) keepCount = 1;

    return store.truncate(keepCount);
  }

  /// Append-only merge of [remoteBlocks] onto this chain.
  ///
  /// Mirrors `SyncService.reconcileRemoteLedger` semantics for the Commonplace
  /// sealed chain (ADR-031 remote-sync slice):
  ///   - a remote block identical (same hash) to the local one is skipped;
  ///   - a remote tail that bridges the last local block is appended in order;
  ///   - same index / different hash, a non-bridging tip, or a non-genesis
  ///     first block on an empty chain is reported as a conflict and **never
  ///     written** (a stale device never clobbers the remote canonical chain).
  CommonplaceReconcileResult reconcileRemoteChain(
    List<Map<String, dynamic>> remoteBlocks,
  ) {
    final r = reconcileChainCore(
      local: readAll(),
      remoteBlocks: remoteBlocks,
      blockHash: getBlockHashFor,
      genesisType: 'commonplace_genesis',
      appendBlocks: appendBlocks,
    );
    return CommonplaceReconcileResult(
      conflictedIndices: r.conflictedIndices,
      appended: r.appended,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // Verification
  // ═══════════════════════════════════════════════════════════════

  /// Verify the entire Commonplace chain.
  bool verify() => verifyBlocks(readAll());

  /// Verify an arbitrary Commonplace block sequence (used by both [verify] and
  /// the pull-service pre-import validation). An empty list is vacuously valid.
  bool verifyBlocks(List<Map<String, dynamic>> blocks) {
    if (blocks.isEmpty) return true;

    final genesis = blocks.first;
    final genesisKv = genesis['key_version'] as int? ?? 1;
    final formatVersion = genesis['format_version'] as String? ?? '0.4.0';
    final requireContentHash = compareVersions(formatVersion, '0.4.0') >= 0;

    for (var i = 0; i < blocks.length; i++) {
      final block = blocks[i];

      if (!prevHashValid(i > 0 ? blocks[i - 1] : null, block)) {
        return false;
      }

      if (!verifyBlockSeal(block)) return false;

      if (_identitySecretHex != null && block.containsKey('identity_seal')) {
        final hash = getBlockHashFor(block);
        if (!crypto.verifySignature(
            hash, block['identity_seal'] as String, _identitySecretHex)) {
          return false;
        }
      }

      if (block['type'] == 'commonplace') {
        final entries = block['entries'] as List<dynamic>? ?? [];
        for (final entry in entries) {
          if (entry is! Map) return false;
          final data = entry['data'] as Map<String, dynamic>?;
          final hash = entry['hash'] as String?;
          if (data == null || hash == null) return false;

          if (!verifyEntryHashTwoWay(data, hash)) return false;

          final contentHash = data['content_hash'] as String?;
          final hasContentHash = contentHash != null && contentHash.isNotEmpty;
          if (requireContentHash && !hasContentHash) return false;
          if (hasContentHash) {
            if (!verifyContentHash(
              data,
              contentHash,
              decryptFn: (c) => crypto.decryptWithCachedKey(c),
            )) {
              return false;
            }
          }
        }

        // Key-version invariant: a day block may not rotate past its genesis.
        final blockKv = block['key_version'] as int? ?? 1;
        if (blockKv > genesisKv) return false;
      }
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // Accessors
  // ═══════════════════════════════════════════════════════════════

  /// Resolve the hashing key for a Commonplace block (SealableChain).
  ///
  /// `commonplace_genesis` → `block_hash`; `commonplace` → `day_hash`;
  /// anything else → empty string (mirrors ledger `getBlockHash`).
  @override
  String getBlockHashFor(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    switch (type) {
      case 'commonplace_genesis':
        return block['block_hash'] as String? ?? '';
      case 'commonplace':
        return block['day_hash'] as String? ?? '';
      default:
        return '';
    }
  }

  /// The cached master-key hex the chain seals under.
  String? getMasterKeyHex() => crypto.getMasterKey();

  /// All blocks in the chain.
  List<Map<String, dynamic>> readAll() {
    return store.readBlocks();
  }

  /// Total number of blocks.
  int getBlockCount() {
    return store.getBlockCount();
  }

  /// Only Commonplace day-type blocks (excludes genesis).
  @override
  List<Map<String, dynamic>> getDayBlocks() {
    return readAll().where((b) => b['type'] == 'commonplace').toList();
  }

  /// The last block, or null if the chain is empty.
  Map<String, dynamic>? getLastBlock() {
    return store.getLastBlock();
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// Encrypt a raw Commonplace entry's content fields for sealed storage.
  ///
  /// `title`→`title_enc`, `entry`→`entry_enc`, `tags`→`tags_enc`,
  /// `ad_hoc`→`ad_hoc_enc` (only when present). `type`, `timestamp_ms`, and
  /// `date` stay plaintext (they are not content). There is no `comment` field
  /// in the Commonplace schema (ADR-031 — `entry` replaces it).
  Map<String, dynamic> _encryptCommonplaceEntry(
      Map<String, dynamic> data, {
      required String dateStr}) {
    final type = data['type'] as String? ?? 'commonplace';
    final title = data['title'] as String? ?? '';
    final entryText = data['entry'] as String? ?? '';
    final tags = (data['tags'] as List<dynamic>? ?? <dynamic>[])
        .map((t) => t.toString())
        .toList();
    final adHoc = data.containsKey('ad_hoc') && data['ad_hoc'] is Map
        ? Map<String, dynamic>.from(data['ad_hoc'] as Map)
        : null;
    final timestampMs = data['timestamp_ms'];

    return <String, dynamic>{
      'type': type,
      'timestamp_ms': timestampMs is int ? timestampMs : 0,
      'date': data['date'] as String? ?? dateStr,
      'title_enc': crypto.encryptWithCachedKey(title),
      'entry_enc': crypto.encryptWithCachedKey(entryText),
      'tags_enc': crypto.encryptWithCachedKey(jsonEncode(tags)),
      if (adHoc != null && adHoc.isNotEmpty)
        'ad_hoc_enc': crypto.encryptWithCachedKey(jsonEncode(adHoc)),
    };
  }

  /// Throw unless [block]'s type belongs to the Commonplace whitelist.
  void _assertAllowedType(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    if (type != 'commonplace' && type != 'commonplace_genesis') {
      throw Exception('Unknown/foreign block type for Commonplace chain: $type');
    }
  }

  /// Decrypt one Commonplace entry's encapsulated fields back to plaintext.
  ///
  /// Returns a map with `title`, `entry`, `tags`, `timestamp_ms`, `date`,
  /// optional `ad_hoc`, and `type` (the public read shape).
  Map<String, dynamic> decryptEntryData(Map<String, dynamic> data) {
    final result = <String, dynamic>{};

    var title = '';
    if (data.containsKey('title_enc')) {
      try {
        title = crypto.decryptWithCachedKey(data['title_enc'] as String);
      } catch (_) {}
    }
    result['title'] = title;

    var entry = '';
    if (data.containsKey('entry_enc')) {
      try {
        entry = crypto.decryptWithCachedKey(data['entry_enc'] as String);
      } catch (_) {}
    }
    result['entry'] = entry;

    var tags = <String>[];
    if (data.containsKey('tags_enc')) {
      try {
        final plain = crypto.decryptWithCachedKey(data['tags_enc'] as String);
        tags = (jsonDecode(plain) as List<dynamic>).map((e) => e.toString()).toList();
      } catch (_) {}
    }
    result['tags'] = tags;

    if (data.containsKey('ad_hoc_enc')) {
      try {
        final plain = crypto.decryptWithCachedKey(data['ad_hoc_enc'] as String);
        result['ad_hoc'] = jsonDecode(plain) as Map<String, dynamic>;
      } catch (_) {
        result['ad_hoc'] = <String, dynamic>{};
      }
    }

    result['timestamp_ms'] = data['timestamp_ms'];
    result['date'] = data['date'];
    if (data.containsKey('type')) {
      result['type'] = data['type'];
    }
    return result;
  }
}

/// Result of a [CommonplaceChain.reconcileRemoteChain] merge: which remote
/// block ordinals diverged from the local sealed chain (never written), and
/// how many missing blocks were appended (behind-device catch-up).
class CommonplaceReconcileResult {
  /// Block ordinals where the remote chain conflicted with the local chain and
  /// was NOT written (fork / same-index-different-hash / non-bridging tip /
  /// non-genesis-first on an empty chain).
  final List<int> conflictedIndices;

  /// Number of missing remote blocks appended to the local chain.
  final int appended;

  const CommonplaceReconcileResult({
    this.conflictedIndices = const [],
    this.appended = 0,
  });

  /// Whether the merge surfaced any divergent/cannot-merge remote block.
  bool get hasConflicts => conflictedIndices.isNotEmpty;
}
