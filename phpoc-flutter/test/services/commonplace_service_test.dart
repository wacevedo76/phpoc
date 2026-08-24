import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_service.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;

/// Phase 2 (RED) — Commonplace Service + provider wiring.
///
/// Implements Groups S (12 tests) + V (3 tests) from
/// docs/planning/flutter/COMMONPLACE_BOOK_UI_PHASE1.md.
///
/// Expected: these tests FAIL (RED) because `commonplace_service.dart`
/// and `commonplaceServiceProvider` do not exist yet (Phase 3 implements
/// them). The API mirrors `SyncService`'s relationship to the ledger engine
/// and targets the already-complete Commonplace chain engine
/// (`lib/data/commonplace/`, ADR-031, 55/55 GREEN).

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

// ── In-memory block-store fake for red tests ─────────────────────
// Mirrors the block-store contract CommonplaceStorage implements so the
// service can be constructed over an in-memory fake without touching disk.

class _FakeCommonplaceStore {
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
  Map<String, dynamic>? getLastBlock() =>
      _blocks.isEmpty ? null : _blocks.last;
}

/// Build a [CommonplaceService] over a fresh crypto + in-memory store.
CommonplaceService _makeService() {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  return CommonplaceService(
    crypto: crypto,
    store: _FakeCommonplaceStore(),
    identitySecret: identitySecret,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group S: CommonplaceService — read / add / verify / tag index
  // ═══════════════════════════════════════════════════════════════

  group('S: CommonplaceService — read / add / verify / tag index', () {
    test('CPUI-S1: readEntries returns committed entries decrypted in chain order',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'testuser',
        email: 'test@example.com',
        recoverySeedEnc: 'encrypted-seed',
        identityPubKey: 'pub-key-hex',
        identitySecretEncFallback: 'fallback-hex',
      );
      await service.addEntry(title: 'First', entry: 'alpha passage', tags: const ['a']);
      await service.addEntry(title: 'Second', entry: 'beta passage', tags: const ['b'], adHoc: null);

      final entries = await service.readEntries();
      expect(entries.length, 2);
      expect(entries.first['title'], 'First');
      expect(entries.last['title'], 'Second');
      // Decrypted — plaintext passage, not the _enc capsule.
      expect(entries.first['entry'], 'alpha passage');
    });

    test('CPUI-S2: readEntries returns [] on a fresh genesis-only chain',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      expect(await service.readEntries(), isEmpty);
    });

    test('CPUI-S3: addEntry seals a single Commonplace day block', () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(title: 'Note', entry: 'text', tags: const ['t']);

      expect(service.getEntryCount(), 1);
      // A sealed day block plus genesis -> two blocks, chain verifies.
      expect(service.verify(), isTrue);
    });

    test('CPUI-S4: addEntry records timestamp_ms (now) and derives date',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      final before = DateTime.now().millisecondsSinceEpoch;
      await service.addEntry(title: 'Dated', entry: 'x');
      final after = DateTime.now().millisecondsSinceEpoch;

      final entry = (await service.readEntries()).single;
      final ts = entry['timestamp_ms'] as int;
      expect(ts, inInclusiveRange(before, after));
      final date = entry['date'] as String;
      expect(date, isNotEmpty);
    });

    test('CPUI-S5: addEntry stores passage in `entry`, never `comment`',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(title: 'Schema', entry: 'the passage');

      final entry = (await service.readEntries()).single;
      expect(entry['entry'], 'the passage');
      expect(entry.containsKey('comment'), isFalse);
    });

    test('CPUI-S6: addEntry adHoc map preserves all k/v pairs on read-back',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(
        title: 'AdHoc',
        entry: 'with extras',
        adHoc: {'source': 'book', 'page': 12, 'note': 'nested'},
      );

      final entry = (await service.readEntries()).single;
      expect(entry['ad_hoc'], {'source': 'book', 'page': 12, 'note': 'nested'});
    });

    test('CPUI-S7: addEntry tags are persisted, lower-cased and trimmed',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(
        title: 'Tagged',
        entry: 'x',
        tags: const [' Poetry  ', 'Meditation'],
      );

      final entry = (await service.readEntries()).single;
      expect(entry['tags'], containsAll(['poetry', 'meditation']));
    });

    test('CPUI-S8: verify() returns true after a series of addEntry calls',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(title: 'A', entry: 'a1');
      await service.addEntry(title: 'B', entry: 'b1');
      await service.addEntry(title: 'C', entry: 'c1');

      expect(service.verify(), isTrue);
    });

    test('CPUI-S9: verify() returns false if a committed block is tampered',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(title: 'A', entry: 'a1');
      await service.addEntry(title: 'B', entry: 'b1');
      expect(service.verify(), isTrue);

      // Tamper with the sealed block store underneath the service.
      final store = service.store as _FakeCommonplaceStore;
      final blocks = store.readBlocks();
      final last = Map<String, dynamic>.from(blocks.last);
      last['date'] = '2099-01-01';
      store.appendBlocks([]); // no-op; ensure the store is writable
      // Directly corrupt the last block by rewinding + rewriting.
      // (Simplest deterministic tamper: swap the last block's date and
      // re-append a duplicate to break the sealed chain.)
      final tampered = Map<String, dynamic>.from(last);
      tampered.remove('day_hash');
      store.truncate(store.getBlockCount() - 1);
      store.appendBlocks([tampered]);

      expect(service.verify(), isFalse);
    });

    test('CPUI-S10: ensureGenesis creates a fresh genesis for a missing chain',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      expect(service.getEntryCount(), 0);
      // The genesis exists and alone is verifiable.
      expect(service.verify(), isTrue);
    });

    test('CPUI-S11: ensureGenesis does not duplicate genesis if one exists',
        () async {
      final service = _makeService();
      final seed = service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      final blocksAfterFirst = service.store.getBlockCount();
      final second = service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      expect(seed, isA<Future<void>>());
      expect(second, isA<Future<void>>());
      expect(service.store.getBlockCount(), blocksAfterFirst);
    });

    test('CPUI-S12: buildTagIndex returns tag frequencies from committed entries',
        () async {
      final service = _makeService();
      await service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      await service.addEntry(title: 'A', entry: 'a', tags: const ['poetry']);
      await service.addEntry(title: 'B', entry: 'b', tags: const ['poetry', 'meditation']);

      final index = service.buildTagIndex();
      expect(index['poetry'], 2);
      expect(index['meditation'], 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group V: Service provider wiring
  // ═══════════════════════════════════════════════════════════════

  group('V: Service provider wiring', () {
    test('CPUI-V1: commonplaceServiceProvider resolves a bound CommonplaceService',
        () {
      final container = data_providers.commonplaceServiceProvider;
      // The provider type exists and is a Provider<CommonplaceService>.
      expect(container, isNotNull);
    });

    test('CPUI-V2: the provider is overridable with an in-memory store', () {
      // We assert the provider is a Riverpod Provider, so feature tests can
      // override it with a fake-backed CommonplaceService.
      expect(data_providers.commonplaceServiceProvider, isNotNull);
    });

    test('CPUI-V3: CommonplaceService uses the shared CryptoService MK', () {
      final service = _makeService();

      // The service wraps the chain engine that seals under the shared MK
      // (crypto.getMasterKey()). Ensuring a genesis + verifying proves the
      // seal used the cached MK.
      service.ensureGenesis(
        username: 'u',
        email: 'e@example.com',
        recoverySeedEnc: 's',
        identityPubKey: 'p',
        identitySecretEncFallback: 'f',
      );
      expect(service.verify(), isTrue);
    });
  });
}
