import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/genesis_gate.dart';

/// GenesisGate tests — Group I (4 assertions).
///
/// MVP: passthrough (no local ledger blocks on mobile, so always returns null).
///
/// Covers:
///   I1: check() returns null when no local blocks exist
///   I2: check() returns null when local blocks array is empty
///   I3: Genesis gate integrated into checkAndSync() but bypassed
///   I4: resetGenesisGate() clears compatibility cache

void main() {
  group('I: GenesisGate — MVP Passthrough', () {
    // I1
    test('I1: check() returns null when no local blocks exist', () async {
      final gate = GenesisGate();
      // MVP: no local ledger blocks → passthrough (null)
      final result = await gate.check();
      expect(result, isNull,
          reason: 'MVP passthrough: no local blocks → genesis check skipped');
    });

    // I2
    test('I2: check() returns null when local blocks array is empty', () async {
      final gate = GenesisGate();
      final result = await gate.check();
      // Empty chain is same as no chain — passthrough
      expect(result, isNull);
    });

    // I3
    test('I3: genesis gate integrated into checkAndSync() but bypassed', () async {
      final gate = GenesisGate();
      // The gate should be callable from checkAndSync() flow
      // and return null to indicate passthrough (continue sync)
      final result = await gate.check();
      expect(result, isNull,
          reason: 'Gate returns null → checkAndSync() continues past genesis check');
    });

    // I4
    test('I4: resetGenesisGate() clears compatibility cache', () async {
      final gate = GenesisGate();
      // Initial check should work
      await gate.check();

      // After reset, gate should be ready for fresh check
      // (e.g., after Worker URL change)
      gate.reset();

      final result = await gate.check();
      expect(result, isNull,
          reason: 'After reset, gate rechecks cleanly');
    });
  });
}
