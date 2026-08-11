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

/// Fixed canonical DEADBEEF master key used by the cross-client vector fixture
/// `testdata/canonical_seal_vectors.json` (Ph-6), so Flutter's computed seal can
/// be compared byte-for-byte with Python/Web expected_seal values.
const deadbeefMkHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/// Build a month_summary block sealed over the CANONICAL ADR-029a month set
/// `{type, month, date, prev_hash, original_hash}` (the real `month` shape, NOT
/// the old fixture-only `month_index`).
Map<String, dynamic> _sealedMonthSummary({
  required CryptoService crypto,
  required String prevHash,
  String? originalHash,
  String month = '2026-07',
  String Function(Map<String, dynamic>)? serializer,
}) {
  final s = serializer ?? jsonSort;
  final payload = <String, dynamic>{
    'type': 'month_summary',
    'month': month,
    'date': '2026-07',
    'prev_hash': prevHash,
    if (originalHash != null) 'original_hash': originalHash,
  };
  final seal = crypto.seal(s(payload), mkHex);
  return {...payload, 'month_hash': seal, 'key_version': 1};
}

/// Build a year_summary block sealed over the CANONICAL ADR-029a year set
/// `{type, year, date, prev_hash, original_hash}` (real `year` int, NOT `year_index`).
Map<String, dynamic> _sealedYearSummary({
  required CryptoService crypto,
  required String prevHash,
  String? originalHash,
  int year = 2026,
  String Function(Map<String, dynamic>)? serializer,
}) {
  final s = serializer ?? jsonSort;
  final payload = <String, dynamic>{
    'type': 'year_summary',
    'year': year,
    'date': '2026',
    'prev_hash': prevHash,
    if (originalHash != null) 'original_hash': originalHash,
  };
  final seal = crypto.seal(s(payload), mkHex);
  return {...payload, 'year_hash': seal, 'key_version': 1};
}

/// Build a chain instance using the CANONICAL deadbeef MK (Ph-6 vector parity).
LedgerChain _makeDeadbeefChain() {
  final crypto = CryptoService()..initialize();
  crypto.setMasterKey(deadbeefMkHex);
  return LedgerChain(crypto: crypto, store: _FakeLedgerStore());
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

  // ═══════════════════════════════════════════════════════════════
  // Phase 6 — Flutter summary convergence (ADR-029a month/year seal-port).
  // Blueprint: CANONICAL_SEALFIELD_PHASE6_VECTORS_PHASE1.md Group C (C1–C6)
  // + D2. These are RED until chain.dart `_sealFields` becomes per-type and
  // seals month_summary `month` / year_summary `year` (currently it uses a
  // single day-style list {type, day_index, date, prev_hash, entries,
  // original_hash}, so a summary recompute drops month/year → seal mismatch).
  group('E: Flutter month/year summary convergence (Ph-6)', () {
    test('C1 month_summary sealed over {type,month,date,prev_hash} verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: null);
      final month = _sealedMonthSummary(
          crypto: crypto, prevHash: getBlockHash(gen), originalHash: null);
      chain.store.appendBlocks([gen, month]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'genesis must still verify');
      expect(chain.verifyBlock(1), isTrue,
          reason: 'C1: month_summary sealed over canonical month set verifies');
    });

    test('C2 year_summary sealed over {type,year,date,prev_hash} verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: null);
      final year = _sealedYearSummary(
          crypto: crypto, prevHash: getBlockHash(gen), originalHash: null);
      chain.store.appendBlocks([gen, year]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'genesis must still verify');
      expect(chain.verifyBlock(1), isTrue,
          reason: 'C2: year_summary sealed over canonical year set verifies');
    });

    test('C3 month_summary with original_hash present verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: null);
      final month = _sealedMonthSummary(
          crypto: crypto,
          prevHash: getBlockHash(gen),
          originalHash: 'ab' * 32);
      chain.store.appendBlocks([gen, month]);
      expect(chain.verifyBlock(1), isTrue,
          reason: 'C3: month_summary with original_hash in canonical month set verifies');
    });

    test('C4 year_summary with original_hash present verifies', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: null);
      final year = _sealedYearSummary(
          crypto: crypto,
          prevHash: getBlockHash(gen),
          originalHash: 'ab' * 32);
      chain.store.appendBlocks([gen, year]);
      expect(chain.verifyBlock(1), isTrue,
          reason: 'C4: year_summary with original_hash in canonical year set verifies');
    });

    test('C5 Flutter computeSeal reproduces EXACT canonical vector expected_seal', () {
      // Cross-client byte-identity: Flutter's HMAC over the ADR-029a summary
      // fields must equal the fixture expected_seal Python/Web also reproduce.
      final chain = _makeDeadbeefChain();

      // V-month format: {type, month, date, prev_hash}. prev_hash = V-year seal.
      final monthSeal = chain.computeSeal(const {
        'type': 'month_summary',
        'month': '2026-07',
        'date': '2026-07',
        'prev_hash': 'bdf9ee1c7151a35acce71e0824db504fea031aee629bf67d4dfbc8f822ac9142',
      });
      // V-month fixture expected_seal:
      expect(monthSeal, '37ae636d2cd765a25fd5f30e6562c313bfc5a4739c4958a548fdfedbf26d327e',
          reason: 'C5: Flutter month_summary computeSeal == canonical vector expected_seal');

      // V-year format: {type, year, date, prev_hash}. prev_hash = V-genesis seal.
      final yearSeal = chain.computeSeal(const {
        'type': 'year_summary',
        'year': 2026,
        'date': '2026',
        'prev_hash': 'a8eb11d9aa10ae6838e62588304012ad3fccebeb035ce9f94715d11a2898ed0a',
      });
      // V-year fixture expected_seal:
      expect(yearSeal, 'bdf9ee1c7151a35acce71e0824db504fea031aee629bf67d4dfbc8f822ac9142',
          reason: 'C5: Flutter year_summary computeSeal == canonical vector expected_seal');
    });

    test('C6 day/genesis non-summary blocks STILL verify after the per-type split', () {
      final chain = _makeChain();
      final crypto = chain.crypto as CryptoService;
      final gen = _sealedGenesis(crypto: crypto, originalHash: 'ab' * 32);
      final day = _sealedDay(
          crypto: crypto, prevHash: getBlockHash(gen), originalHash: 'cd' * 32);
      chain.store.appendBlocks([gen, day]);
      expect(chain.verifyBlock(0), isTrue,
          reason: 'C6: genesis still verifies');
      expect(chain.verifyBlock(1), isTrue,
          reason: 'C6: day still verifies after per-type refactor');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 6 — divergence detection (Flutter day-style summary bug must FAIL).
  group('F: divergence detection (D2)', () {
    test('D2 Flutter day-style summary seal does NOT equal canonical vector seal', () {
      // The PRE-FIX Flutter sealer uses the day-style list {type, day_index,
      // date, prev_hash, entries, original_hash} for ALL block types. For a
      // month_summary (no day_index/entries), it seals over {type, date,
      // prev_hash} — with NO month — so its seal DIFFERS from the canonical
      // V-month vector seal that includes `month`. This guard catches the bug.
      final chain = _makeDeadbeefChain();
      // Canonical V-month selected fields include `month`:
      final monthInclusiveSeal = chain.computeSeal(const {
        'type': 'month_summary',
        'month': '2026-07',
        'date': '2026-07',
        'prev_hash': 'bdf9ee1c7151a35acce71e0824db504fea031aee629bf67d4dfbc8f822ac9142',
      });
      // Pre-fix day-style sealer DROPS `month` (and never reads it):
      final dayStyleSeal = chain.computeSeal(const {
        'type': 'month_summary',
        'date': '2026-07',
        'prev_hash': 'bdf9ee1c7151a35acce71e0824db504fea031aee629bf67d4dfbc8f822ac9142',
      });
      // The two must differ AND the inclusive one must be the canonical vector seal.
      expect(monthInclusiveSeal, '37ae636d2cd765a25fd5f30e6562c313bfc5a4739c4958a548fdfedbf26d327e',
          reason: 'D2: month-inclusive seal is the canonical V-month expected_seal');
      expect(dayStyleSeal, isNot(monthInclusiveSeal),
          reason: 'D2: day-style (month-less) seal must NOT equal the canonical month seal');
    });
  });
}
