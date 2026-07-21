import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/sync/local_cache.dart';

/// LocalCache tests — Group B (15 assertions).
///
/// Covers:
///   B1–B2: readEntries() decrypts, empty state
///   B3–B6: append() encrypts fields, computes hash, generates entry_id,
///           throws on start_epoch collision
///   B7–B8: update() modifies fields, no-op on committed
///   B9: delete() removes entry
///   B10–B11: addPause() / closePause() lifecycle
///   B12: computeDuration() correctness
///   B13: writeEntries() bulk write
///   B14: encrypt/decrypt roundtrip
///   B15: readHashIndex() / writeHashIndex() roundtrip

/// In-memory storage backend matching the contract used by LocalCache.
class _FakeStorage {
  final Map<String, dynamic> _data = {};

  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Create a fresh CryptoService with a cached master key for testing.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  // Set a known master key for deterministic encryption in tests
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

void main() {
  group('B: LocalCache — readEntries()', () {
    // B1
    test('B1: readEntries() returns decrypted entry list from storage', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      // Append an entry via the cache
      await cache.append(
        title: 'Test Task',
        startEpoch: 1000,
      );

      final entries = await cache.readEntries();
      expect(entries, isNotEmpty);
      expect(entries.length, 1);
      // Should have decrypted fields
      expect(entries[0]['title'], 'Test Task');
      expect(entries[0]['start_epoch'], 1000);
    });

    // B2
    test('B2: readEntries() returns empty list when no entries exist', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      final entries = await cache.readEntries();
      expect(entries, isEmpty);
    });
  });

  group('B: LocalCache — append()', () {
    // B3
    test('B3: append() writes encrypted fields to storage', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Secret Task', startEpoch: 1000);

      // Fields should be stored encrypted (not plaintext)
      final raw = await storage.get('entries');
      expect(raw, isNotNull);
      final entry = raw[0] as Map<String, dynamic>;
      final data = entry['data'] as Map<String, dynamic>;
      // startTime should be encrypted (not starting with 'plain:')
      expect(data['startTime_enc'], isNotNull);
      // Should NOT be plain: prefix when MK is available
      expect(data['startTime_enc'].toString().startsWith('plain:'), false,
          reason: 'With MK available, fields must be AES-encrypted, not plain: prefixed');
    });

    // B4
    test('B4: append() generates and stores entry content hash', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      final hash = await cache.append(title: 'Hashed Task', startEpoch: 2000);

      // Hash should be a non-empty string returned
      expect(hash, isNotEmpty);

      // Stored entry should have the hash
      final raw = await storage.get('entries');
      expect(raw[0]['hash'], isNotEmpty);
    });

    // B5
    test('B5: append() generates unique entry_id per entry', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Task A', startEpoch: 1000);
      await cache.append(title: 'Task B', startEpoch: 2000);

      final entries = await cache.readEntries();
      expect(entries.length, 2);
      expect(entries[0]['entry_id'], isNotEmpty);
      expect(entries[1]['entry_id'], isNotEmpty);
      expect(entries[0]['entry_id'], isNot(entries[1]['entry_id']),
          reason: 'Each entry must have a unique UUID');
    });

    // B6
    test('B6: append() throws on start_epoch collision', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'First', startEpoch: 1000);

      // Same start_epoch → collision detection
      expect(
        () => cache.append(title: 'Second', startEpoch: 1000),
        throwsA(isA<Exception>()),
      );
    });

    // B14 — encrypt/decrypt roundtrip
    test('B14: encrypt/decrypt roundtrip preserves value', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(
        title: 'Roundtrip Test',
        startEpoch: 5000,
        tags: ['test', 'roundtrip'],
      );

      final entries = await cache.readEntries();
      expect(entries[0]['title'], 'Roundtrip Test');
      expect(entries[0]['start_epoch'], 5000);
      expect(entries[0]['tags'], containsAll(['test', 'roundtrip']));
    });
  });

  group('B: LocalCache — update()', () {
    // B7
    test('B7: update() modifies fields', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Original', startEpoch: 1000);

      await cache.update(0, {'title': 'Updated', 'end_epoch': 5000});

      final entries = await cache.readEntries();
      expect(entries[0]['title'], 'Updated');
      expect(entries[0]['end_epoch'], 5000);
    });

    // B8
    test('B8: update() is a no-op on committed entry', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'To Commit', startEpoch: 1000);
      final entries = await cache.readEntries();
      final entryId = entries[0]['entry_id'] as String;

      // Mark as committed
      await cache.markCommitted([entryId], 0);

      // Attempting update on committed entry should be no-op
      // (the entry at index 0 is now committed)
      final entriesBefore = await cache.readEntries();
      final titleBefore = entriesBefore[0]['title'];

      await cache.update(0, {'title': 'Should Not Change'});

      final entriesAfter = await cache.readEntries();
      expect(entriesAfter[0]['title'], titleBefore,
          reason: 'Committed entries must be immutable');
    });
  });

  group('B: LocalCache — delete()', () {
    // B9
    test('B9: delete() removes entry at index', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Keep Me', startEpoch: 1000);
      await cache.append(title: 'Delete Me', startEpoch: 2000);

      await cache.delete(1);

      final entries = await cache.readEntries();
      expect(entries.length, 1);
      expect(entries[0]['title'], 'Keep Me');
    });
  });

  group('B: LocalCache — Pauses', () {
    // B10
    test('B10: addPause() appends open pause record', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Pausable', startEpoch: 1000);

      await cache.addPause(0, 1500);

      final entries = await cache.readEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses.length, 1);
      expect(pauses[0]['pause_start'], 1500);
      expect(pauses[0]['pause_stop'], isNull,
          reason: 'Open pause record should have null pause_stop');
    });

    // B11
    test('B11: closePause() closes the last open pause', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      await cache.append(title: 'Pausable', startEpoch: 1000);
      await cache.addPause(0, 1500);

      await cache.closePause(0, 2000);

      final entries = await cache.readEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses.length, 1);
      expect(pauses[0]['pause_start'], 1500);
      expect(pauses[0]['pause_stop'], 2000);
    });
  });

  group('B: LocalCache — computeDuration()', () {
    // B12
    test('B12: computeDuration() returns correct active time', () {
      // Wall time: 4000 - 1000 = 3000ms
      // Pauses: (2100-2000)=100ms + (3000-2500)=500ms = 600ms
      // Active: 3000 - 600 = 2400ms
      final pauses = [
        {'pause_start': 2000, 'pause_stop': 2100},
        {'pause_start': 2500, 'pause_stop': 3000},
      ];

      final duration = LocalCache.computeDuration(1000, 4000, pauses);

      expect(duration, 2400);
    });

    test('B12b: computeDuration() returns 0 when endEpoch is null', () {
      expect(LocalCache.computeDuration(1000, null, []), 0);
    });

    test('B12c: computeDuration() handles open pauses (ignores unclosed)', () {
      final pauses = [
        {'pause_start': 2000, 'pause_stop': null}, // open pause — ignored
      ];
      expect(LocalCache.computeDuration(1000, 4000, pauses), 3000);
    });

    test('B12d: computeDuration() floors negative to 0', () {
      // Pauses exceed wall time — should return 0, not negative
      final pauses = [
        {'pause_start': 0, 'pause_stop': 9999}, // pause > wall time
      ];
      expect(LocalCache.computeDuration(1000, 2000, pauses), 0);
    });
  });

  group('B: LocalCache — writeEntries()', () {
    // B13
    test('B13: writeEntries() replaces all entries (merge use case)', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      // Add initial entries
      await cache.append(title: 'Old A', startEpoch: 1000);
      await cache.append(title: 'Old B', startEpoch: 2000);

      // Replace all entries
      final newEntries = [
        {
          'entry_id': 'new-id',
          'title': 'Merged Entry',
          'start_epoch': 1500,
          'end_epoch': null,
          'is_active': true,
          'is_paused': false,
          'pauses': <Map<String, dynamic>>[],
          'tags': <String>[],
          'device_uuid': 'dev-x',
          'end_device_uuid': '',
          'metadata': <String, dynamic>{},
          'hash': '',
          'committed': false,
        },
      ];
      await cache.writeEntries(newEntries);

      final entries = await cache.readEntries();
      expect(entries.length, 1);
      expect(entries[0]['title'], 'Merged Entry');
    });
  });

  group('B: LocalCache — Hash Index', () {
    // B15
    test('B15: readHashIndex() / writeHashIndex() roundtrip', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      final index = [
        {'id': 'e1', 'status': 'active'},
        {'id': 'e2', 'status': 'completed'},
      ];

      await cache.writeHashIndex(index);
      final read = await cache.readHashIndex();

      expect(read.length, 2);
      expect(read[0]['id'], 'e1');
      expect(read[1]['id'], 'e2');
    });

    test('B15b: readHashIndex() returns empty list when no index exists', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final cache = LocalCache(storage: storage, crypto: crypto);

      final index = await cache.readHashIndex();
      expect(index, isEmpty);
    });
  });
}
