import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, computeEntryHash, verifyEntryHashTwoWay, verifyContentHash, compareVersions, secretToHex;
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    as helpers show jsonEncodeSortedNoSpaces;

/// The append-only cryptographic chain — the heart of the PH ledger.
///
/// Builds, seals, signs, appends, truncates, and verifies ledger blocks.
/// Must produce byte-identical output to Python `domain/ledger/chain.py`.
class LedgerChain {
  final CryptoService crypto;
  final dynamic store;
  final String? identitySecret;
  final String? _identitySecretHex;

  LedgerChain({
    required this.crypto,
    required this.store,
    this.identitySecret,
  }) : _identitySecretHex = secretToHex(identitySecret);

  // ═══════════════════════════════════════════════════════════════
  // Block Building
  // ═══════════════════════════════════════════════════════════════

  /// Build and append a genesis block.
  ///
  /// Throws if the chain already has blocks.
  Map<String, dynamic> buildGenesisBlock({
    required String username,
    required String email,
    required String recoverySeedEnc,
    required String identityPubKey,
    required String identitySecretEncFallback,
    String formatVersion = '0.4.0',
  }) {
    if (getBlockCount() > 0) {
      throw Exception('Ledger already has blocks — cannot create genesis');
    }

    final gen = <String, dynamic>{
      'type': 'genesis',
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

    // Compute block_hash: seal over the genesis content
    final blockHash = _sealBlock(gen, 'block_hash');
    gen['block_hash'] = blockHash;

    // Identity seal over block_hash
    if (_identitySecretHex != null) {
      gen['identity_seal'] = crypto.sign(blockHash, _identitySecretHex);
    }

    return gen;
  }

  /// Build a day block (does NOT append to the chain).
  ///
  /// [entries] may contain pre-hashed `{hash, data}` maps or raw dicts.
  /// Entry hashes are always recomputed from data for integrity.
  Map<String, dynamic> buildDayBlock({
    required List<dynamic> entries,
    required String prevHash,
    required String dateStr,
    int? keyVersion,
  }) {
    // Determine day_index
    final existingDays = _countDayBlocks();
    final dayIndex = existingDays == 0 ? 1 : existingDays + 1;
    final kv = keyVersion ?? 1;

    // Normalize entries: always recompute hash from data
    final normalizedEntries = <Map<String, dynamic>>[];
    for (final entry in entries) {
      Map<String, dynamic> data;
      if (entry is Map && entry.containsKey('data')) {
        data = Map<String, dynamic>.from(entry['data'] as Map);
      } else {
        data = Map<String, dynamic>.from(entry as Map);
      }

      // Strip staging-only fields
      data.remove('is_active');
      data.remove('entry_id');
      data.remove('device_uuid');

      final computedHash = computeEntryHash(data);
      normalizedEntries.add({
        'hash': computedHash,
        'data': data,
      });
    }

    final block = <String, dynamic>{
      'type': 'day',
      'date': dateStr,
      'day_index': dayIndex,
      'prev_hash': prevHash,
      'entries': normalizedEntries,
      'key_version': kv,
    };

    // Compute day_hash
    final dayHash = _sealBlock(block, 'day_hash');
    block['day_hash'] = dayHash;

    // Identity seal
    if (_identitySecretHex != null) {
      block['identity_seal'] = crypto.sign(dayHash, _identitySecretHex);
    }

    return block;
  }

  // ═══════════════════════════════════════════════════════════════
  // Mutations
  // ═══════════════════════════════════════════════════════════════

  /// Append a single block, verifying prev_hash linkage.
  void append(Map<String, dynamic> block) {
    final last = getLastBlock();
    if (last != null) {
      final expectedPrev = getBlockHash(last);
      final actualPrev = block['prev_hash'] as String? ?? '';
      if (expectedPrev.isNotEmpty && actualPrev != expectedPrev) {
        throw Exception(
          'prev_hash mismatch: expected $expectedPrev, got $actualPrev',
        );
      }
    }
    store.appendBlocks([block]);
  }

  /// Append multiple blocks with full linkage verification.
  ///
  /// Verifies:
  /// 1. Bridge: last existing block → first new block
  /// 2. Internal: all adjacent pairs in the batch
  void appendBlocks(List<Map<String, dynamic>> blocks) {
    if (blocks.isEmpty) return;

    final last = getLastBlock();

    // Bridge linkage
    if (last != null) {
      final expectedPrev = getBlockHash(last);
      final firstPrev = blocks.first['prev_hash'] as String? ?? '';
      if (expectedPrev.isNotEmpty && firstPrev != expectedPrev) {
        throw Exception(
          'Bridge prev_hash mismatch: expected $expectedPrev, got $firstPrev',
        );
      }
    }

    // Internal linkage
    for (var i = 1; i < blocks.length; i++) {
      final expected = getBlockHash(blocks[i - 1]);
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
  ///
  /// Preserves at minimum block 0 when trying to remove more blocks than exist.
  /// Returns the removed blocks in order.
  List<Map<String, dynamic>> truncate(int removeCount) {
    final currentCount = getBlockCount();
    if (currentCount == 0) return [];

    int keepCount = currentCount - removeCount;
    if (keepCount < 0) keepCount = 0;

    // Preserve at minimum block 0 when over-truncating
    if (keepCount == 0 && removeCount > currentCount) {
      keepCount = 1;
    }

    return store.truncate(keepCount);
  }

  // ═══════════════════════════════════════════════════════════════
  // Verification
  // ═══════════════════════════════════════════════════════════════

  /// Verify the entire chain.
  bool verify() {
    final blocks = readAll();
    if (blocks.isEmpty) return true;

    // Get genesis key_version for invariant check
    final genesis = blocks.first;
    final genesisKv = genesis['key_version'] as int? ?? 1;
    final formatVersion = genesis['format_version'] as String? ?? '0.4.0';
    final requireContentHash = compareVersions(formatVersion, '0.4.0') >= 0;

    for (var i = 0; i < blocks.length; i++) {
      final block = blocks[i];

      // Check prev_hash linkage (except first block)
      if (i > 0) {
        final expected = getBlockHash(blocks[i - 1]);
        final actual = block['prev_hash'] as String? ?? '';
        if (expected.isNotEmpty && actual != expected) {
          return false;
        }
      }

      // Check block seal
      if (!_verifyBlockSeal(block)) return false;

      // Check identity_seal
      if (_identitySecretHex != null && block.containsKey('identity_seal')) {
        final hash = getBlockHash(block);
        if (!crypto.verifySignature(
            hash, block['identity_seal'] as String, _identitySecretHex)) {
          return false;
        }
      }

      // Day block specific checks
      if (block['type'] == 'day') {
        final entries = block['entries'] as List<dynamic>? ?? [];

        for (final entry in entries) {
          if (entry is! Map) return false;

          final data = entry['data'] as Map<String, dynamic>?;
          final hash = entry['hash'] as String?;
          if (data == null || hash == null) return false;

          // Verify entry hash
          if (!verifyEntryHashTwoWay(data, hash)) return false;

          // Verify content_hash
          if (requireContentHash) {
            final contentHash = data['content_hash'] as String?;
            if (contentHash == null || contentHash.isEmpty) return false;

            if (!verifyContentHash(
              data,
              contentHash,
              decryptFn: (c) => crypto.decryptWithCachedKey(c),
            )) {
              return false;
            }
          } else {
            // Content hash optional but verify if present
            final contentHash = data['content_hash'] as String?;
            if (contentHash != null && contentHash.isNotEmpty) {
              if (!verifyContentHash(
                data,
                contentHash,
                decryptFn: (c) => crypto.decryptWithCachedKey(c),
              )) {
                return false;
              }
            }
          }
        }
      }

      // Key version invariant
      if (block['type'] == 'day') {
        final blockKv = block['key_version'] as int? ?? 1;
        if (blockKv > genesisKv) return false;
      }
    }

    return true;
  }

  /// Verify a single block at [index].
  bool verifyBlock(int index) {
    final blocks = readAll();
    if (index < 0 || index >= blocks.length) return false;

    final block = blocks[index];

    // Check prev_hash for non-zero blocks
    if (index > 0) {
      final expected = getBlockHash(blocks[index - 1]);
      final actual = block['prev_hash'] as String? ?? '';
      if (expected.isNotEmpty && actual != expected) return false;
    }

    // Check seal
    if (!_verifyBlockSeal(block)) return false;

    // Genesis-specific
    if (index == 0 && block['type'] == 'genesis') {
      if (_identitySecretHex != null && block.containsKey('identity_seal')) {
        final hash = getBlockHash(block);
        if (!crypto.verifySignature(
            hash, block['identity_seal'] as String, _identitySecretHex)) {
          return false;
        }
      }
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // Seal & Identity
  // ═══════════════════════════════════════════════════════════════

  /// Compute a deterministic HMAC-SHA256 seal of [data].
  String computeSeal(Map<String, dynamic> data) {
    final json = jsonSort(data);
    return crypto.seal(json, crypto.getMasterKey()!);
  }

  /// Verify a seal against [data], trying compact, indent2, and no-space formats.
  bool verifySeal(Map<String, dynamic> data, String seal) {
    if (seal.isEmpty) return false;
    final mk = crypto.getMasterKey()!;

    // Canonical compact format (sort_keys, with spaces)
    if (crypto.verifySeal(jsonSort(data), seal, mk)) return true;
    // Indent2 fallback
    if (crypto.verifySeal(jsonSortIndent2(data), seal, mk)) return true;
    // No-space compact fallback (JS-style compact)
    final noSpaceJson = helpers.jsonEncodeSortedNoSpaces(data);
    if (crypto.verifySeal(noSpaceJson, seal, mk)) return true;

    return false;
  }

  /// Compute an identity MAC. Returns null if identitySecret is null.
  String? computeIdentityMac(String data, String secret) {
    final secretHex = secretToHex(secret)!;
    return crypto.sign(data, secretHex);
  }

  /// Verify an identity MAC.
  bool verifyIdentityMac(String data, String mac, String secret) {
    final secretHex = secretToHex(secret)!;
    return crypto.verifySignature(data, mac, secretHex);
  }

  // ═══════════════════════════════════════════════════════════════
  // Accessors
  // ═══════════════════════════════════════════════════════════════

  /// Return all blocks in the chain.
  List<Map<String, dynamic>> readAll() {
    return store.readBlocks();
  }

  /// Return the total number of blocks.
  int getBlockCount() {
    return store.getBlockCount();
  }

  /// Return only day-type blocks (excludes genesis and summaries).
  List<Map<String, dynamic>> getDayBlocks() {
    return readAll().where((b) => b['type'] == 'day').toList();
  }

  /// Return the last block, or null if the chain is empty.
  Map<String, dynamic>? getLastBlock() {
    return store.getLastBlock();
  }

  // ═══════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════

  /// Count existing day blocks (for day_index computation).
  int _countDayBlocks() {
    return getDayBlocks().length;
  }

  /// Compute a seal over [block] content, excluding [hashKey] and identity_seal.
  String _sealBlock(Map<String, dynamic> block, String hashKey) {
    final sealData = <String, dynamic>{};
    for (final entry in block.entries) {
      if (entry.key != hashKey && entry.key != 'identity_seal') {
        sealData[entry.key] = entry.value;
      }
    }
    return computeSeal(sealData);
  }

  /// Verify a block's internal seal.
  bool _verifyBlockSeal(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    if (type == null) return false;

    String hashKey;
    switch (type) {
      case 'genesis':
        hashKey = 'block_hash';
        break;
      case 'day':
        hashKey = 'day_hash';
        break;
      case 'month_summary':
        hashKey = 'month_hash';
        break;
      case 'year_summary':
        hashKey = 'year_hash';
        break;
      default:
        return false;
    }

    final storedHash = block[hashKey] as String?;
    if (storedHash == null || storedHash.isEmpty) return false;

    final expectedHash = _sealBlock(block, hashKey);
    return storedHash == expectedHash;
  }

}
