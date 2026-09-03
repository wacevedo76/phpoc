import 'dart:convert';
import 'dart:typed_data';

import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show jsonEncodeSortedNoSpaces;
import 'package:phpoc_flutter/data/sync/transport.dart';

/// Shared test support for the Commonplace remote-sync slice
/// (blueprint: docs/planning/flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md).
///
/// Provides the in-memory block-store fake, the in-memory [HttpTransport]
/// fake, and chain-building / remote-seeding helpers used by:
///   - commonplace_push_service_test.dart   (Group P)
///   - commonplace_pull_service_test.dart   (Group L)
///   - commonplace_reconcile_test.dart      (Group F)
///   - commonplace_sync_e2e_test.dart       (Group R)
///
/// Only depends on code that already exists, so the RED test files fail
/// solely on the not-yet-created Commonplace sync services.

/// Valid 64-char hex master key (32 bytes for AES-128 + HMAC).
const syncTestMkHex =
    'abababababababababababababababababababababababababababababababab';

/// Different master key for wrong-key / leak-nullification tests.
const syncWrongMkHex =
    'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';

/// Canonical R2 path constants (mirrors the to-be-added [StagingPaths] entries).
const commonplaceBlocksPrefix = 'commonplace/blocks/';
const commonplaceHashIndexPath = 'commonplace/hash_index.json';

/// Build the remote block path for a 0-based chain index.
String commonplaceBlockPath(int index) =>
    'commonplace/blocks/${index.toString().padLeft(6, '0')}.json';

/// In-memory block store implementing the block-store contract
/// (`readBlocks`/`appendBlocks`/`truncate`/`getBlockCount`/`getLastBlock`)
/// so a [CommonplaceChain] can operate over it without touching disk.
class FakeCommonplaceStore {
  final List<Map<String, dynamic>> _blocks = [];

  List<Map<String, dynamic>> readBlocks({int start = 0, int? end}) {
    final e = end ?? _blocks.length;
    return _blocks.sublist(start, e);
  }

  void appendBlocks(List<Map<String, dynamic>> blocks) =>
      _blocks.addAll(blocks);

  List<Map<String, dynamic>> truncate(int keepCount) {
    if (keepCount >= _blocks.length) return [];
    final removed = _blocks.sublist(keepCount);
    _blocks.removeRange(keepCount, _blocks.length);
    return removed;
  }

  int getBlockCount() => _blocks.length;

  Map<String, dynamic>? getLastBlock() => _blocks.isEmpty ? null : _blocks.last;
}

/// In-memory [HttpTransport] fake for push/pull unit and E2E tests.
///
/// [store] records every pushed blob (and may be pre-seeded for pull tests).
/// Failure simulation is available via [errorOnPushPath]/[errorOnPullPath]
/// (HTTP status) and [unreachable] (network error).
class FakeSyncTransport implements HttpTransport {
  @override
  final String baseUrl;

  @override
  final String apiKey;

  /// All pushed data keyed by path. Pre-seed for pull tests.
  final Map<String, Uint8List> store = {};

  /// Total number of [push] calls (for concurrency-serialization tests).
  int pushCount = 0;

  /// Paths that should fail with the given HTTP status on [push].
  final Map<String, int> errorOnPushPath = {};

  /// Paths that should fail with the given HTTP status on [pull].
  final Map<String, int> errorOnPullPath = {};

  /// If true, every operation throws a network error.
  bool unreachable = false;

  FakeSyncTransport({
    this.baseUrl = 'https://test-worker.example.com',
    this.apiKey = 'fake-api-key',
  });

  @override
  Future<Uint8List?> pull(String path) async {
    if (unreachable) throw HttpTransportException('Network unreachable', 0);
    final status = errorOnPullPath[path];
    if (status != null) {
      throw HttpTransportException('HTTP $status on pull($path)', status);
    }
    return store[path]; // null on missing = 404
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    if (unreachable) throw HttpTransportException('Network unreachable', 0);
    final status = errorOnPushPath[path];
    if (status != null) {
      throw HttpTransportException('HTTP $status on push($path)', status);
    }
    pushCount++;
    store[path] = data;
  }

  @override
  Future<List<String>> listFiles(String prefix) async {
    if (unreachable) throw HttpTransportException('Network unreachable', 0);
    return store.keys
        .where((k) => k.startsWith(prefix))
        .map((k) => k.substring(prefix.length))
        .toList();
  }

  @override
  Future<void> healthCheck() async {
    if (unreachable) throw HttpTransportException('Network unreachable', 0);
  }

  @override
  Future<void> delete(String path) async {
    store.remove(path);
  }
}

/// Create an initialized [CryptoService], optionally caching [mkHex].
CryptoService initCrypto({String? mkHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  if (mkHex != null) crypto.setMasterKey(mkHex);
  return crypto;
}

/// A raw (unsealed) Commonplace entry dict for [CommonplaceChain.buildDayBlock].
Map<String, dynamic> rawEntry({
  String title = 'Title',
  String entry = 'Passage',
  String date = '2026-08-31',
  int ts = 1754000000000,
}) =>
    <String, dynamic>{
      'type': 'commonplace',
      'timestamp_ms': ts,
      'date': date,
      'title': title,
      'entry': entry,
      'tags': <String>['tag'],
    };

/// Build a Commonplace chain with a genesis block and [dayBlocks] sealed day
/// blocks (one entry each, on distinct dates so they group into distinct
/// blocks). Genesis params are fixed so separately-built chains share an
/// identical genesis hash (genesis sealing is deterministic — no random IV).
CommonplaceChain buildChain(
  CryptoService crypto, {
  FakeCommonplaceStore? store,
  int dayBlocks = 1,
}) {
  final s = store ?? FakeCommonplaceStore();
  final chain = CommonplaceChain(crypto: crypto, store: s);
  chain.buildGenesis(
    username: 'sync-user',
    email: 'sync@example.com',
    recoverySeedEnc: 'seed-enc',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  );
  var prevHash = chain.getBlockHashFor(chain.getLastBlock()!);
  for (var i = 0; i < dayBlocks; i++) {
    final dateStr = '2026-08-${(31 - i).toString().padLeft(2, '0')}';
    final block = chain.buildDayBlock(
      entries: [
        rawEntry(
          title: 'Title $i',
          entry: 'Passage $i',
          date: dateStr,
          ts: 1754000000000 + i,
        ),
      ],
      prevHash: prevHash,
      dateStr: dateStr,
    );
    chain.append(block);
    prevHash = chain.getBlockHashFor(block);
  }
  return chain;
}

/// Seed a fake transport with the obfuscated blocks + plaintext hash index of
/// [chain], exactly as [CommonplacePushService] would write them.
void seedRemoteChain(
  FakeSyncTransport t,
  CommonplaceChain chain,
  CryptoService crypto,
  String mkHex,
) {
  final blocks = chain.readAll();
  final hashes = blocks.map((b) => chain.getBlockHashFor(b)).toList();
  t.store[commonplaceHashIndexPath] =
      Uint8List.fromList(utf8.encode(jsonEncode(hashes)));
  for (var i = 0; i < blocks.length; i++) {
    final serialized = jsonEncodeSortedNoSpaces(blocks[i]);
    t.store[commonplaceBlockPath(i)] = crypto.obfuscateBlob(serialized, mkHex);
  }
}
