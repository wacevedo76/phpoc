import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show jsonEncodeSortedNoSpaces;
import 'package:phpoc_flutter/services/commonplace_pull_service.dart';

import 'commonplace_sync_test_support.dart';

/// CommonplacePullService tests — Group L (10 assertions).
///
/// Blueprint: docs/planning/flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md
///
/// Phase 2 (RED): the not-yet-created `CommonplacePullService`
/// (`lib/services/commonplace_pull_service.dart`) makes these fail to compile.

void main() {
  group('L: CommonplacePullService — pull from R2', () {
    test('CPSY-L1: pullAll returns ok(0) when no remote hash_index exists',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: FakeSyncTransport(),
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
    });

    test('CPSY-L2: pullAll discovers block count from commonplace/hash_index.json',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 2);
    });

    test('CPSY-L3: pullAll pulls discovered blocks in ascending index order',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 2);
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isTrue);
      expect(result.blocksPulled, 3);
      final imported = chain.readAll();
      expect(imported.length, 3);
      expect(imported[0]['type'], 'commonplace_genesis');
      expect(imported[1]['type'], 'commonplace');
      expect(imported[2]['type'], 'commonplace');
    });

    test(
        'CPSY-L4: pulled blocks are deobfuscated with MK and parsed into '
        'readable chain entries', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);

      final store = FakeCommonplaceStore();
      final chain = CommonplaceChain(crypto: crypto, store: store);
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isTrue);
      // Deobfuscate + parse + import + decrypt round-trip yields the passage.
      final entries = CommonplaceEngine(crypto: crypto, store: store).readEntries();
      expect(entries.single['title'], 'Title 0');
      expect(entries.single['entry'], 'Passage 0');
    });

    test(
        'CPSY-L5: wrong MK fails to deobfuscate — failedBlocks reported, '
        'nothing imported', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);

      final wrongCrypto = initCrypto(mkHex: syncWrongMkHex);
      final chain =
          CommonplaceChain(crypto: wrongCrypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: wrongCrypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isFalse);
      expect(result.failedBlocks, isNotEmpty);
      expect(chain.getBlockCount(), 0);
    });

    test(
        'CPSY-L6: a remote chain whose first block is not commonplace_genesis '
        'is rejected before import', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      // A standalone day block (no genesis) with a zero prev_hash.
      final src = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final day = src.buildDayBlock(
        entries: [rawEntry()],
        prevHash: '0' * 64,
        dateStr: '2026-08-31',
      );
      final transport = FakeSyncTransport();
      transport.store[commonplaceHashIndexPath] = Uint8List.fromList(
        utf8.encode(jsonEncode([src.getBlockHashFor(day)])),
      );
      transport.store[commonplaceBlockPath(0)] = crypto.obfuscateBlob(
        jsonEncodeSortedNoSpaces(day),
        syncTestMkHex,
      );

      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isFalse);
      expect(chain.getBlockCount(), 0);
    });

    test(
        'CPSY-L7: a chain with broken prev_hash linkage is rejected before '
        'import', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final src = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      src.buildGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      final genesis = src.readAll()[0];
      // Valid seal, but its prev_hash does not link to the genesis.
      final day = src.buildDayBlock(
        entries: [rawEntry()],
        prevHash: 'f' * 64,
        dateStr: '2026-08-31',
      );

      final transport = FakeSyncTransport();
      transport.store[commonplaceHashIndexPath] = Uint8List.fromList(
        utf8.encode(jsonEncode([
          src.getBlockHashFor(genesis),
          src.getBlockHashFor(day),
        ])),
      );
      transport.store[commonplaceBlockPath(0)] = crypto.obfuscateBlob(
        jsonEncodeSortedNoSpaces(genesis),
        syncTestMkHex,
      );
      transport.store[commonplaceBlockPath(1)] = crypto.obfuscateBlob(
        jsonEncodeSortedNoSpaces(day),
        syncTestMkHex,
      );

      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isFalse);
      expect(chain.getBlockCount(), 0);
    });

    test(
        'CPSY-L8: valid chain imports — fresh local bootstraps, existing '
        'local appends', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);

      // L8a: fresh local bootstraps the full chain.
      final fresh = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svcFresh = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: fresh,
      );
      final r1 = await svcFresh.pullAll();
      expect(r1.success, isTrue);
      expect(fresh.getBlockCount(), 2);

      // L8b: existing local (genesis only, same genesis) appends the day block.
      final existing = buildChain(crypto, dayBlocks: 0);
      final svcExisting = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: existing,
      );
      final r2 = await svcExisting.pullAll();
      expect(r2.success, isTrue);
      expect(existing.getBlockCount(), 2);
    });

    test('CPSY-L9: StateError without MK; ok(0) with null transport', () async {
      final noMk = initCrypto();
      final chain1 =
          CommonplaceChain(crypto: noMk, store: FakeCommonplaceStore());
      final svc1 = CommonplacePullService(
        crypto: noMk,
        transport: FakeSyncTransport(),
        chain: chain1,
      );
      expect(svc1.pullAll(), throwsStateError);

      final withMk = initCrypto(mkHex: syncTestMkHex);
      final chain2 =
          CommonplaceChain(crypto: withMk, store: FakeCommonplaceStore());
      final svc2 = CommonplacePullService(
        crypto: withMk,
        transport: null,
        chain: chain2,
      );
      final result = await svc2.pullAll();
      expect(result.success, isTrue);
      expect(result.blocksPulled, 0);
    });

    test(
        'CPSY-L10: fewer blocks than hash_index expects → missing indices in '
        'failedBlocks', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final remote = buildChain(crypto, dayBlocks: 1); // genesis + 1 day
      final transport = FakeSyncTransport();
      seedRemoteChain(transport, remote, crypto, syncTestMkHex);
      // Simulate a partial remote: the day block (index 1) is missing.
      transport.store.remove(commonplaceBlockPath(1));

      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePullService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pullAll();

      expect(result.success, isFalse);
      expect(result.failedBlocks, contains(1));
    });
  });
}
