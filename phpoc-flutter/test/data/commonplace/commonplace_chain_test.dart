import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';

/// CommonplaceChain — Phase 2 (RED) test suite.
///
/// All 31 assertions from docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md
/// Groups A–C:
///   Group A: Commonplace Genesis — Build & Sealing (11)
///   Group B: Commonplace Day Block — Build & Sealing (12)
///   Group C: Commonplace Chain — Append & Truncate (8)
///
/// Expected: all tests FAIL (RED) because commonplace_chain.dart does not
/// exist yet. The API here is the future contract mirrors of
/// `lib/data/ledger/chain.dart` (Axiom B5).

// ── In-memory store fakes ───────────────────────────────────────

/// In-memory Commonplace block store implementing the store contract
/// expected by CommonplaceChain (duck-typed like the ledger store).
class _FakeCommonplaceStore {
  final List<Map<String, dynamic>> _blocks = [];

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    if (start < 0) start = 0;
    if (e > _blocks.length) return _blocks.sublist(start);
    return _blocks.sublist(start, e);
  }

  void appendBlocks(List<Map<String, dynamic>> blocks) {
    _blocks.addAll(blocks);
  }

  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }

  int getBlockCount() => _blocks.length;

  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;

  /// Replace the block at [index] (test-only tamper helper).
  void replaceBlockAt(int index, Map<String, dynamic> replacement) {
    if (index < 0 || index >= _blocks.length) return;
    _blocks[index] = replacement;
  }
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Helper to create a fresh CommonplaceChain with in-memory store.
CommonplaceChain _makeChain({String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeCommonplaceStore();
  return CommonplaceChain(
    crypto: crypto,
    store: store,
    identitySecret: identitySecretHex,
  );
}

/// Variant that exposes the underlying store so tests can tamper with it.
(_FakeCommonplaceStore, CommonplaceChain, CryptoService) _makeChainWithStore(
    {String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeCommonplaceStore();
  final chain = CommonplaceChain(
    crypto: crypto,
    store: store,
    identitySecret: identitySecretHex,
  );
  return (store, chain, crypto);
}

/// Build and append a Commonplace genesis on [chain].
Map<String, dynamic> _seedGenesis(CommonplaceChain chain) {
  return chain.buildGenesis(
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  );
}

/// Build a fully-formed Commonplace entry dict (no comment field).
Map<String, dynamic> _cpEntry({
  required String title,
  String entry = 'a noted passage text',
  List<String> tags = const ['topic'],
  Map<String, dynamic>? adHoc,
  int timestampMs = 1700000000000,
  String date = '2026-08-21',
}) {
  return {
    'type': 'commonplace',
    'title': title,
    'tags': tags,
    'entry': entry,
    if (adHoc != null) 'ad_hoc': adHoc,
    'timestamp_ms': timestampMs,
    'date': date,
  };
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: Commonplace Genesis — Build & Sealing (11 tests)
  // ═══════════════════════════════════════════════════════════════

  group('A: CommonplaceChain — Genesis Build & Sealing', () {
    // CP-A1 — buildGenesis: type=commonplace_genesis, day_index=0, entries=[]
    test(
        'CP-A1: buildGenesis creates commonplace_genesis block, day_index=0, entries=[]',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesis(
        username: 'testuser',
        email: 'test@example.com',
        recoverySeedEnc: 'encrypted-seed',
        identityPubKey: 'pub-key-hex',
        identitySecretEncFallback: 'fallback-hex',
      );

      expect(gen['type'], 'commonplace_genesis');
      expect(gen['day_index'], 0);
      expect(gen['entries'], isEmpty);
    });

    // CP-A2 — buildGenesis includes shared identity fields
    test('CP-A2: buildGenesis embeds username, email, recovery_seed, identity key', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesis(
        username: 'alice',
        email: 'alice@example.com',
        recoverySeedEnc: 'seed-enc-string',
        identityPubKey: 'pub-key',
        identitySecretEncFallback: 'secret-fallback',
      );

      expect(gen['username'], 'alice');
      expect(gen['email'], 'alice@example.com');
      expect(gen['recovery_seed_enc'], 'seed-enc-string');
      expect(gen['identity_pub_key'], 'pub-key');
    });

    // CP-A3 — buildGenesis uses block_hash (not day_hash)
    test('CP-A3: buildGenesis keys root with block_hash, not day_hash', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      expect(gen.containsKey('block_hash'), isTrue);
      expect(gen['block_hash'], isNotEmpty);
      expect(chain.getBlockHashFor(gen), gen['block_hash']);
      expect(gen.containsKey('day_hash'), isFalse);
    });

    // CP-A4 — buildGenesis computes identity seal over the block hash
    test('CP-A4: buildGenesis anchors an identity_seal over block_hash', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      final genHash = chain.getBlockHashFor(gen);
      final seal = gen['identity_seal'];
      expect(seal, isA<String>());
      expect(seal, isNotEmpty);
      expect(chain.verifyIdentityMac(genHash, seal, identitySecret), isTrue);
    });

    // CP-A5 — genesis prev_hash is 64 zeros
    test('CP-A5: buildGenesis uses a 64-zero prev_hash sentinel', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      expect(gen['prev_hash'], '0' * 64);
    });

    // CP-A6 — buildGenesis throws if the Commonplace chain already has blocks
    test('CP-A6: buildGenesis throws when blocks already exist', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);

      expect(
        () => chain.buildGenesis(
          username: 'bob',
          email: 'bob@example.com',
          recoverySeedEnc: 'seed',
          identityPubKey: 'pk',
          identitySecretEncFallback: 'fb',
        ),
        throwsException,
      );
    });

    // CP-A7 — Commonplace genesis is distinct from the activity ledger genesis
    test('CP-A7: Commonplace genesis is a distinct chain root under the same MK', () {
      final cp = _makeChain(identitySecretHex: identitySecret);
      final cpGen = _seedGenesis(cp);

      // The common user identity appears, but the chain root is separate and
      // keyed by the distinctive commonplace_genesis type.
      expect(cpGen['type'], 'commonplace_genesis');
      expect(cp.getBlockCount(), 1);
    });

    // CP-A8 — genesis hashes/keys derive from the same MK the ledger uses
    test('CP-A8: Commonplace genesis sealing uses the shared master key', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      // The seal/block_hash must be recomputed deterministically from the
      // genesis content under the same MK, and the chain must be verifiable.
      expect(chain.getMasterKeyHex(), mkHex);
      expect(gen['block_hash'], isNotEmpty);
      expect(chain.verify(), isTrue);
    });

    // CP-A9 — no block-hash collision between Commonplace and activity genesis
    test('CP-A9: Commonplace and activity genesis roots stay distinct (D7)',
        () {
      final cp = _makeChain(identitySecretHex: identitySecret);
      final cpGen = _seedGenesis(cp);
      final cpHash = cp.getBlockHashFor(cpGen);

      // Build an equivalent activity-genesis on the real ledger chain.
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final ledgerChain = LedgerChain(
        crypto: crypto,
        store: _FakeLedgerStore(),
        identitySecret: identitySecret,
      );
      final actGen = ledgerChain.buildGenesisBlock(
        username: 'testuser',
        email: 'test@example.com',
        recoverySeedEnc: 'encrypted-seed',
        identityPubKey: 'pub-key-hex',
        identitySecretEncFallback: 'fallback-hex',
      );
      final actHash = getBlockHash(actGen);

      // Distinct types + distinct sealed roots ⇒ no accidental mixing (D7).
      expect(cpGen['type'], isNot(actGen['type']));
      expect(actGen['type'], 'genesis');
      expect(cpGen['type'], 'commonplace_genesis');
      expect(cpHash, isNotEmpty);
      expect(cpHash, isNot(actHash));
    });

    // CP-A10 — genesis records the seed's key_version
    test('CP-A10: buildGenesis records the key_version', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      expect(gen.containsKey('key_version'), isTrue);
      expect(gen['key_version'], isA<int>());
      expect(gen['key_version'], greaterThanOrEqualTo(1));
    });

    // CP-A11 — verify on a fresh genesis passes
    test('CP-A11: verify() is true for a valid single-genesis chain', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);

      expect(chain.verify(), isTrue);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group B: Commonplace Day Block — Build & Sealing (12 tests)
  // ═══════════════════════════════════════════════════════════════

  group('B: CommonplaceChain — Day Block Build & Sealing', () {
    // CP-B1 — buildDayBlock type=commonplace with correct day_index
    test('CP-B1: buildDayBlock creates a commonplace day block (index 1)', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);
      final genHash = chain.getBlockHashFor(gen);

      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'First passage', entry: 'alpha')],
        prevHash: genHash,
        dateStr: '2026-08-21',
      );

      expect(block['type'], 'commonplace');
      expect(block['day_index'], 1);
    });

    // CP-B2 — buildDayBlock accepts a fully-formed Commonplace entry dict
    test('CP-B2: buildDayBlock accepts a full commonplace entry {title,tags,entry,ad_hoc,timestamp_ms,date}',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      final entry = _cpEntry(
        title: 'Quiet power',
        entry: 'a long passage to preserve',
        tags: const ['notes', 'vim'],
        adHoc: {'source': 'conversation'},
        timestampMs: 1720000000000,
        date: '2026-08-22',
      );
      final block = chain.buildDayBlock(
        entries: [entry],
        prevHash: chain.getBlockHashFor(gen),
        dateStr: '2026-08-22',
      );

      final sealedEntries = block['entries'] as List<dynamic>;
      expect(sealedEntries.length, 1);
    });

    // CP-B3 — buildDayBlock recomputes each entry's content hash from data
    test('CP-B3: buildDayBlock recomputes content hashes from actual data',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);

      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Hashed note')],
        prevHash: chain.getBlockHashFor(gen),
        dateStr: '2026-08-21',
      );

      final sealed = (block['entries'] as List<dynamic>).first as Map;
      final data = Map<String, dynamic>.from(sealed['data'] as Map);
      final contentHash = data['content_hash'];
      expect(contentHash, isNotEmpty);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      expect(computeContentHash(data, crypto), contentHash);
    });

    // CP-B4 — buildDayBlock computes day_hash via seal over canonical fields
    test('CP-B4: buildDayBlock seals entry data under a resolvable day_hash key',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);
      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Sealed note')],
        prevHash: chain.getBlockHashFor(gen),
        dateStr: '2026-08-21',
      );

      // The block carries a sealing hash the chain can resolve for linkage.
      final resolved = chain.getBlockHashFor(block);
      expect(resolved, isNotEmpty);
      // Re-appending the built block keeps the chain integral.
      chain.append(block);
      expect(chain.verify(), isTrue);
    });

    // CP-B5 — buildDayBlock adds identity_seal when identity secret is set
    test('CP-B5: buildDayBlock signs with identity_seal when identity is present',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = _seedGenesis(chain);
      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Signed note')],
        prevHash: chain.getBlockHashFor(gen),
        dateStr: '2026-08-21',
      );

      expect(block.containsKey('identity_seal'), isTrue);
      final dayHash = chain.getBlockHashFor(block);
      expect(
        chain.verifyIdentityMac(dayHash, block['identity_seal'], identitySecret),
        isTrue,
      );
    });

    // CP-B6 — buildDayBlock omits identity_seal when identity secret is null
    test('CP-B6: buildDayBlock omits identity_seal when no identity secret', () {
      final chain = _makeChain(identitySecretHex: null);
      final gen = _seedGenesis(chain);
      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Anonymous note')],
        prevHash: chain.getBlockHashFor(gen),
        dateStr: '2026-08-21',
      );

      expect(block.containsKey('identity_seal'), isFalse);
    });

    // CP-B7 — first day block uses day_index 1 (after genesis at index 0)
    test('CP-B7: first day block starts day_index at 1', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'First')],
        prevHash: _genHash(chain),
        dateStr: '2026-08-21',
      );
      expect(block['day_index'], 1);
    });

    // CP-B8 — no ad_hoc → absent/empty ad-hoc map in the sealed entry
    test('CP-B8: entries without ad_hoc seal with absent ad-hoc map', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final block = _dayBlockWith(chain, _cpEntry(title: 'Plain note'));
      final data = _firstEntryData(block);

      expect(data.containsKey('ad_hoc_enc'), isFalse);
    });

    // CP-B9 — ad_hoc map seals and preserves all k/v pairs
    test('CP-B9: buildDayBlock preserves all ad_hoc key/value pairs', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final block = _dayBlockWith(
          chain,
          _cpEntry(
            title: 'Annotated',
            adHoc: {'source': 'book', 'page': '42', 'rating': 'high'},
          ));
      final data = _firstEntryData(block);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final plain = crypto.decryptWithCachedKey(data['ad_hoc_enc'] as String);
      final decoded = jsonDecode(plain) as Map<String, dynamic>;
      expect(decoded['source'], 'book');
      expect(decoded['page'], '42');
      expect(decoded['rating'], 'high');
    });

    // CP-B10 — title and entry are encrypted at rest
    test('CP-B10: title and entry are encrypted (no plaintext) at rest', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final block =
          _dayBlockWith(chain, _cpEntry(title: 'SecretTitle', entry: 'SecretEntry'));
      final data = _firstEntryData(block);

      expect(data.containsKey('title'), isFalse);
      expect(data.containsKey('entry'), isFalse);
      expect(data['title_enc'], isA<String>());
      expect(data['entry_enc'], isA<String>());

      // Ensure no plaintext leaks into the serialized block.
      final raw = jsonEncode(block);
      expect(raw.contains('SecretTitle'), isFalse);
      expect(raw.contains('SecretEntry'), isFalse);
    });

    // CP-B11 — tags list is encrypted at rest
    test('CP-B11: tags are encrypted at rest (no plaintext tag list)', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final block = _dayBlockWith(
          chain, _cpEntry(title: 'Tagged', tags: const ['private-topic', 'vim']));
      final data = _firstEntryData(block);

      expect(data.containsKey('tags'), isFalse);
      expect(data['tags_enc'], isA<String>());
      final raw = jsonEncode(block);
      expect(raw.contains('private-topic'), isFalse);
    });

    // CP-B12 — multiple entries on same date merge into one day block
    test('CP-B12: same-date entries merge into a single day block', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      final block = chain.buildDayBlock(
        entries: [
          _cpEntry(title: 'One', timestampMs: 1700000000000),
          _cpEntry(title: 'Two', timestampMs: 1700064000000),
          _cpEntry(title: 'Three', timestampMs: 1700128000000),
        ],
        prevHash: _genHash(chain),
        dateStr: '2026-08-21',
      );

      final sealed = block['entries'] as List<dynamic>;
      expect(sealed.length, 3);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: Commonplace Chain — Append & Truncate (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('C: CommonplaceChain — Append & Truncate', () {
    // CP-C1 — append adds a block and links prev_hash
    test('CP-C1: append adds a single block and links it', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      chain.append(_dayBlockWith(chain, _cpEntry(title: 'One'), build: false));

      expect(chain.getBlockCount(), 2);
      expect(chain.getLastBlock()!['type'], 'commonplace');
    });

    // CP-C2 — append enforces prev_hash linkage to last block
    test('CP-C2: append chains correctly when prev_hash matches the tip', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      // build:false — the explicit chain.append(tip) below is the single
      // append (avoids double-appending the same block).
      final tip = _dayBlockWith(chain, _cpEntry(title: 'One'), build: false);
      chain.append(tip);

      final nextHash = chain.getBlockHashFor(tip);
      final next = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Two')],
        prevHash: nextHash,
        dateStr: '2026-08-22',
      );
      chain.append(next);

      expect(chain.getBlockCount(), 3);
      expect(chain.verify(), isTrue);
    });

    // CP-C3 — append throws on prev_hash mismatch
    test('CP-C3: append throws on prev_hash mismatch (tamper)', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      final wrongPrev = '1' * 64;
      final block = chain.buildDayBlock(
        entries: [_cpEntry(title: 'Broken link')],
        prevHash: wrongPrev,
        dateStr: '2026-08-21',
      );

      expect(() => chain.append(block), throwsException);
    });

    // CP-C4 — appendBlocks adds multiple with internal + bridge linkage
    test('CP-C4: appendBlocks adds multiple with internal + bridge linkage',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      final genHash = _genHash(chain);

      final b1 = chain.buildDayBlock(
        entries: [_cpEntry(title: 'A', date: '2026-08-21')],
        prevHash: genHash,
        dateStr: '2026-08-21',
      );
      final b2 = chain.buildDayBlock(
        entries: [_cpEntry(title: 'B', date: '2026-08-22')],
        prevHash: chain.getBlockHashFor(b1),
        dateStr: '2026-08-22',
      );

      chain.appendBlocks([b1, b2]);
      expect(chain.getBlockCount(), 3);
      expect(chain.verify(), isTrue);
    });

    // CP-C5 — truncate removes N blocks from the end, preserving linkage
    test('CP-C5: truncate removes N blocks from the end, remaining chain valid',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      chain.append(_dayBlockWith(chain, _cpEntry(title: 'One')));
      chain.append(_dayBlockWith(
          chain, _cpEntry(title: 'Two', date: '2026-08-22')));
      expect(chain.getBlockCount(), 3);

      chain.truncate(2);
      expect(chain.getBlockCount(), 1);
      expect(chain.verify(), isTrue);
    });

    // CP-C6 — append rejects a block of an unknown/foreign type
    test('CP-C6: append rejects a foreign block type', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      // 64 zeros fills the prev_hash shape.
      final foreign = <String, dynamic>{
        'type': 'day',
        'day_index': 1,
        'date': '2026-08-21',
        'prev_hash': _genHash(chain),
        'entries': <Map<String, dynamic>>[],
      };

      expect(() => chain.append(foreign), throwsException);
    });

    // CP-C7 — genesis + days verifies end-to-end
    test('CP-C7: a full chain of genesis + day blocks verifies end-to-end', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      chain.append(_dayBlockWith(chain, _cpEntry(title: 'One')));
      chain.append(_dayBlockWith(
          chain, _cpEntry(title: 'Two', date: '2026-08-22')));
      chain.append(_dayBlockWith(
          chain, _cpEntry(title: 'Three', date: '2026-08-23')));

      expect(chain.getBlockCount(), 4);
      expect(chain.verify(), isTrue);
    });

    // CP-C8 — tampering with an entry's ciphertext breaks verification
    test('CP-C8: tampering with one entry ciphertext breaks verify()', () {
      final (store, chain, _) = _makeChainWithStore(identitySecretHex: identitySecret);
      _seedGenesis(chain);
      chain.append(_dayBlockWith(chain, _cpEntry(title: 'Original')));
      expect(chain.verify(), isTrue);

      // Directly corrupt one sealed entry's ciphertext in the store.
      final blocks = store.readBlocks();
      final day = Map<String, dynamic>.from(blocks.last);
      final entries = List<dynamic>.from(day['entries'] as List<dynamic>);
      final data = Map<String, dynamic>.from(entries.first['data'] as Map);
      data['title_enc'] = '0' * (data['title_enc'] as String).length;
      entries[0] = {'hash': entries.first['hash'], 'data': data};
      day['entries'] = entries;

      // Corrupt the stored day block (index 1) and re-run verification — it
      // must now detect the tamper (stale day_hash / broken content hash).
      store.replaceBlockAt(1, day);
      expect(chain.verify(), isFalse);
    });
  });
}

// ── Shared test helpers ──────────────────────────────────────────

String _genHash(CommonplaceChain chain) =>
    chain.getBlockHashFor(chain.readAll().first);

/// Build (and return only the built block, not appending unless build=true).
/// prev_hash links onto the current chain tip (genesis if only genesis).
Map<String, dynamic> _dayBlockWith(CommonplaceChain chain, Map<String, dynamic> entry,
    {bool build = false}) {
  final tip = chain.getLastBlock();
  final prevHash = tip != null ? chain.getBlockHashFor(tip) : '0' * 64;
  final block = chain.buildDayBlock(
    entries: [entry],
    prevHash: prevHash,
    dateStr: (entry['date'] as String?) ?? '2026-08-21',
  );
  if (build) chain.append(block);
  return block;
}

Map<String, dynamic> _firstEntryData(Map<String, dynamic> block) {
  final first = block['entries'][0] as Map;
  return Map<String, dynamic>.from(first['data'] as Map);
}

/// Activity-ledger store fakes used by cross-chain tests.
class _FakeLedgerStore {
  final List<Map<String, dynamic>> _blocks = [];
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
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