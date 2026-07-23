import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/summary_policy.dart';

/// SummaryPolicy — Phase 2 (RED) test suite.
///
/// All 17 assertions from docs/planning/flutter/LEDGER_PHASE1.md Groups L–M:
///   Group L: YearMonthSummaryPolicy (14)
///   Group M: Alternative Policies (3)
///
/// Expected: all tests FAIL (RED) because summary_policy.dart does not exist yet.

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

/// Helper to create a CryptoService and YearMonthSummaryPolicy.
SummaryPolicy _makePolicy({String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  return YearMonthSummaryPolicy(
    crypto: crypto,
    identitySecret: identitySecretHex,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group L: YearMonthSummaryPolicy (14 tests)
  // ═══════════════════════════════════════════════════════════════

  group('L: YearMonthSummaryPolicy', () {
    // L1 — getSummaryBlocks returns empty when same month+year as prev
    test(
        'L1: getSummaryBlocks returns empty when same month+year as previous block',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-10',
        'day_hash': 'a' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-03-15');
      expect(summaries, isEmpty);
    });

    // L2 — inserts month_summary when month changes (same year)
    test(
        'L2: getSummaryBlocks inserts month_summary when month changes (same year)',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-31',
        'day_hash': 'b' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-04-01');
      expect(summaries, isNotEmpty);
      expect(summaries.first['type'], 'month_summary');
      expect(summaries.first['month'], '2025-03');
    });

    // L3 — inserts year_summary on year boundary, month_summary suppressed (covered by year)
    test(
        'L3: getSummaryBlocks inserts year_summary on year boundary (Dec month covered by year)',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-31',
        'day_hash': 'c' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-01-01');
      expect(summaries.length, 1);
      expect(summaries[0]['type'], 'year_summary');
      expect(summaries[0]['year'], 2025);
    });

    // L4 — handles cross-year month gap (Dec→Feb skips Jan)
    test(
        'L4: getSummaryBlocks handles cross-year month gap (Dec→Feb skips Jan)',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-15',
        'day_hash': 'd' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-02-01');
      // Should have year_summary(2025) + month_summary(2026-01)
      expect(summaries.length, 2);
      expect(summaries[0]['type'], 'year_summary');
      expect(summaries[1]['type'], 'month_summary');
      expect(summaries[1]['month'], '2026-01');
    });

    // L5 — month_summary has correct month field (YYYY-MM)
    test(
        'L5: getSummaryBlocks month_summary has correct month field (YYYY-MM)',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-07-31',
        'day_hash': 'e' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-08-01');
      expect(summaries.first['type'], 'month_summary');
      expect(summaries.first['month'], '2025-07');
    });

    // L6 — year_summary has correct year field (int)
    test('L6: getSummaryBlocks year_summary has correct year field (int)',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-31',
        'day_hash': 'f' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-01-01');
      expect(summaries[0]['type'], 'year_summary');
      expect(summaries[0]['year'], 2025);
      expect(summaries[0]['year'], isA<int>());
    });

    // L7 — prev_hash of first summary links to previous block
    test(
        'L7: getSummaryBlocks prev_hash of first summary links to previous block',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-31',
        'day_hash': 'abc123' + '0' * 58,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-04-01');
      expect(summaries.first['prev_hash'], 'abc123' + '0' * 58);
    });

    // L8 — on year boundary (Dec→Jan), only year_summary; prev_hash links
    test(
        'L8: getSummaryBlocks year_summary prev_hash links to previous block',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-31',
        'day_hash': 'g' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-01-01');
      expect(summaries.length, 1);

      // Year summary's prev_hash should match previous block's hash
      expect(summaries[0]['prev_hash'], 'g' * 64);
    });

    // L9 — does not insert year_summary if prev is already year_summary
    test(
        'L9: getSummaryBlocks does not insert year_summary if prev is already year_summary',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'year_summary',
        'year': 2025,
        'date': '2026-01-10',
        'year_hash': 'h' * 64,
        'prev_hash': 'x' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-02-01');
      // Should have month_summary for Jan, but no duplicate year_summary
      final hasYearSummary =
          summaries.any((s) => s['type'] == 'year_summary');
      expect(hasYearSummary, isFalse);

      expect(summaries.length, 1);
      expect(summaries.first['type'], 'month_summary');
    });

    // L10 — does not insert month_summary if prev is already same month_summary
    test(
        'L10: getSummaryBlocks does not insert month_summary if prev is already month_summary for same month',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'month_summary',
        'month': '2025-06',
        'date': '2025-07-01',
        'month_hash': 'i' * 64,
        'prev_hash': 'y' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-07-01');
      expect(summaries, isEmpty);
    });

    // L11 — does not insert month summary for December when year summary just inserted
    test(
        'L11: getSummaryBlocks does not insert month summary for December when year summary just inserted',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-20',
        'day_hash': 'j' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-01-15');
      // Should have year_summary(2025), but NOT a month_summary for December (2025-12)
      // because the year summary already covers it
      expect(summaries.length, 1);
      expect(summaries[0]['type'], 'year_summary');
    });

    // L12 — month_summary seal (month_hash) is valid
    test('L12: getSummaryBlocks month_summary seal (month_hash) is valid',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-31',
        'day_hash': 'k' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-04-01');
      final monthBlock = summaries.first;

      expect(monthBlock.containsKey('month_hash'), isTrue);
      expect(monthBlock['month_hash'], isNotEmpty);
      expect(monthBlock['month_hash'].length, 64);
    });

    // L13 — year_summary seal (year_hash) is valid
    test('L13: getSummaryBlocks year_summary seal (year_hash) is valid',
        () {
      final policy = _makePolicy();
      final prevBlock = {
        'type': 'day',
        'date': '2025-12-31',
        'day_hash': 'l' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-01-01');
      final yearBlock = summaries[0];

      expect(yearBlock.containsKey('year_hash'), isTrue);
      expect(yearBlock['year_hash'], isNotEmpty);
      expect(yearBlock['year_hash'].length, 64);
    });

    // L14 — adds identity_seal when identitySecret is set
    test(
        'L14: getSummaryBlocks adds identity_seal when identitySecret is set',
        () {
      final policy = _makePolicy(identitySecretHex: identitySecret);
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-31',
        'day_hash': 'm' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2025-04-01');
      final monthBlock = summaries.first;
      expect(monthBlock.containsKey('identity_seal'), isTrue);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group M: Alternative Policies (3 tests)
  // ═══════════════════════════════════════════════════════════════

  group('M: Alternative Summary Policies', () {
    // M1 — YearOnlySummaryPolicy inserts year_summary but never month_summary
    test(
        'M1: YearOnlySummaryPolicy inserts year_summary but never month_summary',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final policy = YearOnlySummaryPolicy(crypto: crypto);

      // Month boundary within same year → no summaries (year-only mode)
      final prevBlock = {
        'type': 'day',
        'date': '2025-03-31',
        'day_hash': 'n' * 64,
      };
      var summaries =
          policy.getSummaryBlocks(prevBlock, '2025-04-01');
      expect(summaries, isEmpty);

      // Year boundary → year_summary but no month_summary
      final prevBlock2 = {
        'type': 'day',
        'date': '2025-12-31',
        'day_hash': 'o' * 64,
      };
      summaries = policy.getSummaryBlocks(prevBlock2, '2026-01-01');
      expect(summaries.length, 1);
      expect(summaries[0]['type'], 'year_summary');
    });

    // M2 — YearOnlySummaryPolicy does not insert when prev is year_summary
    test(
        'M2: YearOnlySummaryPolicy does not insert when prev is year_summary',
        () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final policy = YearOnlySummaryPolicy(crypto: crypto);

      final prevBlock = {
        'type': 'year_summary',
        'year': 2025,
        'date': '2026-01-05',
        'year_hash': 'p' * 64,
        'prev_hash': 'z' * 64,
      };

      final summaries =
          policy.getSummaryBlocks(prevBlock, '2026-02-01');
      expect(summaries, isEmpty);
    });

    // M3 — NoSummaryPolicy never inserts any summary blocks
    test('M3: NoSummaryPolicy never inserts any summary blocks', () {
      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final policy = NoSummaryPolicy(crypto: crypto);

      // Month boundary
      expect(
        policy.getSummaryBlocks(
            {'type': 'day', 'date': '2025-03-31', 'day_hash': 'q' * 64},
            '2025-04-01'),
        isEmpty,
      );

      // Year boundary
      expect(
        policy.getSummaryBlocks(
            {'type': 'day', 'date': '2025-12-31', 'day_hash': 'r' * 64},
            '2026-01-01'),
        isEmpty,
      );
    });
  });
}
