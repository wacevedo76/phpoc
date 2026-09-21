import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/data/ledger/helpers.dart' show encodeValueNoSpaces;
import 'package:phpoc_flutter/data/sync/staging_hash.dart';

/// Staging-Hash Parity V1/V2 — ADR-034 P0 gate (Flutter side, Groups E/F/G2).
///
/// Asserts the Flutter canonical-row bridge + digest against the committed
/// golden bytes in `testdata/staging_hash_seed.json`. The target module
/// `lib/data/sync/staging_hash.dart` does NOT exist yet, so this file is RED at
/// compile time ("Target of URI doesn't exist:
/// 'package:phpoc_flutter/data/sync/staging_hash.dart'") — the correct Phase-2
/// failure state for a brand-new module.
///
/// Spec (docs/design/STAGING_CHANGE_DETECTION_DESIGN.md §4.1):
///   staging_hash = SHA-256( encodeValueNoSpaces([ canonical_row(r) for r in
///                    non-committed rows ] sorted by activity_id) )
///   canonical_row(r) = { activity_id, activity_status, activity, updated_at,
///                        committed }
///   activity = compact JSON in pinned key order (title, start_epoch, end_epoch,
///              duration, tags, comment, media, entry_id, is_active, is_paused,
///              pauses, metadata, device_uuid, end_device_uuid, block_index)
///   Normalization: comment '' → null.
///
/// Phase 3 interface (what this test locks in):
///   Map<String, dynamic> dtoToCanonicalRow(
///     Map<String, dynamic> dto, {String deviceId = '', int? now});
///   String computeStagingHash(List<Map<String, dynamic>> rows);
///
/// Run: flutter test test/data/sync/staging_hash_test.dart
///
/// Golden bytes are committed constants (testdata/staging_hash_seed.json) —
/// never re-derived at test time, so the gate is non-circular.

const _fixturePath = '../testdata/staging_hash_seed.json';

Map<String, dynamic> _readFixture() {
  final raw = File(_fixturePath).readAsStringSync();
  return jsonDecode(raw) as Map<String, dynamic>;
}

void main() {
  final fx = _readFixture();
  final deviceId = fx['device_id'] as String;
  final now = fx['now'] as int;
  final seedDtos = (fx['seed_dtos'] as List).cast<Map<String, dynamic>>();
  final golden = fx['golden'] as Map<String, dynamic>;
  final goldenRows = (golden['canonical_rows'] as List).cast<Map<String, dynamic>>();
  final goldenById = {
    for (final r in goldenRows) r['activity_id'] as String: r,
  };

  List<Map<String, dynamic>> canonicalRows() => seedDtos
      .map((d) =>
          dtoToCanonicalRow(d, deviceId: deviceId, now: now) as Map<String, dynamic>)
      .toList();

  // The array-serialization step of the spec: filter committed, sort by
  // activity_id ascending, then compact sorted-keys JSON (NOT `jsonSort`).
  String canonicalArray(List<Map<String, dynamic>> rows) {
    final uncommitted = rows.where((r) => r['committed'] != true).toList()
      ..sort((a, b) =>
          (a['activity_id'] as String).compareTo(b['activity_id'] as String));
    return encodeValueNoSpaces(uncommitted);
  }

  group('E: Flutter canonical serialization (V1)', () {
    test('E1: dtoToCanonicalRow emits the 5-field canonical row', () {
      for (final row in canonicalRows()) {
        final id = row['activity_id'] as String;
        expect(row, equals(goldenById[id]),
            reason: 'canonical row mismatch for $id');
      }
    });

    test('E2: activity string matches golden byte-for-byte', () {
      for (final row in canonicalRows()) {
        final id = row['activity_id'] as String;
        expect(row['activity'], goldenById[id]!['activity'],
            reason: 'activity string mismatch for $id');
      }
    });

    test("E3: comment == '' normalizes to null", () {
      final dto = seedDtos.firstWhere((d) => d['entry_id'] == 'act-0002');
      final row = dtoToCanonicalRow(dto, deviceId: deviceId, now: now);
      final activity = jsonDecode(row['activity'] as String) as Map<String, dynamic>;
      expect(activity['comment'], isNull);
    });

    test('E4: canonical array matches golden (encodeValueNoSpaces, not jsonSort)', () {
      expect(canonicalArray(canonicalRows()), golden['canonical_array']);
    });
  });

  group('F: Flutter digest (V2)', () {
    test('F1: computeStagingHash returns golden hex', () {
      expect(computeStagingHash(canonicalRows()), golden['staging_hash']);
    });

    test('F2: deterministic + lowercase hex', () {
      final a = computeStagingHash(canonicalRows());
      final b = computeStagingHash(canonicalRows());
      expect(a, b);
      expect(a, matches(RegExp(r'^[0-9a-f]{64}$')));
    });
  });
}
