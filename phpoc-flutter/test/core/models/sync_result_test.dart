import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';

void main() {
  // ── Group F: SyncResult ─────────────────────────────────────

  group('SyncCheckResult', () {
    // F1 — Enum has all four values
    test('F1: enum has all four values', () {
      expect(SyncCheckResult.values, hasLength(4));
      expect(SyncCheckResult.values, containsAll([
        SyncCheckResult.ready,
        SyncCheckResult.offline,
        SyncCheckResult.reauthNeeded,
        SyncCheckResult.genesisMismatch,
      ]));
    });

    // F2 — String representation
    test('F2: toString returns correct name', () {
      expect(SyncCheckResult.ready.toString(), 'SyncCheckResult.ready');
      expect(SyncCheckResult.offline.toString(), 'SyncCheckResult.offline');
    });

    // F3 — Value lookup by name
    test('F3: lookup by name', () {
      expect(
        SyncCheckResult.values.byName('ready'),
        SyncCheckResult.ready,
      );
      expect(
        SyncCheckResult.values.byName('offline'),
        SyncCheckResult.offline,
      );
      expect(
        SyncCheckResult.values.byName('reauthNeeded'),
        SyncCheckResult.reauthNeeded,
      );
      expect(
        SyncCheckResult.values.byName('genesisMismatch'),
        SyncCheckResult.genesisMismatch,
      );
    });

    // F4 — Invalid name lookup throws
    test('F4: byName throws on invalid name', () {
      expect(
        () => SyncCheckResult.values.byName('INVALID'),
        throwsA(anything),
      );
    });

    // F5 — Naming matches expected values
    test('F5: values match expected sync result names', () {
      expect(SyncCheckResult.ready.name, 'ready');
      expect(SyncCheckResult.offline.name, 'offline');
      expect(SyncCheckResult.reauthNeeded.name, 'reauthNeeded');
      expect(SyncCheckResult.genesisMismatch.name, 'genesisMismatch');
    });
  });
}
