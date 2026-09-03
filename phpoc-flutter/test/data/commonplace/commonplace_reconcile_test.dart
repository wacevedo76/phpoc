import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_service.dart';
import 'package:phpoc_flutter/services/commonplace_pull_service.dart';

import '../../services/commonplace_sync_test_support.dart';

/// Commonplace freshness + reconcile tests — Group F (7 assertions).
///
/// Blueprint: docs/planning/flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md
///
/// Phase 2 (RED): `CommonplacePullService.pullIfRemoteHasMore` and
/// `CommonplaceService.reconcileRemoteChain` do not exist yet.

void main() {
  group('F: Freshness + append-only reconcile', () {
    test('CPSY-F1: pullIfRemoteHasMore returns 0 when remote hash_index '
        'absent or empty', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());

      final absent = CommonplacePullService(
        crypto: crypto,
        transport: FakeSyncTransport(),
        chain: chain,
      );
      expect(
        (await absent.pullIfRemoteHasMore(localBlockCount: 0)).blocksPulled,
        0,
      );

      final emptyT = FakeSyncTransport();
      emptyT.store[commonplaceHashIndexPath] =
          Uint8List.fromList(utf8.encode('[]'));
      final empty = CommonplacePullService(
        crypto: crypto,
        transport: emptyT,
        chain: chain,
      );
      expect(
        (await empty.pullIfRemoteHasMore(localBlockCount: 0)).blocksPulled,
        0,
      );
    });

    test('CPSY-F2: pullIfRemoteHasMore returns 0 when remote count ≤ local',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1); // 2 blocks
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      expect(
        (await svc.pullIfRemoteHasMore(localBlockCount: 2)).blocksPulled,
        0,
      );
      expect(
        (await svc.pullIfRemoteHasMore(localBlockCount: 5)).blocksPulled,
        0,
      );
    });

    test('CPSY-F3: pullIfRemoteHasMore returns N when remote count > local',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1); // 2 blocks
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      expect(
        (await svc.pullIfRemoteHasMore(localBlockCount: 1)).blocksPulled,
        1,
      );
      expect(
        (await svc.pullIfRemoteHasMore(localBlockCount: 0)).blocksPulled,
        2,
      );
    });

    test('CPSY-F4: reconcileRemoteChain skips identical remote blocks',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final store = FakeCommonplaceStore();
      final localChain = buildChain(crypto, store: store, dayBlocks: 1);
      final service = CommonplaceService(crypto: crypto, store: store);

      // A separately-fetched but byte-identical remote chain.
      final remoteBlocks = localChain
          .readAll()
          .map((b) => jsonDecode(jsonEncode(b)) as Map<String, dynamic>)
          .toList();

      final result = await service.reconcileRemoteChain(remoteBlocks);

      expect(result.appended, 0);
      expect(result.hasConflicts, isFalse);
      expect(localChain.getBlockCount(), 2);
    });

    test('CPSY-F5: reconcileRemoteChain appends a bridging remote tail',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final store = FakeCommonplaceStore();
      final localChain = buildChain(crypto, store: store, dayBlocks: 0); // genesis only
      final service = CommonplaceService(crypto: crypto, store: store);

      // Same genesis + one day block (bridges to the local genesis).
      final remoteChain = buildChain(crypto, dayBlocks: 1);

      final result = await service.reconcileRemoteChain(remoteChain.readAll());

      expect(result.appended, 1);
      expect(result.hasConflicts, isFalse);
      expect(localChain.getBlockCount(), 2);
    });

    test(
        'CPSY-F6: same index, different hash → conflict reported, never '
        'written', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final store = FakeCommonplaceStore();
      final localChain = buildChain(crypto, store: store, dayBlocks: 1); // "Title 0"
      final service = CommonplaceService(crypto: crypto, store: store);

      // Remote: same genesis, but a divergent day block at index 1.
      final remoteChain = buildChain(crypto, dayBlocks: 0); // genesis only
      final prevHash =
          remoteChain.getBlockHashFor(remoteChain.getLastBlock()!);
      final divergent = remoteChain.buildDayBlock(
        entries: [rawEntry(title: 'Remote', entry: 'Remote passage')],
        prevHash: prevHash,
        dateStr: '2026-08-31',
      );
      remoteChain.append(divergent);

      final result = await service.reconcileRemoteChain(remoteChain.readAll());

      expect(result.appended, 0);
      expect(result.conflictedIndices, contains(1));
      expect(localChain.getBlockCount(), 2); // unchanged
    });

    test(
        'CPSY-F7: empty local only accepts a genesis-first remote; otherwise '
        'conflict at index 0', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final store = FakeCommonplaceStore();
      final service = CommonplaceService(crypto: crypto, store: store); // empty

      final remoteChain =
          CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final day = remoteChain.buildDayBlock(
        entries: [rawEntry()],
        prevHash: '0' * 64,
        dateStr: '2026-08-31',
      );

      final result = await service.reconcileRemoteChain([day]);

      expect(result.appended, 0);
      expect(result.conflictedIndices, contains(0));
      expect(store.getBlockCount(), 0);
    });
  });
}
