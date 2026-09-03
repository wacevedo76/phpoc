import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/services/commonplace_push_service.dart';
import 'package:phpoc_flutter/services/commonplace_pull_service.dart';

import 'commonplace_sync_test_support.dart';

/// Hermetic two-device Commonplace sync round-trip E2E — Group R (5 assertions).
///
/// Blueprint: docs/planning/flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md
///
/// Phase 2 (RED): `CommonplacePushService` / `CommonplacePullService` do not
/// exist yet, so these fail to compile.

void main() {
  group('R: Hermetic two-device round-trip E2E', () {
    test("CPSY-R1: Device B pulls Device A's chain and reads identical entries",
        () async {
      // Device A (writer).
      final cryptoA = initCrypto(mkHex: syncTestMkHex);
      final chainA = buildChain(cryptoA, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final pushA = CommonplacePushService(
        crypto: cryptoA,
        transport: transport,
        chain: chainA,
      );
      final pushResult = await pushA.pushAll();
      expect(pushResult.success, isTrue);

      // Device B (reader, same MK, separate store).
      final cryptoB = initCrypto(mkHex: syncTestMkHex);
      final storeB = FakeCommonplaceStore();
      final chainB = CommonplaceChain(crypto: cryptoB, store: storeB);
      final pullB = CommonplacePullService(
        crypto: cryptoB,
        transport: transport,
        chain: chainB,
      );
      final pullResult = await pullB.pullAll();
      expect(pullResult.success, isTrue);

      final entriesB =
          CommonplaceEngine(crypto: cryptoB, store: storeB).readEntries();
      expect(entriesB.single['title'], 'Title 0');
      expect(entriesB.single['entry'], 'Passage 0');
    });

    test("CPSY-R2: genesis-only Device B catches up to A's day blocks",
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chainA = buildChain(crypto, dayBlocks: 2); // genesis + 2 days
      final transport = FakeSyncTransport();
      await CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chainA,
      ).pushAll();

      final storeB = FakeCommonplaceStore();
      final chainB = buildChain(crypto, store: storeB, dayBlocks: 0); // genesis only
      final pullB = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chainB,
      );

      final result = await pullB.pullAll();

      expect(result.success, isTrue);
      expect(chainB.getBlockCount(), 3);
      expect(
        CommonplaceEngine(crypto: crypto, store: storeB).readEntries().length,
        2,
      );
    });

    test("CPSY-R3: empty Device B bootstraps A's full chain", () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chainA = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      await CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chainA,
      ).pushAll();

      final storeB = FakeCommonplaceStore();
      final chainB = CommonplaceChain(crypto: crypto, store: storeB);
      await CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chainB,
      ).pullAll();

      expect(chainB.getBlockCount(), 2);
      expect(
        CommonplaceEngine(crypto: crypto, store: storeB)
            .readEntries()
            .single['title'],
        'Title 0',
      );
    });

    test('CPSY-R4: divergent Device B reports conflict and keeps its local '
        'chain', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chainA = buildChain(crypto, dayBlocks: 1); // "Title 0"
      final transport = FakeSyncTransport();
      await CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chainA,
      ).pushAll();

      // Device B: same genesis, but a divergent day block.
      final storeB = FakeCommonplaceStore();
      final chainB = buildChain(crypto, store: storeB, dayBlocks: 0);
      final prevHash = chainB.getBlockHashFor(chainB.getLastBlock()!);
      final divergent = chainB.buildDayBlock(
        entries: [rawEntry(title: 'B-Title', entry: 'B-Passage')],
        prevHash: prevHash,
        dateStr: '2026-08-31',
      );
      chainB.append(divergent);

      final pullB = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chainB,
      );
      final result = await pullB.pullAll();

      expect(result.success, isFalse); // conflict surfaced
      expect(chainB.getBlockCount(), 2); // unchanged (genesis + divergent)
      expect(
        CommonplaceEngine(crypto: crypto, store: storeB)
            .readEntries()
            .single['title'],
        'B-Title', // local preserved
      );
    });

    test('CPSY-R5: wrong-MK device cannot decrypt pulled blocks', () async {
      final cryptoA = initCrypto(mkHex: syncTestMkHex);
      final chainA = buildChain(cryptoA, dayBlocks: 1);
      final transport = FakeSyncTransport();
      await CommonplacePushService(
        crypto: cryptoA,
        transport: transport,
        chain: chainA,
      ).pushAll();

      final wrongCrypto = initCrypto(mkHex: syncWrongMkHex);
      final storeC = FakeCommonplaceStore();
      final chainC =
          CommonplaceChain(crypto: wrongCrypto, store: storeC);
      final pullC = CommonplacePullService(
        crypto: wrongCrypto,
        transport: transport,
        chain: chainC,
      );

      final result = await pullC.pullAll();

      expect(result.success, isFalse);
      expect(chainC.getBlockCount(), 0);
    });
  });
}
