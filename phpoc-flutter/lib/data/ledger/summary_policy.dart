import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/utils/json_utils.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show secretToHex;

/// Abstract policy for inserting summary blocks between day blocks.
abstract class SummaryPolicy {
  final CryptoService crypto;

  const SummaryPolicy({required this.crypto});

  /// Return summary blocks that should be inserted between [prevBlock]
  /// and a new day block for [currentDate] (YYYY-MM-DD).
  List<Map<String, dynamic>> getSummaryBlocks(
    Map<String, dynamic> prevBlock,
    String currentDate,
  );

  /// Resolve the hash key for a block based on its type.
  String getBlockHashForBlock(Map<String, dynamic> block) {
    final type = block['type'] as String?;
    switch (type) {
      case 'genesis':
        return block['block_hash'] as String? ?? '';
      case 'day':
        return block['day_hash'] as String? ?? '';
      case 'month_summary':
        return block['month_hash'] as String? ?? '';
      case 'year_summary':
        return block['year_hash'] as String? ?? '';
      default:
        return '';
    }
  }
}

/// Policy that inserts month_summary and year_summary blocks.
///
/// Inserts:
/// - month_summary when month changes (same year)
/// - year_summary + month_summary on year boundary
class YearMonthSummaryPolicy extends SummaryPolicy {
  final String? identitySecret;
  final String? _identitySecretHex;

  YearMonthSummaryPolicy({
    required super.crypto,
    this.identitySecret,
  }) : _identitySecretHex = secretToHex(identitySecret);

  @override
  List<Map<String, dynamic>> getSummaryBlocks(
    Map<String, dynamic> prevBlock,
    String currentDate,
  ) {
    final summaries = <Map<String, dynamic>>[];

    final prevType = prevBlock['type'] as String? ?? '';
    final prevDateStr = prevBlock['date'] as String? ?? '1970-01-01';

    // Parse dates
    final prevDate = _parseDate(prevDateStr);
    final currDate = _parseDate(currentDate);

    // Resolve effective previous year and month
    int prevYear, prevMon;
    if (prevType == 'month_summary' && prevBlock.containsKey('month')) {
      final monthStr = prevBlock['month'] as String;
      final parts = monthStr.split('-');
      prevYear = int.parse(parts[0]);
      prevMon = int.parse(parts[1]);
    } else {
      prevYear = prevDate.$1;
      prevMon = prevDate.$2;
    }

    final currYear = currDate.$1;
    final currMon = currDate.$2;
    final yearsDiff = currYear - prevYear;

    var prevHash = getBlockHashForBlock(prevBlock);

    // Year boundary: insert year_summary if year changed and prev is not already one
    if (currYear > prevYear && prevType != 'year_summary') {
      final yearBlock = _buildSummary(
        type: 'year_summary',
        prevHash: prevHash,
        year: prevYear,
      );
      summaries.add(yearBlock);
      prevHash = yearBlock['year_hash'] as String;
    }

    // Month changed?
    final monthChanged = currMon != prevMon || yearsDiff > 0;

    if (monthChanged) {
      // Compute the month to summarize (the month just before current)
      final int summarizeYear, summarizeMon;
      if (currMon == 1) {
        summarizeYear = currYear - 1;
        summarizeMon = 12;
      } else {
        summarizeYear = currYear;
        summarizeMon = currMon - 1;
      }

      final monthStr = '$summarizeYear-${summarizeMon.toString().padLeft(2, '0')}';

      // Don't insert month summary if:
      // a) prev is already month_summary for this month, OR
      // b) December + year boundary + year_summary was just inserted
      final isSameMonth = prevType == 'month_summary' &&
          prevBlock['month'] == monthStr;
      final decWithYear = summarizeMon == 12 &&
          yearsDiff > 0 &&
          summaries.any((s) => s['type'] == 'year_summary');

      if (!isSameMonth && !decWithYear) {
        final monthBlock = _buildSummary(
          type: 'month_summary',
          prevHash: prevHash,
          month: monthStr,
        );
        summaries.add(monthBlock);
      }
    }

    return summaries;
  }

  Map<String, dynamic> _buildSummary({
    required String type,
    required String prevHash,
    int? year,
    String? month,
  }) {
    final block = <String, dynamic>{
      'type': type,
      'prev_hash': prevHash,
      'entries': <Map<String, dynamic>>[],
      'date': month != null ? '$month-01' : '$year-01-01',
    };

    // Add type-specific fields before sealing
    if (type == 'year_summary' && year != null) {
      block['year'] = year;
    } else if (type == 'month_summary' && month != null) {
      block['month'] = month;
    }

    // Compute seal over the block
    final hashKey = type == 'year_summary' ? 'year_hash' : 'month_hash';
    final sealData = Map<String, dynamic>.from(block);
    sealData.remove('prev_hash'); // seal should not include prev_hash for cross-verification
    final seal = _computeSeal(sealData);
    block[hashKey] = seal;

    // Identity seal if available
    if (_identitySecretHex != null) {
      final mac = crypto.sign(seal, _identitySecretHex);
      block['identity_seal'] = mac;
    }

    return block;
  }

  String _computeSeal(Map<String, dynamic> data) {
    return crypto.seal(jsonSort(data), crypto.getMasterKey()!);
  }

  /// Parse YYYY-MM-DD → (year, month, day).
  static (int, int, int) _parseDate(String dateStr) {
    final parts = dateStr.split('-');
    return (
      int.parse(parts[0]),
      int.parse(parts[1]),
      int.parse(parts[2]),
    );
  }
}

/// Policy that inserts only year_summary blocks (no month summaries).
class YearOnlySummaryPolicy extends SummaryPolicy {
  final String? identitySecret;
  final String? _identitySecretHex;

  YearOnlySummaryPolicy({
    required super.crypto,
    this.identitySecret,
  }) : _identitySecretHex = secretToHex(identitySecret);

  @override
  List<Map<String, dynamic>> getSummaryBlocks(
    Map<String, dynamic> prevBlock,
    String currentDate,
  ) {
    final prevType = prevBlock['type'] as String;
    final prevDate = prevBlock['date'] as String? ?? '';

    if (prevType == 'year_summary') return [];

    final prevParts = prevDate.split('-');
    final currParts = currentDate.split('-');

    if (prevParts.isEmpty || currParts.isEmpty) return [];

    final prevYear = int.parse(prevParts[0]);
    final currYear = int.parse(currParts[0]);

    if (prevYear >= currYear) return [];

    final block = <String, dynamic>{
      'type': 'year_summary',
      'prev_hash': getBlockHashForBlock(prevBlock),
      'year': prevYear,
      'entries': <Map<String, dynamic>>[],
      'date': '$prevYear-01-01',
    };

    final sealData = Map<String, dynamic>.from(block);
    sealData.remove('prev_hash');
    final seal = crypto.seal(jsonSort(sealData), crypto.getMasterKey()!);
    block['year_hash'] = seal;

    if (_identitySecretHex != null) {
      block['identity_seal'] = crypto.sign(seal, _identitySecretHex);
    }

    return [block];
  }

}

/// Policy that never inserts any summary blocks.
class NoSummaryPolicy extends SummaryPolicy {
  NoSummaryPolicy({required super.crypto});

  @override
  List<Map<String, dynamic>> getSummaryBlocks(
    Map<String, dynamic> prevBlock,
    String currentDate,
  ) {
    return [];
  }
}
