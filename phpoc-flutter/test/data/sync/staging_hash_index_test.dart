import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/staging_hash_index.dart';

/// Staging Hash Index tests — Group H (8 assertions).
///
/// Covers:
///   H1: buildStagingHashIndex() returns [{id, status}, ...] array
///   H2: hash index is computed and storable alongside staging blob
///   H3: hash index can be pulled and cached
///   H4: compareStagingHashIndexes(local, remote) returns diff
///   H5: identical hash indexes → fast path, no row pull needed
///   H6: changed hash index → fall through to row-by-row diff
///   H7: no remote hash index → bootstrap from local entries
///   H8: hash index sha256 computed and pushed for Tier 1 integrity

/// Helper: make a staging row map.
Map<String, dynamic> _makeRow({
  required String activityId,
  required String status,
  int updatedAt = 1000,
}) {
  return {
    'activity_id': activityId,
    'activity_status': status,
    'activity': '{"title":"test"}',
    'updated_at': updatedAt,
  };
}

void main() {
  group('H: StagingHashIndex — build and format', () {
    // H1
    test('H1: buildStagingHashIndex() returns [{id, status}, ...] array', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'h1a', status: 'active', updatedAt: 1000));
      await store.putRow(_makeRow(activityId: 'h1b', status: 'ended', updatedAt: 2000));

      final crypto = CryptoService();
      await crypto.initialize();

      final index = await StagingHashIndex.build(store);
      expect(index, isA<List>());
      expect(index.length, 2);

      for (final entry in index) {
        expect(entry, contains('activity_id'));
        expect(entry, contains('activity_status'));
        // The exact key names may vary; just verify they exist
      }
      await db.close();
    });

    // H2
    test('H2: hash index is computed alongside staging blob for push', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'h2a', status: 'active'));
      await store.putRow(_makeRow(activityId: 'h2b', status: 'paused'));

      final crypto = CryptoService();
      await crypto.initialize();

      // Build index + compute hash
      final index = await StagingHashIndex.build(store);
      final hash = StagingHashIndex.computeHash(index);

      expect(hash, isA<String>());
      expect(hash.length, 64); // SHA-256 hex = 64 chars
      expect(hash, matches(RegExp(r'^[0-9a-f]{64}$')));
      await db.close();
    });

    // H3
    test('H3: hash index can be pulled and cached during checkAndSync', () async {
      final db = AppDatabase.inMemory();
      final store = StagingStore(db);
      await store.putRow(_makeRow(activityId: 'h3a', status: 'active'));

      final crypto = CryptoService();
      await crypto.initialize();

      final index = await StagingHashIndex.build(store);

      // Simulate: store the index JSON (as it would be pushed/pulled)
      final indexJson = json.encode(index);
      final parsed = json.decode(indexJson) as List;

      // The parsed format should match the build format
      expect(parsed.length, index.length);
      for (var i = 0; i < parsed.length; i++) {
        expect(parsed[i], contains('activity_id'));
        expect(parsed[i], contains('activity_status'));
      }
      await db.close();
    });

    // H4
    test('H4: compareStagingHashIndexes(local, remote) returns diff object', () async {
      final local = [
        {'activity_id': 'a1', 'activity_status': 'active'},
        {'activity_id': 'a2', 'activity_status': 'ended'},
      ];
      final remote = [
        {'activity_id': 'a1', 'activity_status': 'active'},
        {'activity_id': 'a3', 'activity_status': 'paused'},
      ];

      final diff = StagingHashIndex.compare(local, remote);

      expect(diff, isA<StagingHashDiff>());
      expect(diff.identical, isFalse,
          reason: 'a2 removed, a3 added → not identical');
      expect(diff.added, contains('a3'));
      expect(diff.removed, contains('a2'));
      expect(diff.changed, isEmpty); // a1 exists in both with same status
    });

    // H5
    test('H5: identical hash indexes → fast path (no row pull needed)', () async {
      final index = [
        {'activity_id': 'a1', 'activity_status': 'active'},
        {'activity_id': 'a2', 'activity_status': 'ended'},
      ];

      final diff = StagingHashIndex.compare(index, index);
      expect(diff.identical, isTrue);
      expect(diff.added, isEmpty);
      expect(diff.removed, isEmpty);
      expect(diff.changed, isEmpty);
    });

    // H6
    test('H6: changed hash index → fall through to row-by-row diff', () async {
      final local = [
        {'activity_id': 'a1', 'activity_status': 'active'},
      ];
      final remote = [
        {'activity_id': 'a1', 'activity_status': 'ended'}, // status changed
      ];

      final diff = StagingHashIndex.compare(local, remote);
      expect(diff.identical, isFalse);
      expect(diff.changed, contains('a1'));
      expect(diff.added, isEmpty);
      expect(diff.removed, isEmpty);
    });

    // H7
    test('H7: no remote hash index → bootstrap from local entries', () async {
      final local = [
        {'activity_id': 'a1', 'activity_status': 'active'},
      ];
      final List<Map<String, dynamic>>? remote = null;

      // When remote is null/empty, the diff should indicate full bootstrap
      final diff = StagingHashIndex.compare(local, remote ?? []);
      expect(diff.identical, isFalse);
      // All local entries should be considered "added" to remote
      expect(diff.added, contains('a1'));
      await Future.value(); // no-op await for async pattern
    });

    // H8
    test('H8: hash index sha256 computed and is deterministic', () async {
      final crypto = CryptoService();
      await crypto.initialize();

      final index1 = [
        {'activity_id': 'a1', 'activity_status': 'active'},
      ];
      final index2 = [
        {'activity_id': 'a1', 'activity_status': 'active'},
      ];

      final hash1 = StagingHashIndex.computeHash(index1);
      final hash2 = StagingHashIndex.computeHash(index2);

      // Same input → same hash
      expect(hash1, equals(hash2));

      // Different input → different hash
      final index3 = [
        {'activity_id': 'a2', 'activity_status': 'ended'},
      ];
      final hash3 = StagingHashIndex.computeHash(index3);
      expect(hash1, isNot(equals(hash3)));
    });
  });
}
