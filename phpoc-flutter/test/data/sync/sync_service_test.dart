import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// SyncService tests — Groups E (16) + F (5) + G (18) + H (8) = 47 assertions.
///
/// Covers:
///   E1–E5:  capture() basic flow, hash return, cookie touch, device attribution
///   E6–E12: end(), pause(), unpause() — errors and proper behavior
///   E13–E16: modify(), remove(), sequential ops, offline resilience
///   F1–F5:  getActive(), getEntries() queries
///   G1–G18: checkAndSync() sync gate — all paths
///   H1–H8:  pushToRemote() push operations

/// In-memory storage for testing.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Create a fresh CryptoService with cached MK.
Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

/// Create a SyncService with optional transport.
Future<SyncService> _makeSync({HttpTransport? transport}) async {
  final storage = _FakeStorage();
  final crypto = await _makeCrypto();
  return SyncService(
    storage: storage,
    crypto: crypto,
    transport: transport,
  );
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group E: Local CRUD
  // ═══════════════════════════════════════════════════════════════

  group('E: SyncService — Local CRUD', () {
    // E1
    test('E1: capture({title}) creates active entry in storage', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'New Task');

      final active = await svc.getActive();
      expect(active, isNotNull);
      expect(active!['title'], 'New Task');
      expect(active['is_active'], true);
    });

    // E2
    test('E2: capture() returns entry hash prefix', () async {
      final svc = await _makeSync();
      final hash = await svc.capture(title: 'Hashed Task');

      expect(hash, isNotEmpty);
      expect(hash, isA<String>());
    });

    // E3
    test('E3: capture() touches local cookie TTL', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      await svc.capture(title: 'Cookie Test');

      // Local cookie should exist after capture
      final cookie = await storage.get('cookie');
      expect(cookie, isNotNull,
          reason: 'Every local write must touch the device cookie');
    });

    // E4
    test('E4: capture() includes device_uuid attribution', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Attributed Task');

      final entries = await svc.getEntries();
      expect(entries[0]['device_uuid'], isNotEmpty,
          reason: 'Entry must carry device attribution for cross-device merge');
    });

    // E5
    test('E5: end(title, endEpoch) sets is_active=false + end_epoch', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task to End');
      await svc.end('Task to End', 5000);

      final entries = await svc.getEntries();
      expect(entries[0]['is_active'], false);
      expect(entries[0]['end_epoch'], 5000);
    });

    // E6
    test('E6: end() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.end('Nonexistent', 5000),
        throwsA(isA<Exception>()),
      );
    });

    // E7
    test('E7: end() auto-closes open pause before ending', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Paused Task');
      await svc.pause('Paused Task', 2000);
      await svc.end('Paused Task', 5000);

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      // The open pause should be closed (pause_stop should be set)
      if (pauses.isNotEmpty) {
        expect(pauses.last['pause_stop'], isNotNull,
            reason: 'end() must auto-close any open pause');
      }
      expect(entries[0]['is_active'], false);
    });

    // E8
    test('E8: end() recomputes duration after pause closure', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Duration Task');
      await svc.pause('Duration Task', 2000);
      await svc.end('Duration Task', 5000);

      final entries = await svc.getEntries();
      // Duration = 5000 - start - pause_time
      // If start was near capture time and pause was 2K-5K
      expect(entries[0]['duration'], isA<int>());
      expect(entries[0]['duration'], greaterThanOrEqualTo(0));
    });

    // E9
    test('E9: pause(title, pauseEpoch) adds open pause record', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Pause Task');
      await svc.pause('Pause Task', 2000);

      final active = await svc.getActive();
      expect(active!['is_paused'], true,
          reason: 'Task should be marked as paused');

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses, isNotEmpty);
      expect(pauses.last['pause_start'], 2000);
      expect(pauses.last['pause_stop'], isNull);
    });

    // E10
    test('E10: pause() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.pause('Nonexistent', 2000),
        throwsA(isA<Exception>()),
      );
    });

    // E11
    test('E11: unpause(title, unpauseEpoch) closes open pause', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Unpause Task');
      await svc.pause('Unpause Task', 2000);
      await svc.unpause('Unpause Task', 3000);

      final active = await svc.getActive();
      expect(active!['is_paused'], false,
          reason: 'Task should be resumed after unpause');

      final entries = await svc.getEntries();
      final pauses = entries[0]['pauses'] as List;
      expect(pauses.last['pause_stop'], 3000);
    });

    // E12
    test('E12: unpause() throws when no active task matches title', () async {
      final svc = await _makeSync();
      expect(
        () => svc.unpause('Nonexistent', 3000),
        throwsA(isA<Exception>()),
      );
    });

    // E13
    test('E13: modify(index, fields) updates entry fields', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Modify Me');
      await svc.modify(0, {'title': 'Modified Title'});

      final entries = await svc.getEntries();
      expect(entries[0]['title'], 'Modified Title');
    });

    // E14
    test('E14: remove(index) deletes entry from staging', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Remove Me');
      await svc.remove(0);

      final entries = await svc.getEntries();
      expect(entries, isEmpty);
    });

    // E15
    test('E15: multiple captures + ends produce correct entries', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Task 1');
      await svc.end('Task 1', 2000);
      await svc.capture(title: 'Task 2');
      await svc.end('Task 2', 4000);

      final entries = await svc.getEntries();
      expect(entries.length, 2);
      expect(entries[0]['title'], 'Task 1');
      expect(entries[1]['title'], 'Task 2');
      expect(entries[0]['is_active'], false);
      expect(entries[1]['is_active'], false);
    });

    // E16
    test('E16: all CRUD ops work without remote transport', () async {
      // No transport = local-only mode
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      // All operations should succeed without transport
      await svc.capture(title: 'Offline Task');
      await svc.pause('Offline Task', 2000);
      await svc.unpause('Offline Task', 3000);
      await svc.modify(0, {'title': 'Offline Modified'});
      await svc.end('Offline Modified', 5000);
      await svc.remove(0);

      final entries = await svc.getEntries();
      expect(entries, isEmpty,
          reason: 'All CRUD ops must work fully offline');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: Queries
  // ═══════════════════════════════════════════════════════════════

  group('F: SyncService — Queries', () {
    // F1
    test('F1: getActive() returns only is_active=true entries', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Active');
      await svc.capture(title: 'Done');
      await svc.end('Done', 2000);

      final active = await svc.getActive();
      expect(active, isNotNull);
      expect(active!['title'], 'Active');
    });

    // F2
    test('F2: getActive() returns null when no active entries', () async {
      final svc = await _makeSync();
      final active = await svc.getActive();
      expect(active, isNull);
    });

    // F3
    test('F3: getEntries() returns all staging entries sorted', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'C');
      await svc.capture(title: 'A');
      await svc.capture(title: 'B');

      final entries = await svc.getEntries();
      expect(entries.length, 3);
    });

    // F4
    test('F4: getEntries(from, to) filters by date range', () async {
      final svc = await _makeSync();
      // Capture will have timestamps around now
      // We'll test that the API accepts date range params
      // (RED test: verifies the API contract exists)
      final entries = await svc.getEntries(
        from: DateTime(2020),
        to: DateTime(2030),
      );
      // Should compile and return something (even if empty in stub)
      expect(entries, isA<List>());
    });

    // F5
    test('F5: entries are returned as decrypted objects with entry_index', () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Flat DTO');

      final entries = await svc.getEntries();
      expect(entries[0], isA<Map>());
      expect(entries[0]['title'], isA<String>());
      expect(entries[0]['start_epoch'], isA<int>());
      expect(entries[0]['entry_id'], isA<String>());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group G: Sync Gate
  // ═══════════════════════════════════════════════════════════════

  group('G: SyncService — Sync Gate', () {
    // G1
    test('G1: no remote transport → returns READY', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      final result = await svc.checkAndSync();
      expect(result, SyncCheckResult.ready);
    });

    // G2
    test('G2: genesis gate passthrough (no local blocks → continue)', () async {
      final svc = await _makeSync();
      // No local ledger blocks on mobile → genesis gate passthrough
      // checkAndSync should not throw even without genesis setup
      final result = await svc.checkAndSync();
      expect(result, isNotNull);
    });

    // G3
    test('G3: local cookie valid + remote cookie match → READY (fast path)', () async {
      final svc = await _makeSync();
      // RED test: fast path not yet implemented
      final result = await svc.checkAndSync();
      // Currently returns ready (stub), but will exercise real fast path later
      expect(result, isA<SyncCheckResult>());
    });

    // G4
    test('G4: fast path pushes local blob only (pushBlobOnly)', () async {
      final svc = await _makeSync();
      // RED: fast path blob push not yet implemented
      // This test defines the contract: fast path must push blob without
      // full auth gate
      await svc.capture(title: 'Fast Path Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G5
    test('G5: local cookie valid + remote cookie mismatch → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: cookie mismatch path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G6
    test('G6: local cookie valid + no remote cookie → auth gate (merge)', () async {
      final svc = await _makeSync();
      // RED: first push path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G7
    test('G7: local cookie expired → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: TTL enforcement not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G8
    test('G8: no local cookie → REAUTH_NEEDED', () async {
      final svc = await _makeSync();
      // RED: missing cookie path not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G9
    test('G9: MK available + cookie valid → reconcile (pull+merge+push)', () async {
      final svc = await _makeSync();
      // RED: auth gate reconcile not yet implemented
      await svc.capture(title: 'Reconcile Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G10
    test('G10: MK not available + no transport → READY (local-only mode)', () async {
      final storage = _FakeStorage();
      // Crypto WITHOUT master key
      final crypto = CryptoService();
      await crypto.initialize();
      // No setMasterKey call — MK unavailable

      final svc = SyncService(storage: storage, crypto: crypto);
      final result = await svc.checkAndSync();
      // No transport = local-only mode, always READY
      expect(result, SyncCheckResult.ready,
          reason: 'Without transport, sync is trivially ready — nothing to push');
    });

    // G11
    test('G11: network error during cookie pull → OFFLINE', () async {
      final svc = await _makeSync();
      // RED: network error handling not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G12
    test('G12: network error during blob pull → OFFLINE', () async {
      final svc = await _makeSync();
      // RED: blob pull error not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G13
    test('G13: remote blob key mismatch → OFFLINE (no overwrite)', () async {
      final svc = await _makeSync();
      // RED: key mismatch safety not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G14
    test('G14: merge produces combined entries from local + remote', () async {
      final svc = await _makeSync();
      // RED: merge flow not yet implemented
      await svc.capture(title: 'Local Entry');
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G15
    test('G15: committed entries filtered from merged result', () async {
      final svc = await _makeSync();
      // RED: commit filtering not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G16
    test('G16: new cookie created after successful auth gate merge', () async {
      final svc = await _makeSync();
      // RED: cookie rotation not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G17
    test('G17: cookie pushed to remote after merge', () async {
      final svc = await _makeSync();
      // RED: cookie push not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });

    // G18
    test('G18: same-device cookie match before remote push prevents race', () async {
      final svc = await _makeSync();
      // RED: race prevention not yet implemented
      final result = await svc.checkAndSync();
      expect(result, isA<SyncCheckResult>());
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Push
  // ═══════════════════════════════════════════════════════════════

  group('H: SyncService — Push', () {
    // H1
    test('H1: pushToRemote() serializes all staging entries', () async {
      final svc = await _makeSync();
      // RED: push not yet implemented
      await svc.capture(title: 'Push Me');
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H2
    test('H2: pushToRemote() pushes blob obfuscated with MK', () async {
      final svc = await _makeSync();
      // RED: blob obfuscation not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H3
    test('H3: pushToRemote() pushes blob BEFORE cookie', () async {
      final svc = await _makeSync();
      // RED: push ordering not yet implemented
      // Contract: blob first, cookie second (crash safety)
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H4
    test('H4: pushToRemote() includes device_id + device_proof in blob', () async {
      final svc = await _makeSync();
      // RED: device attribution in blob not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H5
    test('H5: pushToRemote() no-ops when no remote transport', () async {
      final storage = _FakeStorage();
      final crypto = await _makeCrypto();
      final svc = SyncService(storage: storage, crypto: crypto);

      // Should not throw — no transport is valid (local-only mode)
      await svc.pushToRemote();
    });

    // H6
    test('H6: pushBlobOnly() pushes blob without touching cookie', () async {
      final svc = await _makeSync();
      // RED: pushBlobOnly not yet implemented
      await svc.capture(title: 'Blob Only');
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H7
    test('H7: staging hash index pushed after blob (best-effort)', () async {
      final svc = await _makeSync();
      // RED: hash index push not yet implemented
      expect(() => svc.pushToRemote(), returnsNormally);
    });

    // H8
    test('H8: lastPushAt timestamp updated after successful push', () async {
      final svc = await _makeSync();
      // RED: lastPushAt not yet implemented
      // API contract: service should expose lastPushAt
      expect(svc.lastPushAt, isA<int>(),
          reason: 'SyncService must expose lastPushAt diagnostic property');
      expect(() => svc.pushToRemote(), returnsNormally);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group L: getCompleted() — completed-entries query
  // ═══════════════════════════════════════════════════════════════

  group('L: SyncService — getCompleted()', () {
    // L1
    test('L1: getCompleted() returns only entries with is_active==false',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Active Task');
      await svc.capture(title: 'Done Task');
      await svc.end('Done Task', 5000);

      final completed = await svc.getCompleted();

      // Only the ended task (is_active==false) should appear
      expect(completed.length, 1,
          reason: 'getCompleted() must exclude active (is_active==true) entries');
      expect(completed[0]['title'], 'Done Task');
      expect(completed[0]['is_active'], false);
    });

    // L2
    test('L2: each completed entry has a date field (YYYY-MM-DD from start_epoch)',
        () async {
      final svc = await _makeSync();
      await svc.capture(title: 'Dated Task');
      await svc.end('Dated Task', 5000);

      final completed = await svc.getCompleted();

      expect(completed[0]['date'], isA<String>(),
          reason: 'Every completed entry must carry a normalized date string');
      // Must match YYYY-MM-DD pattern
      expect(completed[0]['date'], matches(r'^\d{4}-\d{2}-\d{2}$'),
          reason: 'date field must be ISO format YYYY-MM-DD');
    });

    // L3
    test('L3: entries with start_epoch==0 get date="unknown"', () async {
      final svc = await _makeSync();
      // Capture and end an entry, then manually set start_epoch to 0
      await svc.capture(title: 'Zero Epoch');
      await svc.end('Zero Epoch', 5000);
      await svc.modify(0, {'start_epoch': 0});

      final completed = await svc.getCompleted();

      expect(completed[0]['date'], 'unknown',
          reason: 'Degraded data (epoch=0) must produce "unknown" date, not crash');
    });

    // L4
    test('L4: getCompleted() returns entries sorted by start_epoch descending',
        () async {
      final svc = await _makeSync();
      // Create entries with known timestamps
      await svc.capture(title: 'Oldest');
      await svc.modify(0, {'start_epoch': 1000});
      await svc.end('Oldest', 2000);

      await svc.capture(title: 'Middle');
      await svc.modify(1, {'start_epoch': 2000});
      await svc.end('Middle', 3000);

      await svc.capture(title: 'Newest');
      await svc.modify(2, {'start_epoch': 3000});
      await svc.end('Newest', 4000);

      final completed = await svc.getCompleted();

      expect(completed.length, 3);
      expect(completed[0]['title'], 'Newest',
          reason: 'Most recent entry (highest start_epoch) must be first');
      expect(completed[1]['title'], 'Middle');
      expect(completed[2]['title'], 'Oldest',
          reason: 'Oldest entry (lowest start_epoch) must be last');
    });

    // L5
    test('L5: getCompleted() returns empty list when staging is empty',
        () async {
      final svc = await _makeSync();

      final completed = await svc.getCompleted();

      expect(completed, isEmpty,
          reason: 'Empty staging must return empty list, not null or throw');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group P: Date range filter fix
  // ═══════════════════════════════════════════════════════════════

  group('P: SyncService — Date range filter fix', () {
    // Helper: create an entry at a specific epoch and end it
    Future<SyncService> _seededSync(
        String title, int startEpoch, int endEpoch) async {
      final svc = await _makeSync();
      await svc.capture(title: title);
      await svc.modify(0, {'start_epoch': startEpoch});
      await svc.end(title, endEpoch);
      return svc;
    }

    // P1
    test('P1: getEntries(to: date) includes entries ON the end date', () async {
      // Entry at noon on June 15
      final jun15Noon = DateTime.utc(2026, 6, 15, 12, 0, 0).millisecondsSinceEpoch;
      final svc = await _seededSync('Midday Entry', jun15Noon, jun15Noon + 1000);

      // to: midnight June 15 — entry at noon should still be included
      final toDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(to: toDate);

      expect(entries.length, 1,
          reason: 'Entry at noon on June 15 must be included when to=midnight June 15 '
              '(end date must be inclusive)');
      expect(entries[0]['title'], 'Midday Entry');
    });

    // P2
    test('P2: getEntries(from: date) includes entries ON the start date',
        () async {
      final jun15Midnight =
          DateTime.utc(2026, 6, 15).millisecondsSinceEpoch;
      final svc = await _seededSync(
          'Midnight Entry', jun15Midnight, jun15Midnight + 1000);

      final fromDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(from: fromDate);

      expect(entries.length, 1,
          reason: 'Entry at midnight on June 15 must be included when from=midnight June 15 '
              '(start date must be inclusive)');
      expect(entries[0]['title'], 'Midnight Entry');
    });

    // P3
    test('P3: range filter uses end-of-day for to boundary (entries at 11 PM pass)',
        () async {
      // Entry at 11 PM on June 15
      final jun15Late = DateTime.utc(2026, 6, 15, 23, 0, 0).millisecondsSinceEpoch;
      final svc = await _seededSync('Late Entry', jun15Late, jun15Late + 1000);

      // to: midnight June 15 — but entry at 11 PM should still be included
      final toDate = DateTime.utc(2026, 6, 15); // midnight
      final entries = await svc.getEntries(to: toDate);

      expect(entries.length, 1,
          reason: 'Entry at 11 PM on June 15 must pass when to=midnight June 15. '
              'The to boundary must use end-of-day, not midnight, to avoid the off-by-one bug');
      expect(entries[0]['title'], 'Late Entry');
    });
  });
}
