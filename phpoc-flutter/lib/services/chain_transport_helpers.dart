import 'dart:convert';
import 'dart:typed_data';

import '../core/crypto/crypto_service.dart';
import '../core/models/pull_result.dart';
import '../data/sync/transport.dart';

/// One block waiting to be uploaded: its chain [index] (selects the remote
/// `<blocksPrefix>/NNNNNN.json` path), its block [hash] (feeds the plaintext
/// hash index), and its already-serialized JSON (sorted, space-free PHPSPEC).
///
/// Shared by the ledger and Commonplace push services so both sealed chains
/// upload their blocks identically (ADR-029a/031 cross-client parity).
class ChainBlockPayload {
  final int index;
  final String hash;
  final String serialized;

  const ChainBlockPayload({
    required this.index,
    required this.hash,
    required this.serialized,
  });
}

/// Build the remote block-file path for a chain [index] under [blocksPrefix]
/// (e.g. `ledger/blocks/` or `commonplace/blocks/` → `.../000042.json`).
String chainBlockPath(String blocksPrefix, int index) =>
    '$blocksPrefix${index.toString().padLeft(6, '0')}.json';

/// Encode a string as UTF-8 bytes for transport.
Uint8List textBytes(String s) => Uint8List.fromList(utf8.encode(s));

/// Push each [payloads] blob to `<blocksPrefix>/NNNNNN.json` (obfuscated with
/// [mkHex]) and then a plaintext `<hashIndexPath>` JSON array of the pushed
/// block hashes in chain order.
///
/// Shared by [LedgerPushService] and [CommonplacePushService] so both
/// serialize + upload their sealed chains consistently. A block's
/// [ChainBlockPayload.index] (not its list position) selects the remote
/// filename, so callers may push chain maps whose keys differ from their
/// sort/order.
///
/// Returns `(blocksPushed, failedIndices, errors, firstHashPrefix)`.
Future<(int, List<int>, List<String>, String?)> pushChainPayloads({
  required CryptoService crypto,
  required HttpTransport transport,
  required String mkHex,
  required String blocksPrefix,
  required String hashIndexPath,
  required String hashIndexErrorLabel,
  required List<ChainBlockPayload> payloads,
}) async {
  int pushedCount = 0;
  final failedBlocks = <int>[];
  final errors = <String>[];
  final blockHashes = <String>[];

  for (final payload in payloads) {
    final obfuscated = crypto.obfuscateBlob(payload.serialized, mkHex);
    final path = chainBlockPath(blocksPrefix, payload.index);
    try {
      await transport.push(path, obfuscated);
      pushedCount++;
      blockHashes.add(payload.hash);
    } catch (e) {
      failedBlocks.add(payload.index);
      errors.add(e.toString());
    }
  }

  // Push the plaintext hash index (block hashes in chain order).
  try {
    await transport.push(
      hashIndexPath,
      textBytes(jsonEncode(blockHashes)),
    );
  } catch (e) {
    errors.add('Failed to push $hashIndexErrorLabel: $e');
  }

  return (
    pushedCount,
    failedBlocks,
    errors,
    blockHashes.isNotEmpty ? blockHashes.first : null,
  );
}

/// Freshness detector shared by [LedgerPullService] and
/// [CommonplacePullService] (ADR-030/031 D5 append-only rule).
///
/// Fetches the plaintext `<hashIndexPath>` and compares its length against
/// [localBlockCount]:
///   * remote absent/empty or not greater → 0 fresh blocks;
///   * remote greater → the number of new blocks available.
///
/// A network/auth failure or a missing/empty index is treated as "no change"
/// (fail-safe) so a freshness hiccup never fails an ownership handoff.
Future<PullResult> pullRemoteHasMore({
  required HttpTransport transport,
  required String hashIndexPath,
  required int localBlockCount,
}) async {
  List<dynamic> hashIndex;
  try {
    final raw = await transport.pull(hashIndexPath);
    if (raw == null) {
      return PullResult.ok(blocksPulled: 0);
    }
    hashIndex = jsonDecode(utf8.decode(raw)) as List<dynamic>;
  } catch (_) {
    // Network or auth failure: don't fail; report no change.
    return PullResult.ok(blocksPulled: 0);
  }
  if (hashIndex.isEmpty) {
    return PullResult.ok(blocksPulled: 0);
  }

  final remoteCount = hashIndex.length;
  final freshCount = remoteCount - localBlockCount;
  if (freshCount <= 0) {
    return PullResult.ok(blocksPulled: 0);
  }
  return PullResult.ok(blocksPulled: freshCount);
}
