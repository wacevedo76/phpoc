/// Shared date/time/duration formatters used by screens.
///
/// All methods are static to allow import-and-use without instantiation.
class FormatUtils {
  FormatUtils._(); // no instances

  /// Three-letter month abbreviations (Jan–Dec).
  static const monthAbbr = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /// Parse a YYYY-MM-DD date string into (year, month, day).
  /// Returns null if the string is not a valid ISO date.
  static ({int year, int month, int day})? parseIsoDateStr(String dateStr) {
    final parts = dateStr.split('-');
    if (parts.length != 3) return null;
    final y = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    final d = int.tryParse(parts[2]);
    if (y == null || m == null || d == null) return null;
    return (year: y, month: m, day: d);
  }

  /// Full date-time: "2026-07-21 15:37"
  static String dateTime(DateTime dt) =>
      '${dt.year}-${dt.month.toString().padLeft(2, '0')}-'
      '${dt.day.toString().padLeft(2, '0')} '
      '${dt.hour.toString().padLeft(2, '0')}:'
      '${dt.minute.toString().padLeft(2, '0')}';

  /// Human-friendly date: "Jul 21, 2026"
  static String date(DateTime dt) =>
      '${monthAbbr[dt.month - 1]} ${dt.day}, ${dt.year}';

  /// Short numeric date: "7/21/2026"
  static String dateShort(DateTime dt) =>
      '${dt.month}/${dt.day}/${dt.year}';

  /// Time only: "15:37"
  static String time(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:'
      '${dt.minute.toString().padLeft(2, '0')}';

  /// Compact duration: "2h 15m" or "45m"
  static String duration(Duration d) {
    final hours = d.inHours;
    final minutes = d.inMinutes.remainder(60);
    if (hours > 0) return '${hours}h ${minutes}m';
    return '${minutes}m';
  }

  /// Convert epoch seconds to ISO date string (YYYY-MM-DD).
  /// Returns "1970-01-01" for epochSeconds ≤ 0.
  static String epochToIsoDate(int epochSeconds) {
    if (epochSeconds <= 0) return '1970-01-01';
    final dt = DateTime.fromMillisecondsSinceEpoch(
      epochSeconds * 1000,
      isUtc: true,
    );
    return '${dt.year.toString().padLeft(4, '0')}'
        '-${dt.month.toString().padLeft(2, '0')}'
        '-${dt.day.toString().padLeft(2, '0')}';
  }

  /// Convert epoch milliseconds to ISO date string (YYYY-MM-DD).
  /// Returns "unknown" for null, "1970-01-01" for 0 or negative.
  static String epochToDateStr(int? epochMs) {
    if (epochMs == null) return 'unknown';
    if (epochMs <= 0) return '1970-01-01';
    final dt = DateTime.fromMillisecondsSinceEpoch(epochMs, isUtc: true);
    return '${dt.year.toString().padLeft(4, '0')}'
        '-${dt.month.toString().padLeft(2, '0')}'
        '-${dt.day.toString().padLeft(2, '0')}';
  }
}
