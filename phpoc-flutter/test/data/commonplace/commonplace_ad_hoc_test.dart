import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_engine.dart';
import 'package:phpoc_flutter/data/commonplace/commonplace_chain.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show computeContentHash;

/// Commonplace ad-hoc key/value — Phase 2 (RED) test suite.
///
/// All 5 assertions from docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md
/// Group F: Commonplace ad-hoc Key/Value.
///
/// Expected: all tests FAIL (RED) because the Commonplace engine does not exist
/// yet.

// ── In-memory store fakes ───────────────────────────────────────

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

// ── Test constants ──────────────────────────────────────────────

const mkHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const identitySecret = 'identity-secret-32-bytes-xxxxxx';

CommonplaceEngine _makeEngine({String? identitySecretHex}) {
  final crypto = CryptoService();
  crypto.initialize();
  crypto.setMasterKey(mkHex);
  final store = _FakeCommonplaceStore();
  return CommonplaceEngine(
    crypto: crypto,
    store: store,
    identitySecret: identitySecretHex,
  );
}

void _seedGenesis(CommonplaceEngine engine) {
  engine.buildGenesis(
    username: 'testuser',
    email: 'test@example.com',
    recoverySeedEnc: 'encrypted-seed',
    identityPubKey: 'pub-key-hex',
    identitySecretEncFallback: 'fallback-hex',
  );
}

Map<String, dynamic> _entry(
  String title, {
  Map<String, dynamic>? adHoc,
  int timestampMs = 1700000000000,
}) {
  return {
    'title': title,
    'tags': <String>['topic'],
    'entry': 'passage',
    if (adHoc != null) 'ad_hoc': adHoc,
    'timestamp_ms': timestampMs,
  };
}

/// Extract the first sealed entry's data map from the engine's last day block.
Map<String, dynamic> _sealedData(CommonplaceEngine engine) {
  final day = engine.getDayBlocks().last;
  final first = (day['entries'] as List<dynamic>).first as Map;
  return Map<String, dynamic>.from(first['data'] as Map);
}

void main() {
  group('F: Commonplace ad-hoc Key/Value', () {
    // CP-F1 — ad_hoc accepts multiple arbitrary key/value pairs
    test('CP-F1: ad_hoc accepts multiple arbitrary k/v pairs', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([
        _entry('Rich entry',
            adHoc: {'source': 'book', 'page': '42', 'favorite': 'yes', 'quote': 'x'}),
      ]);

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);
      final data = _sealedData(engine);
      expect(data.containsKey('ad_hoc_enc'), isTrue);
      final decoded =
          jsonDecode(crypto.decryptWithCachedKey(data['ad_hoc_enc'])) as Map;
      expect(decoded['source'], 'book');
      expect(decoded['page'], '42');
      expect(decoded['favorite'], 'yes');
      expect(decoded['quote'], 'x');
    });

    // CP-F2 — ad_hoc values are encrypted at rest
    test('CP-F2: ad_hoc values are encrypted at rest (no plaintext)', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      const secret = 'secretsauce-value';
      engine.commit([
        _entry('Secret meta', adHoc: {'keyA': secret}),
      ]);

      final day = engine.getDayBlocks().last;
      final raw = jsonEncode(day);
      expect(raw.contains(secret), isFalse);
      expect(raw.contains('ad_hoc_enc'), isTrue);
    });

    // CP-F3 — ad_hoc pairs survive commit → read round-trip
    test('CP-F3: ad_hoc pairs survive the commit → read round-trip', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([
        _entry('Meta entry', adHoc: {'pinned': 'true', 'source': 'citp'}),
      ]);

      final entries = engine.readEntries();
      expect(entries.length, 1);
      // The read API should surface the ad-hoc map back to callers.
      final adHoc = entries.first['ad_hoc'] as Map<String, dynamic>?;
      expect(adHoc, isNotNull);
      expect(adHoc!['pinned'], 'true');
      expect(adHoc['source'], 'citp');
    });

    // CP-F4 — missing ad_hoc does not invalidate an entry
    test('CP-F4: an entry without ad_hoc is valid and readable', () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([_entry('Bare entry')]);
      expect(engine.verify(), isTrue);

      final data = _sealedData(engine);
      // No ad_hoc field at all — entry is valid without it.
      expect(data.containsKey('ad_hoc_enc'), isFalse);
    });

    // CP-F5 — entry with ad_hoc keeps a stable content hash across re-encryption
    test('CP-F5: ad_hoc keeps a stable content hash across re-encryption',
        () {
      final engine = _makeEngine(identitySecretHex: identitySecret);
      _seedGenesis(engine);

      engine.commit([
        _entry('Rotation safe', adHoc: {'k': 'v'}),
      ]);
      final data = _sealedData(engine);
      final contentHash = data['content_hash'];

      final crypto = CryptoService();
      crypto.initialize();
      crypto.setMasterKey(mkHex);

      // Simulate a re-encryption (rotation): re-encrypt the ad_hoc payload
      // with the same MK under fresh ciphertext.
      final plainAdHoc = crypto.decryptWithCachedKey(data['ad_hoc_enc']);
      final reEncrypted = crypto.encryptWithCachedKey(plainAdHoc);
      final reEncoded = Map<String, dynamic>.from(data)..['ad_hoc_enc'] = reEncrypted;

      // With the same content (decrypted), the content hash must be stable.
      expect(computeContentHash(reEncoded, crypto), contentHash);
    });
  });
}
