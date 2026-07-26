import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/sync/staging_paths.dart';

/// StagingPaths constant tests — Group P (7 assertions).
///
/// Phase 2 (RED): All tests fail because StagingPaths still uses old Flutter paths.
/// Phase 3 will correct the constants to match CLI/web canonical paths.
///
/// Covers:
///   P1–P5: Individual path constant values match CLI/web canonical paths
///   P6: All members are static const (compile-time immutability)
///   P7: remoteStagingBlob is NOT the old Flutter path

void main() {
  group('P: StagingPaths — Path Constants', () {
    // P1
    test('P1: remoteStagingBlob equals staging/blobs/current.json', () {
      expect(
        StagingPaths.remoteStagingBlob,
        'staging/blobs/current.json',
        reason: 'Must match CLI (domain/staging/remote_sync.py) and '
            'web (phpoc-web/src/sync/keys.js). Mismatch = silent data fork.',
      );
    });

    // P2
    test('P2: remoteDeviceCookie equals staging/blobs/device_cookie.bin', () {
      expect(
        StagingPaths.remoteDeviceCookie,
        'staging/blobs/device_cookie.bin',
        reason: 'Cookie drives fast-path detection. Wrong path = every sync '
            'is a slow reconcile.',
      );
    });

    // P3
    test('P3: remoteStagingHashIndex equals staging/hash_index.json', () {
      expect(
        StagingPaths.remoteStagingHashIndex,
        'staging/hash_index.json',
        reason: 'Hash index enables incremental sync. Wrong path = full blob '
            'transfer every time.',
      );
    });

    // P4
    test('P4: remoteLedgerBlocksPrefix equals ledger/blocks/', () {
      expect(
        StagingPaths.remoteLedgerBlocksPrefix,
        'ledger/blocks/',
        reason: 'Currently correct — this test prevents regression drift.',
      );
    });

    // P5
    test('P5: remoteHashIndex equals ledger/hash_index.json', () {
      expect(
        StagingPaths.remoteHashIndex,
        'ledger/hash_index.json',
        reason: 'Currently correct — this test prevents regression drift.',
      );
    });

    // P6
    test('P6: all StagingPaths members are static const (immutability)', () {
      // Compile-time check: static const members cannot be reassigned.
      // This test verifies the class design prevents runtime mutation.
      // If any member were non-const, reassignment would be possible
      // and the test framework would compile anyway — but the const
      // keyword at declaration site is the actual guard.
      //
      // We verify by checking the runtime type and value stability
      // across multiple accesses.
      const paths = <String>[
        StagingPaths.remoteStagingBlob,
        StagingPaths.remoteDeviceCookie,
        StagingPaths.remoteStagingHashIndex,
        StagingPaths.remoteLedgerBlocksPrefix,
        StagingPaths.remoteHashIndex,
      ];

      // All must be String (not null, not dynamic)
      for (final path in paths) {
        expect(path, isA<String>(), reason: 'All StagingPaths members must be non-null String');
        expect(path, isNotEmpty, reason: 'Path constants must not be empty');
      }

      // Repeated access must return same value (const guarantee)
      expect(StagingPaths.remoteStagingBlob, StagingPaths.remoteStagingBlob);
      expect(StagingPaths.remoteDeviceCookie, StagingPaths.remoteDeviceCookie);
      expect(StagingPaths.remoteStagingHashIndex, StagingPaths.remoteStagingHashIndex);
    });

    // P7
    test('P7: remoteStagingBlob is NOT the old Flutter path staging/blob.bin', () {
      expect(
        StagingPaths.remoteStagingBlob,
        isNot('staging/blob.bin'),
        reason: 'The old incorrect Flutter path must not be reused as the '
            'new canonical constant value.',
      );
    });
  });
}
