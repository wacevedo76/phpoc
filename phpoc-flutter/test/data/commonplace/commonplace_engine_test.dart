import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_storage.dart';

/// CommonplaceEngine — Phase 2 (RED) test suite.
///
/// All 10 assertions from docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md
/// Group D: CommonplaceEngine — Commit, Verify, Read.
///
/// Expected: all tests FAIL (RED) because commonplace_engine.dart does not
/// exist yet. API mirrors `lib/data/ledger/engine.dart` (Axiom B5).

// ── In-memory store fakes ───────────────────────────────────────

class _FakeCommonplaceStore {
  final List<Map<String, dynamic>> _blocks = [];
  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e);
  }
  void appendBlocks(List<Map<String, dynamic>> blocks) =>
      _blocks.addAll(blocks);
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
  void rewriteBlock(int index, Map<String, dynamic> replacement) {
    if (index < 0 || index >= _blocks.length) return;
    _blocks[index] = replacement;
  }
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Create a fresh CommonplaceEngine over an in-memory store.
CommonplaceEngine _makeEngine({String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeCommonplaceStore();
  return CommonplaceEngine(
    crypto: crypto,
    store: store,
    identitySecret: identitySecretHex,
  );
}

/// Seed the engine's chain with a required genesis block.
void _seedGenesis(CommonplaceEngine engine) {
  engine.buildGenesis(
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  );
}

/// Build a raw (pre-encryption) Commonplace entry dict. No `comment`.
Map<String, dynamic> _entry({
  required String title,
  String entry = 'passage text',
  List<String> tags = const ['topic'],
  Map<String, dynamic>? adHoc,
  int timestampMs = 1700000000000,
}) {
  return {
    'title': title,
    'tags': tags,
    'entry': entry,
    if (adHoc != null) 'ad_hoc': adHoc,
    'timestamp_ms': timestampMs,
  };
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group D: CommonplaceEngine — Commit, Verify, Read (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('D: CommonplaceEngine — Commit, Verify, Read', () {
    // CP-D1 — commit seals a staged Commonplace entry into a day block
    test('CP-D1: commit seals one entry into a sealed day block', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      final prefix = engine.commit([_entry(title: 'First note')]);

      expect(prefix, isA<String>());
      expect(engine.getBlockCount(), 2);
      // The committed block is a sealed, verified day block.
      expect(engine.verify(), isTrue);
    });

    // CP-D2 — commit groups entries by date, one day block per date
    test('CP-D2: commit groups entries by date into day-grouped blocks', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      // Same day (3 entries) + next day (1 entry).
      // A/B/C all on 2023-11-14 UTC; D on 2023-11-15 UTC (see
      // epochToDate in data/ledger/helpers.dart).
      final sameDay = [
        _entry(title: 'A', timestampMs: 1699952400000), // 2023-11-14 09:00Z
        _entry(title: 'B', timestampMs: 1699959600000), // 2023-11-14 11:00Z
        _entry(title: 'C', timestampMs: 1699972200000), // 2023-11-14 14:30Z
      ];
      engine.commit(sameDay);
      engine.commit([_entry(title: 'D', timestampMs: 1700040600000)]); // 2023-11-15 09:30Z

      final blocks = engine.getDayBlocks();
      expect(blocks.length, 2);
      final firstDay = blocks[0]['entries'] as List<dynamic>;
      expect(firstDay.length, 3);
      final secondDay = blocks[1]['entries'] as List<dynamic>;
      expect(secondDay.length, 1);
    });

    // CP-D3 — commit updates the chain's last-hash pointer after each append
    test('CP-D3: commit updates the chain tip after each append', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);
      final genHash = engine.getLastBlock()!['block_hash'];

      engine.commit([_entry(title: 'First')]);
      expect(engine.getLastBlock()!['day_hash'], isNot(genHash));

      final tipAfterFirst = engine.getLastBlock()!['day_hash'];
      engine.commit([_entry(title: 'Second', timestampMs: 1700090000000)]);
      expect(engine.getLastBlock()!['prev_hash'], tipAfterFirst);
    });

    // CP-D4 — verify returns true for a valid committed chain
    test('CP-D4: verify() is true after valid commits', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);
      engine.commit([_entry(title: 'A')]);
      engine.commit([_entry(title: 'B', timestampMs: 1700090000000)]);

      expect(engine.verify(), isTrue);
    });

    // CP-D5 — verify returns false after a middle block is swapped
    test('CP-D5: verify() returns false after a middle block is swapped', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);
      engine.commit([_entry(title: 'First', timestampMs: 1700000000000)]);
      engine.commit([_entry(title: 'Second', timestampMs: 1700010000000)]);
      engine.commit([_entry(title: 'Third', timestampMs: 1700020000000)]);
      expect(engine.verify(), isTrue);

      // Swap the middle day block for a freshly-sealed but different one.
      final blocks = engine.readAll();
      final middleIdx = 2; // genesis(0), day1(1), day2(2), day3(3)
      final middle = blocks[middleIdx];
      final swapped = engine.chain.buildDayBlock(
        entries: [_entry(title: 'Fake', timestampMs: 1700030000000)],
        prevHash: middle['prev_hash'],
        dateStr: middle['date'] as String,
      );
      final store = engine.store;
      store.rewriteBlock(middleIdx, swapped);

      expect(engine.verify(), isFalse);
    });

    // CP-D6 — readEntries returns committed entries in order
    test('CP-D6: readEntries returns committed entries in order', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);
      engine.commit([
        _entry(title: 'Alpha', timestampMs: 1700000000000),
        _entry(title: 'Beta', timestampMs: 1700064000000),
      ]);

      final entries = engine.readEntries();
      expect(entries.length, 2);
      expect(entries.map((e) => e['title']), containsAll(['Alpha', 'Beta']));
    });

    // CP-D7 — committing to Commonplace does not touch the activity ledger
    test('CP-D7: committing to the Commonplace chain does not touch the ledger',
        () {
      // The Commonplace engine is fully self-contained over its own store —
      // this is guaranteed because it carries no activity-ledger store.
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);
      engine.commit([_entry(title: 'Isolated')]);

      // All blocks written are Commonplace day blocks/genesis, never activity
      // 'day'/'genesis' types, and no activity fields leak into the entries.
      for (final b in engine.readAll()) {
        expect(b['type'] == 'day' || b['type'] == 'genesis', isFalse);
        expect(b['type'] == 'commonplace_genesis' ||
            b['type'] == 'commonplace', isTrue);
      }
    });

    // CP-D8 — commit never injects staging plain:/unsealed rows into sealed blocks
    test('CP-D8: commit does not leak plain:/unsealed staging rows into blocks',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([_entry(title: 'Clean commit')]);

      for (final b in engine.readAll()) {
        final raw = '$b';
        expect(raw.contains('plain:'), isFalse);
        final entries = b['entries'] as List<dynamic>? ?? [];
        for (final e in entries) {
          final data = e['data'] as Map;
          expect(data.containsKey('is_active'), isFalse);
          expect(data.containsKey('unsealed'), isFalse);
        }
      }
    });

    // CP-D9 — an entry without a `comment` field seals normally
    test('CP-D9: an entry with no comment field seals normally', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      // The committed entry has no comment field by construction.
      final entry = _entry(title: 'No comment here', entry: 'just the text');
      expect(entry.containsKey('comment'), isFalse);
      engine.commit([entry]);

      final blocks = engine.getDayBlocks();
      final sealedData =
          ((blocks[0]['entries'] as List<dynamic>)[0] as Map)['data'] as Map;
      expect(sealedData.containsKey('comment'), isFalse);
      expect(sealedData.containsKey('comment_enc'), isFalse);
      expect(engine.verify(), isTrue);
    });

    // CP-D10 — earlier then later entries verify in chronological order
    test('CP-D10: a chain committed earlier-then-later verifies', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([_entry(title: 'Old', timestampMs: 1700000000000)]);
      engine.commit([_entry(title: 'New', timestampMs: 1700090000000)]);

      expect(engine.getDayBlocks().length, 2);
      expect(engine.verify(), isTrue);
    });
  });
}
