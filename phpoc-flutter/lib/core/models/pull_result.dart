/// Result of a [LedgerPullService.pullAll()] operation.
class PullResult {
  /// Whether all blocks were pulled and imported successfully.
  final bool success;

  /// Number of blocks successfully pulled and deobfuscated.
  final int blocksPulled;

  /// Number of staging entries seeded from pulled blocks.
  final int entriesStaged;

  /// Block indices that failed to pull (empty on full success).
  final List<int> failedBlocks;

  /// Error messages for each failure (empty on full success).
  final List<String> errors;

  const PullResult({
    required this.success,
    required this.blocksPulled,
    this.entriesStaged = 0,
    this.failedBlocks = const [],
    this.errors = const [],
  });

  /// Convenience factory for a completely successful pull.
  factory PullResult.ok({
    required int blocksPulled,
    int entriesStaged = 0,
  }) =>
      PullResult(
        success: true,
        blocksPulled: blocksPulled,
        entriesStaged: entriesStaged,
      );

  /// Convenience factory for a failed pull.
  factory PullResult.failure({
    int blocksPulled = 0,
    int entriesStaged = 0,
    List<int> failedBlocks = const [],
    List<String> errors = const [],
  }) =>
      PullResult(
        success: false,
        blocksPulled: blocksPulled,
        entriesStaged: entriesStaged,
        failedBlocks: failedBlocks,
        errors: errors,
      );

  @override
  String toString() =>
      'PullResult(success: $success, pulled: $blocksPulled'
      ', staged: $entriesStaged'
      '${failedBlocks.isNotEmpty ? ", failed: $failedBlocks" : ""}'
      '${errors.isNotEmpty ? ", errors: $errors" : ""})';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PullResult &&
          success == other.success &&
          blocksPulled == other.blocksPulled &&
          entriesStaged == other.entriesStaged &&
          _listEquals(failedBlocks, other.failedBlocks) &&
          _listEquals(errors, other.errors);

  @override
  int get hashCode => Object.hash(
        success,
        blocksPulled,
        entriesStaged,
        Object.hashAll(failedBlocks),
        Object.hashAll(errors),
      );

  static bool _listEquals(List<dynamic> a, List<dynamic> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}
