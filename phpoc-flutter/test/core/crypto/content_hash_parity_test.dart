import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service_native.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart';

/// Group D — Cross-client byte-parity for `computeContentHash`.
///
/// Proves the three Flutter compute implementations (production free function
/// in `helpers.dart`, the pure-Dart shim method, and the FFI native method)
/// produce byte-identical hashes with each other AND with the Python/Web
/// canonical reference (PHPSPEC §5.5/§6.1 KEEP `_enc` suffix).
///
/// Blueprint: docs/planning/flutter/CONTENT_HASH_STRIP_DIVERGENCE_PHASE1.md

void main() {
  const mk = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  const v2Hash = '3df78f0abccaf7b9fdf0b504a1d205d91561420782791869642f4792e23169f9';

  /// V2 canonical fixture with `_enc` fields encrypted by [encrypt].
  Map<String, dynamic> v2Fixture(String Function(String) encrypt) {
    return {
      'comment': 'deep work',
      'duration': 3600000,
      'endTime_enc': encrypt('1714003600000'),
      'pauses_enc': encrypt('[]'),
      'startTime_enc': encrypt('1714000000000'),
      'tags': ['focus', 'work'],
      'title': 'Coding',
    };
  }

  // D1 — all three implementations produce the identical hash (V2 fixture)
  test('CH-D1: all three implementations produce identical hash (V2 fixture)',
      () async {
    final dartShim = CryptoService();
    await dartShim.initialize();
    dartShim.setMasterKey(mk);

    final native = CryptoServiceNative();
    await native.initialize();
    native.setMasterKey(mk);

    final viaHelper = computeContentHash(v2Fixture(dartShim.encryptWithCachedKey), dartShim);
    final viaShim = dartShim.computeContentHash(v2Fixture(dartShim.encryptWithCachedKey));
    final viaNative = native.computeContentHash(v2Fixture(native.encryptWithCachedKey));

    expect(viaHelper, viaShim);
    expect(viaShim, viaNative);
  });

  // D2 — V2 fixture hash equals the Python/Web canonical reference
  test('CH-D2: V2 fixture hash equals Python/Web canonical reference', () async {
    final dartShim = CryptoService();
    await dartShim.initialize();
    dartShim.setMasterKey(mk);

    final native = CryptoServiceNative();
    await native.initialize();
    native.setMasterKey(mk);

    expect(computeContentHash(v2Fixture(dartShim.encryptWithCachedKey), dartShim), v2Hash);
    expect(dartShim.computeContentHash(v2Fixture(dartShim.encryptWithCachedKey)), v2Hash);
    expect(native.computeContentHash(v2Fixture(native.encryptWithCachedKey)), v2Hash);
  });
}
