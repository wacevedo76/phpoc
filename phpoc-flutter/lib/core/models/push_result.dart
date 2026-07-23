/// Result of a [LedgerPushService.pushAll()] operation.
class PushResult {
  /// Whether all blocks and index files were pushed successfully.
  final bool success;

  /// Number of blocks successfully pushed.
  final int blocksPushed;

  /// Block indices that failed to push (empty on full success).
  final List<int> failedBlocks;

  /// Error messages for each failure (empty on full success).
  final List<String> errors;

  const PushResult({
    required this.success,
    required this.blocksPushed,
    this.failedBlocks = const [],
    this.errors = const [],
  });

  /// Convenience factory for a completely successful push.
  factory PushResult.ok(int blocksPushed) => PushResult(
        success: true,
        blocksPushed: blocksPushed,
      );

  /// Convenience factory for a failed push.
  factory PushResult.failure({
    int blocksPushed = 0,
    List<int> failedBlocks = const [],
    List<String> errors = const [],
  }) =>
      PushResult(
        success: false,
        blocksPushed: blocksPushed,
        failedBlocks: failedBlocks,
        errors: errors,
      );

  @override
  String toString() => 'PushResult(success: $success, pushed: $blocksPushed'
      '${failedBlocks.isNotEmpty ? ", failed: $failedBlocks" : ""}'
      '${errors.isNotEmpty ? ", errors: $errors" : ""})';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PushResult &&
          success == other.success &&
          blocksPushed == other.blocksPushed &&
          _listEquals(failedBlocks, other.failedBlocks) &&
          _listEquals(errors, other.errors);

  @override
  int get hashCode => Object.hash(
        success,
        blocksPushed,
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
