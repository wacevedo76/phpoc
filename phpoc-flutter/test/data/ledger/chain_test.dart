import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';

/// LedgerChain — Phase 2 (RED) test suite.
///
/// All 49 assertions from docs/planning/flutter/LEDGER_PHASE1.md Groups B–E:
///   Group B: Block Building (14)
///   Group C: Append & Truncate (11)
///   Group D: Verification (16)
///   Group E: Seal & Identity (8)
///
/// Expected: all tests FAIL (RED) because chain.dart does not exist yet.

// ── In-memory store fakes ───────────────────────────────────────

/// In-memory ledger block store that implements the abstract store contract
/// expected by LedgerChain.
class _FakeLedgerStore {
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
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Helper to create a fresh LedgerChain with in-memory store.
LedgerChain _makeChain({
  String? identitySecretHex,
}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeLedgerStore();
  return LedgerChain(
    crypto: crypto,
    store: store,
    identitySecret: identitySecretHex,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group B: Block Building (14 tests)
  // ═══════════════════════════════════════════════════════════════

  group('B: LedgerChain — Block Building', () {
    // B1 — buildGenesisBlock: type=genesis, day_index=0, entries=[]
    test(
        'B1: buildGenesisBlock creates block with type=genesis, day_index=0, entries=[]',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'testuser',
        email: 'test@example.com',
        recoverySeedEnc: 'encrypted-seed',
        identityPubKey: 'pub-key-hex',
        identitySecretEncFallback: 'fallback-hex',
      );

      expect(gen['type'], 'genesis');
      expect(gen['day_index'], 0);
      expect(gen['entries'], isEmpty);
    });

    // B2 — buildGenesisBlock includes identity fields
    test(
        'B2: buildGenesisBlock includes identity fields: username, email, recovery_seed_enc, identity_pub_key',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'alice',
        email: 'alice@test.com',
        recoverySeedEnc: 'seed-encrypted',
        identityPubKey: 'pubkey-abc',
        identitySecretEncFallback: 'fallback-xyz',
      );

      expect(gen['username'], 'alice');
      expect(gen['email'], 'alice@test.com');
      expect(gen['recovery_seed_enc'], 'seed-encrypted');
      expect(gen['identity_pub_key'], 'pubkey-abc');
    });

    // B3 — buildGenesisBlock includes identity_secret_enc_fallback
    test(
        'B3: buildGenesisBlock includes identity_secret_enc_fallback', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'bob',
        email: 'bob@test.com',
        recoverySeedEnc: 'seed-enc',
        identityPubKey: 'key-123',
        identitySecretEncFallback: 'fallback-secret',
      );
      expect(gen['identity_secret_enc_fallback'], 'fallback-secret');
    });

    // B4 — buildGenesisBlock computes block_hash (not day_hash)
    test('B4: buildGenesisBlock computes block_hash (not day_hash)', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      expect(gen.containsKey('block_hash'), isTrue);
      expect(gen['block_hash'], isNotEmpty);
    });

    // B5 — buildGenesisBlock computes identity_seal over block_hash
    test(
        'B5: buildGenesisBlock computes identity_seal over block_hash', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      expect(gen.containsKey('identity_seal'), isTrue);
      expect(gen['identity_seal'], isNotEmpty);
    });

    // B6 — buildGenesisBlock prev_hash is 64 zeros
    test('B6: buildGenesisBlock prev_hash is 64 zeros', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      expect(gen['prev_hash'], '0' * 64);
    });

    // B7 — buildGenesisBlock throws if ledger already has blocks
    test(
        'B7: buildGenesisBlock throws if ledger already has blocks', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      chain.append({'type': 'day', 'prev_hash': '0' * 64});

      expect(
        () => chain.buildGenesisBlock(
          username: 'u',
          email: 'e@e.com',
          recoverySeedEnc: 'seed',
          identityPubKey: 'pk',
          identitySecretEncFallback: 'fb',
        ),
        throwsA(isA<Exception>()),
      );
    });

    // B8 — buildDayBlock: type=day, correct day_index
    test('B8: buildDayBlock creates block with type=day, correct day_index',
        () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'a' * 64,
            'data': {'title': 'Task 1', 'duration': 1000}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );

      expect(block['type'], 'day');
      expect(block['day_index'], isPositive);
      expect(block['date'], '2025-01-15');
    });

    // B9 — buildDayBlock accepts both pre-hashed {hash,data} and raw dict entries
    test(
        'B9: buildDayBlock accepts both pre-hashed {hash,data} and raw dict entries',
        () {
      final chain = _makeChain();
      final preHashed = {
        'hash': 'b' * 64,
        'data': {'title': 'Pre-hashed', 'duration': 500}
      };
      final rawDict = {'title': 'Raw Dict', 'duration': 300};

      final block = chain.buildDayBlock(
        entries: [preHashed, rawDict],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      expect(block['entries'].length, 2);
    });

    // B10 — buildDayBlock always recomputes entry hash from actual data
    test(
        'B10: buildDayBlock always recomputes entry hash from actual data',
        () {
      final chain = _makeChain();
      // Provide wrong hash — buildDayBlock should recompute correctly
      final entry = {
        'hash': 'wrong-hash-ignored',
        'data': {'title': 'Correct', 'duration': 100}
      };
      final block = chain.buildDayBlock(
        entries: [entry],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      // The hash in the normalized entry should be recomputed
      final storedHash = block['entries'][0]['hash'];
      expect(storedHash, isNot('wrong-hash-ignored'));
      expect(storedHash.length, 64);
    });

    // B11 — buildDayBlock computes day_hash via crypto.seal(sorted JSON)
    test(
        'B11: buildDayBlock computes day_hash via crypto.seal(sorted JSON)',
        () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'c' * 64,
            'data': {'title': 'Task', 'duration': 1000}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      expect(block.containsKey('day_hash'), isTrue);
      expect(block['day_hash'], isNotEmpty);
      expect(block['day_hash'].length, 64);
    });

    // B12 — buildDayBlock adds identity_seal when identitySecret is set
    test(
        'B12: buildDayBlock adds identity_seal when identitySecret is set',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd' * 64,
            'data': {'title': 'Signed', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      expect(block.containsKey('identity_seal'), isTrue);
    });

    // B13 — buildDayBlock omits identity_seal when identitySecret is null
    test(
        'B13: buildDayBlock omits identity_seal when identitySecret is null',
        () {
      final chain = _makeChain(); // no identitySecret
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'e' * 64,
            'data': {'title': 'Unsigned', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      expect(block.containsKey('identity_seal'), isFalse);
    });

    // B14 — buildDayBlock day_index starts at 1 when no prior day blocks exist
    test(
        'B14: buildDayBlock day_index starts at 1 when no prior day blocks exist',
        () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'f' * 64,
            'data': {'title': 'First', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-15',
      );
      expect(block['day_index'], 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: Append & Truncate (11 tests)
  // ═══════════════════════════════════════════════════════════════

  group('C: LedgerChain — Append & Truncate', () {
    // C1 — append adds single block
    test('C1: append adds single block to chain', () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': '1' * 64,
            'data': {'title': 'Block', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block);
      expect(chain.getBlockCount(), 1);
    });

    // C2 — append verifies prev_hash linkage to last block
    test('C2: append verifies prev_hash linkage to last block', () {
      final chain = _makeChain();
      final block1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '2' * 64,
            'data': {'title': 'Task 1', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block1);

      final prevHash = getBlockHash(block1);
      final block2 = chain.buildDayBlock(
        entries: [
          {
            'hash': '3' * 64,
            'data': {'title': 'Task 2', 'duration': 200}
          }
        ],
        prevHash: prevHash,
        dateStr: '2025-01-02',
      );
      // Should not throw — prev_hash matches
      chain.append(block2);
      expect(chain.getBlockCount(), 2);
    });

    // C3 — append throws on prev_hash mismatch
    test('C3: append throws on prev_hash mismatch', () {
      final chain = _makeChain();
      final block1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '4' * 64,
            'data': {'title': 'Task 1', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block1);

      // Try appending with wrong prev_hash via appendBlocks (which checks linkage)
      expect(
        () => chain.appendBlocks([
          {
            'type': 'day',
            'prev_hash': 'ff' * 32,
            'date': '2025-01-02',
            'day_index': 2,
            'entries': [],
            'day_hash': 'aa' * 32,
          }
        ]),
        throwsA(isA<Exception>()),
      );
    });

    // C4 — append succeeds when chain is empty (first block)
    test('C4: append succeeds when chain is empty (first block)', () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': '5' * 64,
            'data': {'title': 'First', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      // Should not throw — no linkage check for first block
      expect(() => chain.append(block), returnsNormally);
    });

    // C5 — appendBlocks adds multiple blocks with linkage verification
    test(
        'C5: appendBlocks adds multiple blocks with linkage verification', () {
      final chain = _makeChain();

      // First block
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '6a' * 32,
            'data': {'title': 'A', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      // Chain two new blocks internally
      final b1Hash = getBlockHash(b1);
      final b2 = chain.buildDayBlock(
        entries: [
          {
            'hash': '6b' * 32,
            'data': {'title': 'B', 'duration': 200}
          }
        ],
        prevHash: b1Hash,
        dateStr: '2025-01-02',
      );
      final b2Hash = getBlockHash(b2);
      final b3 = chain.buildDayBlock(
        entries: [
          {
            'hash': '6c' * 32,
            'data': {'title': 'C', 'duration': 300}
          }
        ],
        prevHash: b2Hash,
        dateStr: '2025-01-03',
      );

      chain.appendBlocks([b2, b3]);
      expect(chain.getBlockCount(), 3);
    });

    // C6 — appendBlocks verifies linkage between all blocks in batch
    test(
        'C6: appendBlocks verifies linkage between all blocks in batch', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '7a' * 32,
            'data': {'title': 'First', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      final b1Hash = getBlockHash(b1);
      final b2 = chain.buildDayBlock(
        entries: [
          {
            'hash': '7b' * 32,
            'data': {'title': 'Second', 'duration': 200}
          }
        ],
        prevHash: b1Hash,
        dateStr: '2025-01-02',
      );

      // b3 has wrong prev_hash (doesn't link to b2)
      final b3 = {
        'type': 'day',
        'prev_hash': 'ff' * 32,
        'date': '2025-01-03',
        'day_index': 3,
        'entries': [],
        'day_hash': 'dd' * 32,
      };

      expect(
        () => chain.appendBlocks([b2, b3]),
        throwsA(isA<Exception>()),
      );
    });

    // C7 — appendBlocks verifies bridge linkage (last existing → first new)
    test(
        'C7: appendBlocks verifies bridge linkage (last existing → first new)',
        () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '8a' * 32,
            'data': {'title': 'First', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      // b2 has wrong prev_hash (doesn't link to b1)
      final wrongChain = _makeChain();
      final b2 = wrongChain.buildDayBlock(
        entries: [
          {
            'hash': '8b' * 32,
            'data': {'title': 'Second', 'duration': 200}
          }
        ],
        prevHash: '0' * 64, // should link to b1's hash
        dateStr: '2025-01-02',
      );

      expect(
        () => chain.appendBlocks([b2]),
        throwsA(isA<Exception>()),
      );
    });

    // C8 — appendBlocks throws on internal linkage mismatch
    test('C8: appendBlocks throws on internal linkage mismatch', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '9a' * 32,
            'data': {'title': 'First', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      // batch where internal linkage is broken
      expect(
        () => chain.appendBlocks([
          {
            'type': 'day',
            'prev_hash': getBlockHash(b1),
            'date': '2025-01-02',
            'day_index': 2,
            'entries': [],
            'day_hash': 'aa' * 32,
          },
          {
            'type': 'day',
            'prev_hash': 'ff' * 32, // doesn't link to previous
            'date': '2025-01-03',
            'day_index': 3,
            'entries': [],
            'day_hash': 'bb' * 32,
          },
        ]),
        throwsA(isA<Exception>()),
      );
    });

    // C9 — truncate(removeCount) removes N blocks from end
    test('C9: truncate(removeCount) removes N blocks from end', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '10a' * 31,
            'data': {'title': 'A', 'duration': 1}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      final b1Hash = getBlockHash(b1);
      final b2 = chain.buildDayBlock(
        entries: [
          {
            'hash': '10b' * 31,
            'data': {'title': 'B', 'duration': 2}
          }
        ],
        prevHash: b1Hash,
        dateStr: '2025-01-02',
      );
      chain.append(b2);

      expect(chain.getBlockCount(), 2);
      final removed = chain.truncate(1);
      expect(removed.length, 1);
      expect(chain.getBlockCount(), 1);
    });

    // C10 — truncate preserves at minimum block 0
    test('C10: truncate preserves at minimum block 0 (genesis)', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '11a' * 31,
            'data': {'title': 'Only', 'duration': 1}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      // Try to truncate more blocks than exist
      final removed = chain.truncate(5);
      expect(chain.getBlockCount(), 1); // genesis/preserved
    });

    // C11 — truncate returns removed blocks in order
    test('C11: truncate returns removed blocks in order', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': '12a' * 31,
            'data': {'title': 'A', 'duration': 1}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      final b1Hash = getBlockHash(b1);
      final b2 = chain.buildDayBlock(
        entries: [
          {
            'hash': '12b' * 31,
            'data': {'title': 'B', 'duration': 2}
          }
        ],
        prevHash: b1Hash,
        dateStr: '2025-01-02',
      );
      chain.append(b2);

      final removed = chain.truncate(2);
      expect(removed.length, 2);
      expect(removed[0]['date'], '2025-01-01');
      expect(removed[1]['date'], '2025-01-02');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: Verification (16 tests)
  // ═══════════════════════════════════════════════════════════════

  group('D: LedgerChain — Verification', () {
    // D1 — verify returns true for empty chain
    test('D1: verify returns true for empty chain', () {
      final chain = _makeChain();
      expect(chain.verify(), isTrue);
    });

    // D2 — verify returns true for valid chain (genesis + days)
    test('D2: verify returns true for valid chain (genesis + days)', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);

      final genHash = getBlockHash(gen);
      final day = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd2x' * 21 + 'ab',
            'data': {
              'title': 'Task',
              'duration': 100,
              'content_hash':
                  'd3333484214768c3104d254354fecb61f065179beaa524d21b8072d773ddd213',
            }
          }
        ],
        prevHash: genHash,
        dateStr: '2025-01-15',
      );
      chain.append(day);

      expect(chain.verify(), isTrue);
    });

    // D3 — verify returns false when prev_hash is wrong
    test('D3: verify returns false when prev_hash is wrong', () {
      final chain = _makeChain();
      // Directly inject block with broken linkage
      final block1 = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd3a' * 21 + 'ab',
            'data': {'title': 'A', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block1);

      // Inject a broken block via the store directly (bypass append linkage check)
      final brokenBlock = {
        'type': 'day',
        'prev_hash': 'ff' * 32, // wrong
        'date': '2025-01-02',
        'day_index': 2,
        'entries': [],
        'day_hash': 'aa' * 32,
      };
      // Use a separate store to inject the bad block
      final rawStore = _FakeLedgerStore();
      rawStore.appendBlocks([block1, brokenBlock]);
      final brokenChain = LedgerChain(
        crypto: (_makeChain()).crypto,
        store: rawStore,
      );
      expect(brokenChain.verify(), isFalse);
    });

    // D4 — verify returns false when block seal is invalid
    test('D4: verify returns false when block seal is invalid', () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd4x' * 21 + 'ab',
            'data': {'title': 'Task', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      // Tamper with the block seal
      block['day_hash'] = 'ff' * 32;
      chain.append(block);
      expect(chain.verify(), isFalse);
    });

    // D5 — verify returns false when identity_seal is wrong
    test(
        'D5: verify returns false when identity_seal is wrong (with identitySecret)',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      // Tamper with identity_seal
      gen['identity_seal'] = 'ff' * 32;
      chain.append(gen);
      expect(chain.verify(), isFalse);
    });

    // D6 — verify passes when identitySecret is null (skips identity check)
    test(
        'D6: verify passes when identitySecret is null (skips identity check)',
        () {
      final chain = _makeChain(); // no identity secret
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      // Tamper with (absent) identity_seal — should still pass since identitySecret is null
      gen['identity_seal'] = 'ff' * 32;
      chain.append(gen);
      // Verification should skip identity check when identitySecret is null
      expect(chain.verify(), isTrue);
    });

    // D7 — verify returns false when entry hash doesn't match entry data
    test(
        'D7: verify returns false when entry hash doesn\'t match entry data',
        () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'wrong-hash-that-doesnt-match-data-xxxxxxxxxxxxxxxxxxxxxx',
            'data': {'title': 'Real Data', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block);
      expect(chain.verify(), isFalse);
    });

    // D8 — verify: content_hash required at format_version >= 0.4.0
    test(
        'D8: verify content_hash required at format_version >= 0.4.0', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
        formatVersion: '0.4.0',
      );
      chain.append(gen);

      final genHash = getBlockHash(gen);
      // Day block entry without content_hash
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd8x' * 21 + 'ab',
            'data': {'title': 'No Content Hash', 'duration': 100}
          }
        ],
        prevHash: genHash,
        dateStr: '2025-01-15',
      );
      chain.append(block);
      // Should fail because content_hash is missing at v0.4.0+
      expect(chain.verify(), isFalse);
    });

    // D9 — verify: content_hash optional at format_version < 0.4.0
    test(
        'D9: verify content_hash optional at format_version < 0.4.0', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
        formatVersion: '0.3.0',
      );
      chain.append(gen);

      final genHash = getBlockHash(gen);
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd9x' * 21 + 'ab',
            'data': {'title': 'Legacy', 'duration': 100}
          }
        ],
        prevHash: genHash,
        dateStr: '2025-01-15',
      );
      chain.append(block);
      // Should pass — content_hash not required pre-0.4.0
      expect(chain.verify(), isTrue);
    });

    // D10 — verify returns false when content_hash is wrong at v0.4.0+
    test(
        'D10: verify returns false when content_hash is wrong at v0.4.0+',
        () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
        formatVersion: '0.4.0',
      );
      chain.append(gen);

      final genHash = getBlockHash(gen);
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd10' + 'x' * 60,
            'data': {
              'title': 'Task',
              'duration': 100,
              'content_hash': 'ff' * 32, // wrong content_hash
            }
          }
        ],
        prevHash: genHash,
        dateStr: '2025-01-15',
      );
      chain.append(block);
      expect(chain.verify(), isFalse);
    });

    // D11 — verifyBlock(index) checks single block validity
    test('D11: verifyBlock(index) checks single block validity', () {
      final chain = _makeChain();
      final block = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd11' + 'x' * 60,
            'data': {'title': 'Valid', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(block);
      expect(chain.verifyBlock(0), isTrue);
    });

    // D12 — verifyBlock(0) checks genesis type + seal
    test('D12: verifyBlock(0) checks genesis type + seal', () {
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);
      expect(chain.verifyBlock(0), isTrue);
    });

    // D13 — verifyBlock checks prev_hash linkage for non-zero blocks
    test(
        'D13: verifyBlock checks prev_hash linkage for non-zero blocks', () {
      final chain = _makeChain();
      final b1 = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd13a' + 'x' * 59,
            'data': {'title': 'A', 'duration': 100}
          }
        ],
        prevHash: '0' * 64,
        dateStr: '2025-01-01',
      );
      chain.append(b1);

      final b1Hash = getBlockHash(b1);
      final b2 = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd13b' + 'x' * 59,
            'data': {'title': 'B', 'duration': 200}
          }
        ],
        prevHash: b1Hash,
        dateStr: '2025-01-02',
      );
      chain.append(b2);

      expect(chain.verifyBlock(1), isTrue);
    });

    // D14 — verifyBlock returns false for out-of-range index
    test('D14: verifyBlock returns false for out-of-range index', () {
      final chain = _makeChain();
      expect(chain.verifyBlock(999), isFalse);
    });

    // D15 — _hashKeyForBlock returns correct key for each block type
    test(
        'D15: _hashKeyForBlock returns correct key for each block type', () {
      // Tested indirectly via getBlockHash in helpers_test.
      // This test verifies the internal resolution matches getBlockHash output.
      // We can verify behavior through the public API.
      expect(getBlockHash({'type': 'genesis', 'block_hash': 'abc'}), 'abc');
      expect(getBlockHash({'type': 'day', 'day_hash': 'def'}), 'def');
      expect(
          getBlockHash({'type': 'month_summary', 'month_hash': 'ghi'}), 'ghi');
      expect(
          getBlockHash({'type': 'year_summary', 'year_hash': 'jkl'}), 'jkl');
    });

    // D16 — verify: key_version invariant: day block kv must not exceed genesis kv
    test(
        'D16: verify key_version invariant: day block kv must not exceed genesis kv',
        () {
      // This is tested at the chain level — if we inject blocks with
      // inconsistent key_versions, verify should fail.
      final chain = _makeChain(identitySecretHex: identitySecret);
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      // Genesis implicitly has key_version from the buildGenesisBlock defaults
      chain.append(gen);

      // Build a day block with explicit key_version > genesis
      // Since genesis gets key_version=1 by default, kv=99 should trigger failure
      final genHash = getBlockHash(gen);
      final day = chain.buildDayBlock(
        entries: [
          {
            'hash': 'd16' + 'x' * 60,
            'data': {'title': 'Bad KV', 'duration': 100}
          }
        ],
        prevHash: genHash,
        dateStr: '2025-01-15',
        keyVersion: 99,
      );
      chain.append(day);
      expect(chain.verify(), isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: Seal & Identity (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('E: LedgerChain — Seal & Identity', () {
    // E1 — computeSeal: deterministic HMAC-SHA256 of sorted JSON
    test(
        'E1: computeSeal produces deterministic HMAC-SHA256 of sorted JSON',
        () {
      final chain = _makeChain();
      final data = {'b': 2, 'a': 1};
      final seal1 = chain.computeSeal(data);
      final seal2 = chain.computeSeal(data);
      expect(seal1, seal2); // deterministic
      expect(seal1.length, 64); // HMAC-SHA256
    });

    // E2 — computeSeal output changes when data changes
    test('E2: computeSeal output changes when data changes', () {
      final chain = _makeChain();
      final seal1 = chain.computeSeal({'a': 1});
      final seal2 = chain.computeSeal({'a': 2});
      expect(seal1, isNot(seal2));
    });

    // E3 — verifySeal returns true for valid seal
    test('E3: verifySeal returns true for valid seal', () {
      final chain = _makeChain();
      final data = {'x': 'test', 'y': 42};
      final seal = chain.computeSeal(data);
      expect(chain.verifySeal(data, seal), isTrue);
    });

    // E4 — verifySeal returns false for wrong seal
    test('E4: verifySeal returns false for wrong seal', () {
      final chain = _makeChain();
      final data = {'x': 'test'};
      expect(chain.verifySeal(data, 'ff' * 32), isFalse);
    });

    // E5 — verifySeal tries compact JSON fallback
    test(
        'E5: verifySeal tries compact JSON fallback (cross-platform compat)',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final chain = LedgerChain(crypto: crypto, store: _FakeLedgerStore());

      final data = {'b': 2, 'a': 1};
      // Compute compact seal (sort_keys=true, no indent — legacy format)
      final compactSeal = crypto.seal('{"a":1,"b":2}', mkHex);
      // verifySeal with indent2-serialized data should still match via fallback
      expect(chain.verifySeal(data, compactSeal), isTrue);
    });

    // E6 — computeIdentityMac returns hex string when identitySecret is set
    test(
        'E6: computeIdentityMac returns hex string when identitySecret is set',
        () {
      final chain =
          _makeChain(identitySecretHex: identitySecret);
      final mac = chain.computeIdentityMac('test data', identitySecret);
      expect(mac, isNotNull);
      expect(mac, isNotEmpty);
      expect(mac!.length, 64); // HMAC-SHA256 = 64 hex chars
    });

    // E7 — verifyIdentityMac returns true for valid MAC
    test('E7: verifyIdentityMac returns true for valid MAC', () {
      final chain =
          _makeChain(identitySecretHex: identitySecret);
      final data = 'identity test data';
      final mac = chain.computeIdentityMac(data, identitySecret)!;
      expect(chain.verifyIdentityMac(data, mac, identitySecret), isTrue);
    });

    // E8 — verifyIdentityMac returns false for wrong MAC
    test('E8: verifyIdentityMac returns false for wrong MAC', () {
      final chain =
          _makeChain(identitySecretHex: identitySecret);
      final data = 'identity test data';
      expect(
          chain.verifyIdentityMac(data, 'ff' * 32, identitySecret), isFalse);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: Seal Format Verification — 9 tests
  // Phase 1 Groups A: _verifyBlockSeal → verifySeal() 3-way fallback
  // Covers: S1–S9 (Phase 1 A1–A9)
  // ═══════════════════════════════════════════════════════════════

  group('S: Seal Format Verification (3-way fallback)', () {
    // ── Helpers for constructing blocks with specific seal formats ──

    /// Compute a seal using a specific JSON serializer.
    String _sealWith(CryptoService crypto, Map<String, dynamic> data,
        String Function(Map<String, dynamic>) serializer) {
      return crypto.seal(serializer(data), mkHex);
    }

    /// Build genesis block payload (same fields _sealBlock extracts).
    Map<String, dynamic> _genesisPayload() => {
          'type': 'genesis',
          'day_index': 0,
          'date': '2025-01-01',
          'prev_hash': '0' * 64,
          'entries': <Map<String, dynamic>>[],
        };

    /// Build day block payload.
    Map<String, dynamic> _dayPayload(String prevHash) => {
          'type': 'day',
          'day_index': 1,
          'date': '2025-01-02',
          'prev_hash': prevHash,
          'entries': <Map<String, dynamic>>[],
        };

    // S1 — Genesis sealed with jsonSort (Flutter canonical) verifies
    test('S1 genesis sealed with jsonSort (Flutter) → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      final payload = _genesisPayload();
      final seal = _sealWith(crypto, payload, jsonSort);
      store.appendBlocks([
        {
          ...payload,
          'block_hash': seal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      expect(chain.verify(), isTrue,
          reason: 'jsonSort-sealed genesis must verify');
    });

    // S2 — Genesis sealed with Python indent2 format verifies
    test('S2 genesis sealed with Python indent2 → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      final payload = _genesisPayload();
      final seal = _sealWith(crypto, payload, jsonSortIndent2);
      store.appendBlocks([
        {
          ...payload,
          'block_hash': seal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      expect(chain.verify(), isTrue,
          reason: 'Python indent2-sealed genesis must verify after RC1 fix');
    });

    // S3 — Genesis sealed with JS no-space compact format verifies
    test('S3 genesis sealed with JS no-space format → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      final payload = _genesisPayload();
      final noSpaceJson = jsonEncodeSortedNoSpaces(payload);
      final seal = crypto.seal(noSpaceJson, mkHex);
      store.appendBlocks([
        {
          ...payload,
          'block_hash': seal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      expect(chain.verify(), isTrue,
          reason: 'JS no-space-sealed genesis must verify after RC1 fix');
    });

    // S4 — Day block sealed with jsonSort verifies
    test('S4 day block sealed with jsonSort → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      // Genesis first
      final genPayload = _genesisPayload();
      final genSeal = _sealWith(crypto, genPayload, jsonSort);
      store.appendBlocks([
        {
          ...genPayload,
          'block_hash': genSeal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      // Day block
      final dayPayload = _dayPayload(genSeal);
      final daySeal = _sealWith(crypto, dayPayload, jsonSort);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue);
    });

    // S5 — Day block sealed with Python indent2 verifies
    test('S5 day block sealed with Python indent2 → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      // Genesis (jsonSort for simplicity)
      final genPayload = _genesisPayload();
      final genSeal = _sealWith(crypto, genPayload, jsonSort);
      store.appendBlocks([
        {
          ...genPayload,
          'block_hash': genSeal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      // Day block sealed with Python indent2 format
      final dayPayload = _dayPayload(genSeal);
      final daySeal = _sealWith(crypto, dayPayload, jsonSortIndent2);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'Python indent2-sealed day block must verify');
    });

    // S6 — Day block sealed with JS no-space format verifies
    test('S6 day block sealed with JS no-space → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      // Genesis (jsonSort for simplicity)
      final genPayload = _genesisPayload();
      final genSeal = _sealWith(crypto, genPayload, jsonSort);
      store.appendBlocks([
        {
          ...genPayload,
          'block_hash': genSeal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      // Day block sealed with JS no-space format
      final dayPayload = _dayPayload(genSeal);
      final noSpaceJson = jsonEncodeSortedNoSpaces(dayPayload);
      final daySeal = crypto.seal(noSpaceJson, mkHex);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'JS no-space-sealed day block must verify');
    });

    // S7 — Block with intentionally wrong seal → verify fails
    test('S7 block with wrong seal → verify returns false', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      final payload = _genesisPayload();
      store.appendBlocks([
        {
          ...payload,
          'block_hash': 'ff' * 32, // wrong seal
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'u',
          'email': 'e@e.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      expect(chain.verify(), isFalse,
          reason: 'Wrong seal must be detected — fallback must not false-match');
    });

    // S8 — Block with empty seal → verify fails
    test('S8 block with empty block_hash → verify returns false', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      store.appendBlocks([
        {
          'type': 'genesis',
          'day_index': 0,
          'date': '2025-01-01',
          'prev_hash': '0' * 64,
          'entries': <Map<String, dynamic>>[],
          'block_hash': '', // empty seal
          'format_version': '0.4.0',
          'key_version': 1,
        }
      ]);

      expect(chain.verify(), isFalse,
          reason: 'Empty block_hash is always invalid');
    });

    // S9 — Block with missing type → verify fails
    test('S9 block with missing type → verify returns false', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      store.appendBlocks([
        {
          'day_index': 0,
          'date': '2025-01-01',
          'prev_hash': '0' * 64,
          'entries': <Map<String, dynamic>>[],
          'block_hash': 'aa' * 32,
          'format_version': '0.4.0',
          'key_version': 1,
        }
      ]);

      expect(chain.verify(), isFalse,
          reason: 'Missing type field must fail — cannot determine hash key');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group K: verify() end-to-end — 6 tests
  // Phase 1 Group K: cross-client chain integrity
  // ═══════════════════════════════════════════════════════════════

  group('K: verify() end-to-end (cross-client chain integrity)', () {
    // K1 — Locally-created chain (genesis only) → verify returns true
    test('K1 genesis-only chain → verify returns true', () {
      final chain = _makeChain();
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);
      expect(chain.verify(), isTrue);
    });

    // K2 — Locally-created chain with day blocks → verify returns true
    test('K2 genesis + day blocks → verify returns true', () {
      final chain = _makeChain();
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);

      final crypto = chain.crypto;
      final data = {'title': 'Task', 'duration': 60};
      final day = chain.buildDayBlock(
        entries: [
          {
            'data': {
              ...data,
              // 0.4.0 genesis requires a valid content_hash on every entry.
              'content_hash': computeContentHash(data, crypto),
            },
          },
        ],
        prevHash: getBlockHash(gen),
        dateStr: '2025-01-02',
      );
      chain.append(day);
      expect(chain.verify(), isTrue);
    });

    // K3 — After cloud restore (CLI-created blocks) → verify passes
    test('K3 CLI-created blocks (Python indent2 seals) → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      // Simulate CLI-created genesis (Python indent2 seal)
      final genPayload = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
      };
      final genSeal =
          crypto.seal(jsonSortIndent2(genPayload), mkHex);
      store.appendBlocks([
        {
          ...genPayload,
          'block_hash': genSeal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'cli-user',
          'email': 'cli@test.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      // Simulate CLI-created day block (Python indent2 seal)
      const entryData = {'title': 'CLI entry', 'duration': 120};
      final dataWithHash = Map<String, dynamic>.from(entryData)
        ..['content_hash'] = computeContentHash(entryData, crypto);
      final dayPayload = <String, dynamic>{
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genSeal,
        'entries': [
          {'hash': computeEntryHash(dataWithHash), 'data': dataWithHash}
        ],
      };
      final daySeal =
          crypto.seal(jsonSortIndent2(dayPayload), mkHex);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'CLI-created blocks (Python indent2) must verify on Flutter');
    });

    // K4 — After cloud restore (Web-created blocks) → verify passes
    test('K4 Web-created blocks (JS no-space seals) → verify passes', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
    final chain = LedgerChain(crypto: crypto, store: store);

      // Simulate Web-created genesis (JS no-space seal)
      final genPayload = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
      };
      final noSpaceGen =
          jsonEncodeSortedNoSpaces(genPayload);
      final genSeal = crypto.seal(noSpaceGen, mkHex);
      store.appendBlocks([
        {
          ...genPayload,
          'block_hash': genSeal,
          'format_version': '0.4.0',
          'key_version': 1,
          'username': 'web-user',
          'email': 'web@test.com',
          'recovery_seed_enc': 'seed',
          'identity_pub_key': 'pk',
          'identity_secret_enc_fallback': 'fb',
        }
      ]);

      // Simulate Web-created day block (JS no-space seal)
      const entryData = {'title': 'Web entry', 'duration': 90};
      final dataWithHash = Map<String, dynamic>.from(entryData)
        ..['content_hash'] = computeContentHash(entryData, crypto);
      final dayPayload = <String, dynamic>{
        'type': 'day',
        'day_index': 1,
        'date': '2025-01-02',
        'prev_hash': genSeal,
        'entries': [
          {'hash': computeEntryHash(dataWithHash), 'data': dataWithHash}
        ],
      };
      final noSpaceDay =
          jsonEncodeSortedNoSpaces(dayPayload);
      final daySeal = crypto.seal(noSpaceDay, mkHex);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'Web-created blocks (JS no-space) must verify on Flutter');
    });

    // K5 — Chain with tampered seal → verify returns false
    test('K5 tampered seal in day block → verify returns false', () {
      final chain = _makeChain();
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);

      final day = chain.buildDayBlock(
        entries: [
          {'title': 'Task', 'duration': 60}
        ],
        prevHash: getBlockHash(gen),
        dateStr: '2025-01-02',
      );
      // Tamper with the day_hash
      day['day_hash'] = 'ff' * 32;
      chain.append(day);

      expect(chain.verify(), isFalse,
          reason: 'Tampered block seal must be detected');
    });

    // K6 — Chain with broken prev_hash linkage → verify returns false
    test('K6 broken prev_hash linkage → verify returns false', () {
      final chain = _makeChain();
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      chain.append(gen);

      // Manually insert a block with wrong prev_hash (bypass normal append)
      final store = chain.store as _FakeLedgerStore;
      store.appendBlocks([
        {
          'type': 'day',
          'day_index': 1,
          'date': '2025-01-02',
          'prev_hash': 'ff' * 32, // wrong — should link to genesis
          'entries': <Map<String, dynamic>>[],
          'day_hash': 'aa' * 32,
          'key_version': 1,
        }
      ]);

      expect(chain.verify(), isFalse,
          reason: 'Broken prev_hash linkage must be detected');
    });
  });
}
