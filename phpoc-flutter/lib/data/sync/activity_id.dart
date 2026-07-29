import 'dart:math';

/// CSPRNG activity ID generator for row-level staging.
///
/// Produces 10-character alphanumeric IDs (36^10 ≈ 3.6×10^15 space).
/// Uses `Random.secure()` for cryptographic randomness.
class ActivityIdGenerator {
  static const _chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  static const int _length = 10;
  static final _random = Random.secure();
  static final _validPattern = RegExp(r'^[A-Za-z0-9]{10}$');

  /// Generate a 10-character alphanumeric activity ID.
  static String generateActivityId() {
    final codeUnits = List<int>.generate(_length, (_) {
      return _chars.codeUnitAt(_random.nextInt(_chars.length));
    });
    return String.fromCharCodes(codeUnits);
  }

  /// Validate that [id] is a well-formed activity ID.
  static bool isValidActivityId(String? id) {
    if (id == null) return false;
    return _validPattern.hasMatch(id);
  }
}
