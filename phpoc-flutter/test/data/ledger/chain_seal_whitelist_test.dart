import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart'
    show getBlockHash, jsonEncodeSortedNoSpaces;

/// LedgerChain — Flutter block-seal whitelist (Phase 3: `_sealFields` 6-field).
///
/// Blueprint: `docs/planning/CANONICAL_SEALFIELD_FLUTTER_PHASE1.md`
///   Group A: `_sealFields` is the 6-field closed set (behavioral)
///   Group B: sealer folds `original_hash` into the seal (behavioral)
///   Group C: verifier accepts / detects tamper / optional-if-absent
///   Group D: cross-client parity (Python indent2, JS no-space, presence/absence)
///
/// Expected: tests that require the 6-field set (A/B/C1/C3/D) are RED because
/// chain.dart `_sealFields` is currently the 5-field `{type, day_index, date,
/// prev_hash, entries}` (missing `original_hash`). Tests requiring optionality
/// (C2) or closed-set exclusion (C4) may pass early — they are guards.

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

class _FakeLedgerStore {
  final List<Map<String, dynamic>> _blocks = [];
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    if (start < 0) start = 0;
    if (e > _blocks.length) return _blocks.sublist(start);
    return _blocks.sublist(start, e);
  }
  void appendBlocks(List<Map<String, dynamic>> blocks) => _blocks.addAll(blocks);
  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }
  int getBlockCount() => _blocks.length;
  Map<String, dynamic>? getLastBlock() => _blocks.isEmpty ? null : _blocks.last;
}

LedgerChain _makeChain() {
  final crypto = CryptoService()..initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeLedgerStore();
  return LedgerChain(crypto: crypto, store: store);
}

/// Build a genesis block whose seal is computed over the canonical 6 fields
/// (incl `original_hash`), either present or absent. Returns the stored block.
Map<String, dynamic> _sealedGenesis({
  required CryptoService crypto,
  String? originalHash,
  String? prevHash,
}) {
  final payload = <String, dynamic>{
    'type': 'genesis',
    'day_index': 0,
    'date': '2025-01-01',
    'prev_hash': prevHash ?? ('0' * 64),
    'entries': <Map<String, dynamic>>[],
    if (originalHash != null) 'original_hash': originalHash,
  };
  final seal = crypto.seal(jsonSort(payload), mkHex);
  return {
    ...payload,
    'block_hash': seal,
    'format_version': '0.4.0',
    'key_version': 1,
    'username': 'u',
    'email': 'e@e.com',
    'recovery_seed_enc': 'seed',
    'identity_pub_key': 'pk',
    'identity_secret_enc_fallback': 'fb',
  };
}

/// Build a sealed day block (6 fields incl `original_hash` when provided).
Map<String, dynamic> _sealedDay({
  required CryptoService crypto,
  required String prevHash,
  String? originalHash,
  String Function(Map<String, dynamic>)? serializer,
}) {
  final s = serializer ?? jsonSort;
  final payload = <String, dynamic>{
    'type': 'day',
    'day_index': 1,
    'date': '2025-01-02',
    'prev_hash': prevHash,
    'entries': <Map<String, dynamic>>[
      {'hash': 'a' * 64, 'data': {'title': 'T', 'duration': 60}}
    ],
    if (originalHash != null) 'original_hash': originalHash,
  };
  final seal = crypto.seal(s(payload), mkHex);
  return {...payload, 'day_hash': seal, 'key_version': 1};
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: `_sealFields` is the 6-field closed set (behavioral).
  // C1 (A1) — a block sealed over the 6 fields incl `original_hash` verifies.
  group('A: _sealFields 6-field closed set (behavioral)', () {
    test('A1 genesis sealed over 6 fields (incl original_hash) → verifyBlock true', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      chain.store.appendBlocks([gen]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'genesis with original_hash in a 6-field seal must verify');
    });

    test('A2 day block sealed over 6 fields (incl original_hash) → verify true', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      chain.store.appendBlocks([gen]);
      final day = _sealedDay(
        crypto: crypto,
        prevHash: getBlockHash(gen),
        originalHash: 'cd' * 32,
      );
      chain.store.appendBlocks([day]);
      // verifyBlock(1) isolates the seal + prev_hash check (avoids the
      // independent content_hash layer, which is out of Phase 3 scope).
      expect(chain.verifyBlock(1), isTrue,
          reason: 'day block sealed over 6 fields incl original_hash must verify');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: verifier accepts / detects tamper / optional-if-absent.
  group('C: verifier over 6-field seals', () {
    test('C1 6-field genesis seal verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      chain.store.appendBlocks([gen]);
      expect(chain.verifyBlock(0), isTrue);
    });

    test('C2 original_hash ABSENT → genesis still verifies (optional-if-absent)', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: null);
      chain.store.appendBlocks([gen]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'absence of original_hash must not break verification');
    });

    test('C3 tampering original_hash invalidates the seal → verifyBlock false', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      gen['original_hash'] = 'ff' * 32; // tamper provenance
      chain.store.appendBlocks([gen]);
      expect(chain.verifyBlock(0), isFalse,
          reason: 'tampered original_hash must invalidate the 6-field seal');
    });

    test('C4 format_version/key_version tamper does NOT invalidate the seal', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      gen['format_version'] = '9.9.9';
      gen['key_version'] = 99;
      chain.store.appendBlocks([gen]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'non-whitelisted metadata must not affect the closed-set seal');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: cross-client parity.
  group('D: cross-client parity over 6-field seals', () {
    test('D1 Python indent2 seal over 6 fields (incl original_hash) verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
        'original_hash': 'ab' * 32,
      };
      final seal = crypto.seal(jsonSortIndent2(gen), mkHex);
      chain.store.appendBlocks([
        {
          ...gen,
          'block_hash': seal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'cli',
          'email': 'cli@t.co',
          'recovery_seed_enc': 's',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'Python indent2-sealed migrated genesis must verify on Flutter');
    });

    test('D2 JS no-space seal over 6 fields (incl original_hash) verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'original_hash': 'ab' * 32,
        'entries': <Map<String, dynamic>>[],
      };
      final seal = crypto.seal(jsonEncodeSortedNoSpaces(gen), mkHex);
      chain.store.appendBlocks([
        {
          ...gen,
          'block_hash': seal,
          'format_version': '0.4.0',
          'key_version': 1,
        }
      ]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'JS no-space-sealed migrated genesis must verify on Flutter');
    });

    test('D3 original_hash presence + absence both verify across fallbacks', () {
      // Genesis without original_hash (absent) — should pass (C2 already).
      // Genesis with original_hash sealed over jsonSort — should pass (C1).
      // Combined proof that both states verify via the same verifier.
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final withoutOrig = _sealedGenesis(crypto: crypto, originalHash: null);
      final withOrig = _sealedGenesis(
        crypto: crypto,
        originalHash: 'ab' * 32,
        prevHash: getBlockHash(withoutOrig), // link BEFORE sealing
      );
      chain.store.appendBlocks([withoutOrig, withOrig]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'genesis WITHOUT original_hash verifies');
      expect(chain.verifyBlock(1), isTrue,
          reason: 'genesis WITH original_hash verifies (same verifier)');
    });
  });
}
