import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/chain.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';
import 'package:phpoc_flutter/data/ledger/summary_policy.dart';

/// Flutter Ledger Verify & Commit Fix — Phase 2 (RED) test suite.
///
/// All 12 assertions from docs/planning/FLUTTER_LEDGER_VERIFY_FIX_PHASE1.md:
///   Group A: Commit validation — empty-title/tags encryption (3)
///   Group B: commit() integration on date-less legacy chain (3)
///   Group C: Full-chain verify() with valid 0.4.0 content (3)
///   Group D: Regression guards (3)
///
/// These target the 6 pre-existing failures S1–S6:
///   S1–S3 (K2/K3/K4 verify content-hash), S4 (F15 empty-title encrypt),
///   S5/S6 (AE2/AE4 date-less commit summary).
///
/// Expected: Group A & B fail (RED). Groups C & D are positive/guard tests
/// that document the correct 0.4.0 fixture form and protect already-GREEN
/// behavior, so they pass (GREEN) from the start.

// ── In-memory store fakes ───────────────────────────────────────

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

class _FakeIndexStore {
  Map<String, dynamic>? _data;

  Map<String, dynamic>? readIndex() => _data;
  void writeIndex(Map<String, dynamic>? data) => _data = data;
}

class _FakeStagingStore {
  final List<Map<String, dynamic>> _entries = [];

  List<Map<String, dynamic>> readEntries() => List.from(_entries);
  void writeEntries(List<Map<String, dynamic>> entries) {
    _entries.clear();
    _entries.addAll(entries);
  }
}

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Helper to create a fresh LedgerChain with an in-memory store.
LedgerChain _makeChain({String? identitySecretHex}) {
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

/// Helper to create a fresh LedgerEngine with in-memory stores.
LedgerEngine _makeEngine({String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);

  final store = _FakeLedgerStore();
  final indexStore = _FakeIndexStore();
  final stagingStore = _FakeStagingStore();

  return LedgerEngine(
    crypto: crypto,
    store: store,
    indexStore: indexStore,
    stagingStore: stagingStore,
    identitySecret: identitySecretHex,
  );
}

/// Create a test entry map for commit.
Map<String, dynamic> _makeEntry({
  required String title,
  int startEpoch = 1700000000000,
  int duration = 3600000,
  int? endEpoch,
  bool hasEncryptedFields = false,
  String? comment,
  List<String>? tags,
}) {
  return {
    'title': title,
    'start_epoch': startEpoch,
    'duration': duration,
    'end_epoch': endEpoch,
    'has_encrypted_fields': hasEncryptedFields,
    'comment': comment ?? '',
    'tags': tags ?? <String>[],
    'metadata': <String, dynamic>{},
    'pauses': <Map<String, dynamic>>[],
  };
}

/// Build a minimal genesis block (defaults to format_version 0.4.0) with a
/// validly-sealed `block_hash` so the chain stays `verify()`-able.
///
/// The seal is computed over the canonical ADR-029a genesis seal fields that
/// are present (`type`, `prev_hash`, `entries`), matching `chain.verify()`.
/// [crypto] is required; pass the engine's crypto instance.
Map<String, dynamic> _buildGenesis({
  String formatVersion = '0.4.0',
  required CryptoService crypto,
}) {
  final blockHash = crypto.seal(
    jsonSort({
      'type': 'genesis',
      'prev_hash': '0' * 64,
      'entries': <Map<String, dynamic>>[],
    }),
    mkHex,
  );
  return {
    'type': 'genesis',
    'block_hash': blockHash,
    'prev_hash': '0' * 64,
    'key_version': 1,
    'format_version': formatVersion,
    'entries': <Map<String, dynamic>>[],
    'username': 'testuser',
    'email': 'test@test.com',
    'recovery_seed_enc': 'seed',
    'identity_pub_key': 'pk',
    'identity_secret_enc_fallback': 'fb',
  };
}

/// Wrap an entry frame with a valid 0.4.0 content_hash for [data].
///
/// Reuses the live algorithm (`computeContentHash`) so the resulting entry
/// is 0.4.0-valid and verifies through `chain.verify()`.
Map<String, dynamic> _wrapEntry(
  Map<String, dynamic> data,
  CryptoService crypto,
) {
  final dataWithHash = Map<String, dynamic>.from(data);
  dataWithHash['content_hash'] = computeContentHash(data, crypto);
  return {
    'hash': computeEntryHash(dataWithHash),
    'data': dataWithHash,
  };
}

/// Build a date-less day block (simulating the `_blockToMap`
/// reconstruction that lost the `date` field).
///
/// The `day_hash` is a valid ADR-029a seal over the present (date-less) seal
/// fields `{type, prev_hash, entries}`, so the reconstructed block still
/// verifies — matching what a real entries-only reconstruction would reseal.
Map<String, dynamic> _buildDayBlockNoDate({
  required String prevHash,
  required List<Map<String, dynamic>> entries,
  required CryptoService crypto,
  int keyVersion = 1,
}) {
  final dayHash = crypto.seal(
    jsonSort({
      'type': 'day',
      'prev_hash': prevHash,
      'entries': entries,
    }),
    mkHex,
  );
  return {
    'type': 'day',
    'day_hash': dayHash,
    'prev_hash': prevHash,
    'key_version': keyVersion,
    'entries': entries,
    // 'date' deliberately omitted to simulate reconstruction bug
  };
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group A: Commit validation — empty-title/tags encryption (S4) — 3 tests
  // ═══════════════════════════════════════════════════════════════
  group('A: LedgerEngine commit — empty-title/tags encryption', () {
    // A1 — commit encrypts empty title (→ title_enc) when encrypted=true
    test(
        'A1: commit encrypts empty title (→ title_enc present) when '
        'has_encrypted_fields=true', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final gen = engine.chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.chain.append(gen);

      // Empty title with has_encrypted_fields=true must NOT be rejected;
      // it must be encrypted into title_enc.
      engine.commit([
        {
          'title': '',
          'start_epoch': 1700000000000,
          'duration': 1000,
          'has_encrypted_fields': true,
          'tags': <String>[],
          'comment': '',
          'metadata': <String, dynamic>{},
          'pauses': <Map<String, dynamic>>[],
        },
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      expect(entryData.containsKey('title_enc'), isTrue,
          reason: 'empty title must be encrypted to title_enc under '
              'has_encrypted_fields=true (F15 contract)');
      expect(entryData.containsKey('title'), isFalse,
          reason: 'plaintext title must be removed');
    });

    // A2 — commit encrypts empty tags (→ tags_enc present) when encrypted=true
    test(
        'A2: commit encrypts empty tags (→ tags_enc present) when '
        'has_encrypted_fields=true', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final gen = engine.chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.chain.append(gen);

      engine.commit([
        {
          'title': '',
          'start_epoch': 1700000000000,
          'duration': 1000,
          'has_encrypted_fields': true,
          'tags': <String>[],
          'comment': '',
          'metadata': <String, dynamic>{},
          'pauses': <Map<String, dynamic>>[],
        },
      ]);

      final blocks = engine.chain.readAll();
      final entryData = blocks.last['entries'][0]['data'];
      expect(entryData.containsKey('tags_enc'), isTrue,
          reason: 'empty tags must be encrypted to tags_enc (F15 contract)');
      expect(entryData.containsKey('tags'), isFalse,
          reason: 'plaintext tags must be removed');
    });

    // A3 — commit still rejects non-string / whitespace-only title
    test(
        'A3: commit still rejects non-string / whitespace-only title '
        '(validation preserved)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final gen = engine.chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.chain.append(gen);

      // Non-string title must still be rejected.
      expect(
        () => engine.commit([
          {
            'title': 12345,
            'start_epoch': 1700000000000,
            'duration': 1000,
            'metadata': <String, dynamic>{},
            'pauses': <Map<String, dynamic>>[],
          },
        ]),
        throwsA(isA<Exception>()),
        reason: 'non-string title must still be rejected');

      // Whitespace-only title must still be rejected (not over-loosened).
      expect(
        () => engine.commit([
          {
            'title': '   ',
            'start_epoch': 1700000000000,
            'duration': 1000,
            'metadata': <String, dynamic>{},
            'pauses': <Map<String, dynamic>>[],
          },
        ]),
        throwsA(isA<Exception>()),
        reason: 'whitespace-only title must still be rejected');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group B: commit() integration on date-less legacy chain (S5/S6) — 3 tests
  // ═══════════════════════════════════════════════════════════════
  group('B: LedgerEngine commit — date-less legacy chain', () {
    // B1 — commit does not insert a duplicate month_summary
    test(
        'B1: commit does not insert duplicate month_summary for a '
        'date-less (reconstructed) prev day', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final crypto = engine.crypto;
      engine.chain.store.appendBlocks([_buildGenesis(crypto: engine.crypto)]);

      // Add a date-less previous day block already sitting in the chain.
      final prevDay = _buildDayBlockNoDate(
        prevHash: _buildGenesis(crypto: engine.crypto)['block_hash'],
        entries: [
          _wrapEntry({'title': 'Old', 'duration': 3600000}, crypto),
        ],
        crypto: crypto,
      );
      engine.chain.store.appendBlocks([prevDay]);
      final before = engine.getBlockCount();

      // Commit a new entry for the following day.
      engine.commit([
        _makeEntry(
          title: 'New',
          startEpoch: 1750867200000, // 2025-06-25
          duration: 2000,
        ),
      ]);

      final after = engine.getBlockCount();
      // Exactly one new block appended (the day block). A duplicate
      // month_summary fabricated for the missing date would add extra.
      expect(after, lessThanOrEqualTo(before + 1),
          reason: 'a date-less prev day must not trigger a duplicate '
              'fabricated month_summary block');
    });

    // B2 — chain.verify() returns true after committing around date-less prev
    test(
        'B2: chain verifies after committing around a date-less prev day', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final crypto = engine.crypto;
      engine.chain.store.appendBlocks([_buildGenesis(crypto: engine.crypto)]);

      // Date-less prev day with a valid 0.4.0 entry (so the pre-commit
      // chain is otherwise healthy — isolating the commit() integration bug).
      final prevDay = _buildDayBlockNoDate(
        prevHash: _buildGenesis(crypto: engine.crypto)['block_hash'],
        entries: [
          _wrapEntry({'title': 'Old', 'duration': 3600000}, crypto),
        ],
        crypto: crypto,
      );
      engine.chain.store.appendBlocks([prevDay]);

      // Commit across the "missing" date window so the summary policy runs.
      engine.commit([
        _makeEntry(
          title: 'New',
          startEpoch: 1750867200000, // 2025-06-25
          duration: 2000,
        ),
      ]);

      expect(engine.verify(), isTrue,
          reason: 'committing around a date-less reconstructed prev day '
              'must leave the chain verify()-able (AE2/E2 bug)');
    });

    // B3 — multiple commits across a month boundary on reconstructed chain
    test(
        'B3: multiple commits across a month boundary on a reconstructed '
        '(date-less) chain stay verify()-able', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final crypto = engine.crypto;
      engine.chain.store.appendBlocks([_buildGenesis(crypto: engine.crypto)]);

      // Date-less prev day block reconstructed from entries-only data_enc.
      engine.chain.store.appendBlocks([
        _buildDayBlockNoDate(
          prevHash: _buildGenesis(crypto: engine.crypto)['block_hash'],
          entries: [
            _wrapEntry({'title': 'Old', 'duration': 3600000}, crypto),
          ],
          crypto: crypto,
        ),
      ]);

      // Commit #1: entry in January.
      engine.commit([
        _makeEntry(
          title: 'January',
          startEpoch: 1736899200000, // 2025-01-15
          duration: 1000,
        ),
      ]);

      // Commit #2: entry in February (cross-month boundary) — this is
      // where the summary policy runs against the date-less prev block.
      engine.commit([
        _makeEntry(
          title: 'February',
          startEpoch: 1738368000000, // 2025-02-01
          duration: 2000,
        ),
      ]);

      expect(engine.verify(), isTrue,
          reason: 'a reconstructed date-less chain must remain '
              'verify()-able after multiple commits (AE4 bug)');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group C: Full-chain verify() with valid 0.4.0 content (S1–S3) — 3 tests
  // ═══════════════════════════════════════════════════════════════
  group('C: chain.verify() positive 0.4.0 content-hash', () {
    // C1 — day block with valid content_hash + 0.4.0 genesis verifies
    test(
        'C1: day block with valid content_hash (+) and 0.4.0 genesis '
        'verifies through chain.verify()', () {
      final chain = _makeChain();
      final crypto = chain.crypto;
      final gen = chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
        formatVersion: '0.4.0',
      );
      chain.append(gen);

      const data = {'title': 'Valid Task', 'duration': 100};
      final dataWithHash = Map<String, dynamic>.from(data)
        ..['content_hash'] = computeContentHash(data, crypto);

      final day = chain.buildDayBlock(
        entries: [
          {
            'data': dataWithHash,
          },
        ],
        prevHash: getBlockHash(gen),
        dateStr: '2025-01-02',
      );
      chain.append(day);

      expect(chain.verify(), isTrue,
          reason: 'a 0.4.0 day block with a valid content_hash proves the '
              'content-hash invariant is satisfiable (fixes S1/K2)');
    });

    // C2 — CLI-style block (indent2 seal, valid content_hash) verifies
    test(
        'C2: CLI-style block (indent2 seal, valid content_hash) '
        'verifies through chain.verify()', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
      final chain = LedgerChain(crypto: crypto, store: store);

      // Genesis (Python indent2 seal).
      final genPayload = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
      };
      final genSeal = crypto.seal(jsonSortIndent2(genPayload), mkHex);
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

      // CLI day block (indent2 seal) with a valid 0.4.0 content_hash entry.
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
      final daySeal = crypto.seal(jsonSortIndent2(dayPayload), mkHex);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'a CLI-created (indent2-sealed) day block with a valid '
              '0.4.0 content_hash must verify on Flutter (fixes S2/K3)');
    });

    // C3 — Web-style block (no-space seal, valid content_hash) verifies
    test(
        'C3: Web-style block (no-space seal, valid content_hash) '
        'verifies through chain.verify()', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final store = _FakeLedgerStore();
      final chain = LedgerChain(crypto: crypto, store: store);

      // Genesis (JS no-space seal).
      final genPayload = <String, dynamic>{
        'type': 'genesis',
        'day_index': 0,
        'date': '2025-01-01',
        'prev_hash': '0' * 64,
        'entries': <Map<String, dynamic>>[],
      };
      final genSeal = crypto.seal(jsonEncodeSortedNoSpaces(genPayload), mkHex);
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

      // Web day block (no-space seal) with a valid 0.4.0 content_hash entry.
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
      final daySeal =
          crypto.seal(jsonEncodeSortedNoSpaces(dayPayload), mkHex);
      store.appendBlocks([
        {...dayPayload, 'day_hash': daySeal, 'key_version': 1}
      ]);

      expect(chain.verify(), isTrue,
          reason: 'a Web-created (no-space-sealed) day block with a valid '
              '0.4.0 content_hash must verify on Flutter (fixes S3/K4)');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: Regression guards — 3 tests
  // ═══════════════════════════════════════════════════════════════
  group('D: Regression guards', () {
    // D1 — summary policy null/sentinel date handling still GREEN
    test(
        'D1: getSummaryBlocks handles missing / 1970-01-01 date without '
        'issuing dozens of spurious summaries', () {
      final crypto = CryptoService()..initialize();
      crypto.setMasterKey(mkHex);
      final policy = YearMonthSummaryPolicy(crypto: crypto);

      // Missing date.
      final missing = policy.getSummaryBlocks(
          {'type': 'day', 'day_hash': 's' * 64}, '2025-03-15');
      expect(missing.length, lessThanOrEqualTo(2),
          reason: 'missing date must not fabricate 55 years of summaries');

      // Sentinel date.
      final sentinel = policy.getSummaryBlocks(
          {'type': 'day', 'date': '1970-01-01', 'day_hash': 't' * 64},
          '2026-06-20');
      expect(sentinel.length, lessThanOrEqualTo(2),
          reason: '1970-01-01 sentinel must not fabricate summaries');

      // Explicit null must not crash.
      List<Map<String, dynamic>> nullResult;
      try {
        nullResult = policy.getSummaryBlocks(
            {'type': 'day', 'day_hash': 'u' * 64, 'date': null}, '2025-06-01');
      } catch (e) {
        fail('getSummaryBlocks must not crash on null date: $e');
      }
      expect(nullResult.length, lessThanOrEqualTo(2),
          reason: 'null date must be handled gracefully');
    });

    // D2 — non-empty-title encryption still works (commit-path guard)
    test(
        'D2: non-empty title still encrypted under has_encrypted_fields=true',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      final gen = engine.chain.buildGenesisBlock(
        username: 'u',
        email: 'e@e.com',
        recoverySeedEnc: 'seed',
        identityPubKey: 'pk',
        identitySecretEncFallback: 'fb',
      );
      engine.chain.append(gen);

      engine.commit([
        _makeEntry(
          title: 'Non-empty', duration: 1000, hasEncryptedFields: true),
      ]);

      final data = engine.chain.readAll().last['entries'][0]['data'];
      expect(data.containsKey('title'), isFalse);
      expect(data.containsKey('title_enc'), isTrue);
    });

    // D3 — tamper detection still GREEN (verify-path guard)
    test(
        'D3: tampered day block seal → chain.verify() returns false', () {
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
          {
            'title': 'Task',
            'duration': 60,
            'content_hash': '11' * 32,
          }
        ],
        prevHash: getBlockHash(gen),
        dateStr: '2025-01-02',
      );
      day['day_hash'] = 'ff' * 32; // tamper
      chain.append(day);

      expect(chain.verify(), isFalse,
          reason: 'tampered block seal must still be detected');
    });
  });
}
