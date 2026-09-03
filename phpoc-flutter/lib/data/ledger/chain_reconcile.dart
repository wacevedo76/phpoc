/// Shared append-only chain-merge core (ADR-029/029a/030/031), used by both
/// `SyncService.reconcileRemoteLedger` and
/// `CommonplaceChain.reconcileRemoteChain`.
///
/// This is a **pure function** — no I/O, no instance state — so the two sealed
/// chains (activity ledger + Commonplace book) share one reconciliation
/// implementation instead of diverging (D9). Callers supply:
///
///   * [local] — the local chain read as block maps (`chain.readAll()`);
///   * [remoteBlocks] — the remote chain blocks to merge;
///   * [blockHash] — the per-type hash resolver (`getBlockHash` /
///     `getBlockHashFor`);
///   * [genesisType] — the chain's genesis block type;
///   * [appendBlocks] — appends a list of block maps to the local chain.
///
/// Semantics (preserved exactly from the original implementations):
///   * a remote block identical (same hash) to the local one is skipped;
///   * a remote tail that bridges the last local block is appended in order;
///   * same index / different hash, a non-bridging tip, or a non-genesis-first
///     block on an empty chain is reported as a conflict and **never written**
///     (a stale device never clobbers the remote canonical chain).
({List<int> conflictedIndices, int appended}) reconcileChainCore({
  required List<Map<String, dynamic>> local,
  required List<Map<String, dynamic>> remoteBlocks,
  required String Function(Map<String, dynamic>) blockHash,
  required String genesisType,
  required void Function(List<Map<String, dynamic>>) appendBlocks,
}) {
  final conflicted = <int>[];
  var appended = 0;

  for (var i = 0; i < remoteBlocks.length; i++) {
    final remote = remoteBlocks[i];
    if (i < local.length) {
      // Same ordinal exists locally: skip if identical, else conflict.
      if (blockHash(local[i]) == blockHash(remote)) continue;
      conflicted.add(i);
      return (conflictedIndices: conflicted, appended: appended);
    }

    // Remote block extends beyond the local tail.
    final toAppend = remoteBlocks.sublist(i);
    if (i == 0) {
      // No local blocks at all — only a genesis can start a chain.
      if (toAppend.first['type'] != genesisType) {
        conflicted.add(0);
        return (conflictedIndices: conflicted, appended: appended);
      }
      appendBlocks(toAppend);
      appended = toAppend.length;
      break;
    }

    // The introduced remote block must bridge to the last local block;
    // otherwise the remote fork diverged earlier → conflict, no write.
    final expectedPrev = blockHash(local[i - 1]);
    final actualPrev = remote['prev_hash'] as String? ?? '';
    if (expectedPrev.isNotEmpty && actualPrev != expectedPrev) {
      conflicted.add(i);
      return (conflictedIndices: conflicted, appended: appended);
    }
    appendBlocks(toAppend);
    appended = toAppend.length;
    break;
  }

  return (conflictedIndices: conflicted, appended: appended);
}
