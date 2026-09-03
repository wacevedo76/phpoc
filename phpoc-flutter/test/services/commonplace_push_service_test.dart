import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show jsonEncodeSortedNoSpaces;
import 'package:phpoc_flutter/services/commonplace_push_service.dart';

import 'commonplace_sync_test_support.dart';

/// CommonplacePushService tests — Group P (9 assertions).
///
/// Blueprint: docs/planning/flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md
///
/// Phase 2 (RED): the not-yet-created `CommonplacePushService`
/// (`lib/services/commonplace_push_service.dart`) makes these fail to compile.

void main() {
  group('P: CommonplacePushService — push to R2', () {
    test('CPSY-P1: pushAll pushes every block to commonplace/blocks/NNNNNN.json',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pushAll();

      expect(result.success, isTrue);
      expect(result.blocksPushed, 2);
      expect(transport.store.containsKey(commonplaceBlockPath(0)), isTrue);
      expect(transport.store.containsKey(commonplaceBlockPath(1)), isTrue);

      final genesis = jsonDecode(crypto.deobfuscateBlob(
        transport.store[commonplaceBlockPath(0)]!,
        syncTestMkHex,
      )) as Map<String, dynamic>;
      expect(genesis['type'], 'commonplace_genesis');

      final day = jsonDecode(crypto.deobfuscateBlob(
        transport.store[commonplaceBlockPath(1)]!,
        syncTestMkHex,
      )) as Map<String, dynamic>;
      expect(day['type'], 'commonplace');
    });

    test('CPSY-P2: pushAll pushes a plaintext hash_index of block hashes in order',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      await svc.pushAll();

      final index =
          jsonDecode(utf8.decode(transport.store[commonplaceHashIndexPath]!))
              as List<dynamic>;
      final blocks = chain.readAll();
      expect(index.length, 2);
      expect(index[0], chain.getBlockHashFor(blocks[0]));
      expect(index[1], chain.getBlockHashFor(blocks[1]));
    });

    test(
        'CPSY-P3: pushed block payload is sorted space-free PHPSPEC JSON '
        'obfuscated with the MK', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      await svc.pushAll();

      final block = chain.readAll()[1];
      final obfuscated = transport.store[commonplaceBlockPath(1)]!;
      final decoded = crypto.deobfuscateBlob(obfuscated, syncTestMkHex);
      expect(decoded, jsonEncodeSortedNoSpaces(block));
      expect(decoded.contains(' '), isFalse);
    });

    test('CPSY-P4: pushAll throws StateError on an empty chain', () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: FakeSyncTransport(),
        chain: chain,
      );

      expect(svc.pushAll(), throwsStateError);
    });

    test('CPSY-P5: pushAll throws StateError when no master key is cached',
        () async {
      final crypto = initCrypto(); // no MK
      final chain = CommonplaceChain(crypto: crypto, store: FakeCommonplaceStore());
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: FakeSyncTransport(),
        chain: chain,
      );

      // The MK guard runs before the empty-chain guard, so this throws even
      // though the chain is empty.
      expect(svc.pushAll(), throwsStateError);
    });

    test('CPSY-P6: pushBlocks pushes an explicit block list at 0-based positions',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pushBlocks(chain.readAll());

      expect(result.success, isTrue);
      expect(result.blocksPushed, 2);
      expect(transport.store.containsKey(commonplaceBlockPath(0)), isTrue);
      expect(transport.store.containsKey(commonplaceBlockPath(1)), isTrue);
      final index =
          jsonDecode(utf8.decode(transport.store[commonplaceHashIndexPath]!))
              as List<dynamic>;
      expect(index.length, 2);
    });

    test('CPSY-P7: repeated pushAll is idempotent — same paths overwritten',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final first = await svc.pushAll();
      final second = await svc.pushAll();

      expect(first.success, isTrue);
      expect(second.success, isTrue);
      expect(transport.store.containsKey(commonplaceBlockPath(0)), isTrue);
      expect(transport.store.containsKey(commonplaceBlockPath(1)), isTrue);
      expect(transport.store.containsKey(commonplaceHashIndexPath), isTrue);
    });

    test('CPSY-P8: a failing block yields PushResult.failure with failedBlocks',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      transport.errorOnPushPath[commonplaceBlockPath(1)] = 500;
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final result = await svc.pushAll();

      expect(result.success, isFalse);
      expect(result.failedBlocks, contains(1));
      expect(transport.store.containsKey(commonplaceBlockPath(0)), isTrue);
    });

    test('CPSY-P9: concurrent pushAll calls are serialized (single push pass)',
        () async {
      final crypto = initCrypto(mkHex: syncTestMkHex);
      final chain = buildChain(crypto, dayBlocks: 1);
      final transport = FakeSyncTransport();
      final svc = CommonplacePushService(
        crypto: crypto,
        transport: transport,
        chain: chain,
      );

      final f1 = svc.pushAll();
      final f2 = svc.pushAll();
      final r1 = await f1;
      final r2 = await f2;

      expect(r1.success, isTrue);
      expect(r2.success, isTrue);
      // 2 blocks + 1 hash_index pushed exactly once (not twice).
      expect(transport.pushCount, 3);
    });
  });
}
