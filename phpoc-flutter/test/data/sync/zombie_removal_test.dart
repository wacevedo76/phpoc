import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// Z1–Z10: `_pushBlobOnly()` / legacy `LocalCache`-blob zombie removal (RED).
///
/// Blueprint: docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE1.md (Option A — full
/// legacy-LocalCache retirement).
///
/// These tests define the *row-level-only end-state* from the Phase 1 Group Z
/// blueprint. They are RED today because the live legacy fallback still exists
/// in `sync_service.dart` (nullable `stagingStore`, `_pushBlobOnly`,
/// `remoteStagingBlob` paths, `commitEntries`, `_local.*` read branches).
/// After Phase 3 deletes the legacy branches and makes `stagingStore`
/// required, every assertion below flips GREEN.
///
/// Assertions use a two-pronged strategy:
///   * **Source-probe** tests read `lib/data/sync/sync_service.dart` (and, for
///     Z8/Z9, the legacy test files) and assert the legacy symbols are gone.
///     This makes "the code is deleted" assertions runnable and RED now.
///   * **Behavioral** tests construct a row-level `SyncService` (real
///     `StagingStore`) with a transport spy and assert only row-level paths
///     are ever touched — never `StagingPaths.remoteStagingBlob`.

// ═══════════════════════════════════════════════════════════════
// Source-probe infrastructure
// ═══════════════════════════════════════════════════════════════

String _readSource(String relPath) {
  final candidates = [
    '${Directory.current.path}/$relPath', // cwd = phpoc-flutter/
    '${Directory.current.path}/../phpoc-flutter/$relPath',
  ];
  for (final p in candidates) {
    final f = File(p);
    if (f.existsSync()) return f.readAsStringSync();
  }
  throw StateError('Cannot locate source: $relPath (tried $candidates)');
}

String _syncServiceSource() => _readSource('lib/data/sync/sync_service.dart');

/// Assert a legacy symbol is fully absent from [source].
void _expectAbsent(String source, String symbol, {required String why}) {
  expect(
    source.contains(symbol),
    isFalse,
    reason: '$symbol must be removed. $why',
  );
}

// ═══════════════════════════════════════════════════════════════
// Behavioral infrastructure (row-level only)
// ═══════════════════════════════════════════════════════════════

class _InMemoryStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Transport spy recording every push/pull path.
class _SpyTransport extends HttpTransport {
  final List<String> pushPaths = [];
  final List<String> pullPaths = [];

  _SpyTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  @override
  Future<Uint8List?> pull(String path) async {
    pullPaths.add(path);
    return null;
  }

  @override
  Future<void> push(String path, Uint8List data) async {
    pushPaths.add(path);
  }

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async {}
}

/// Build a row-level SyncService (real StagingStore) for behavioral tests.
Future<SyncService> _rowLevelService(
  _SpyTransport spy,
  _InMemoryStorage storage,
  CryptoService crypto,
) async {
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);
  return SyncService(
    storage: storage,
    crypto: crypto,
    transport: spy,
    stagingStore: stagingStore,
  );
}

/// A CryptoService with a master key set (so obfuscation works).
Future<CryptoService> _readyCrypto() async {
  final crypto = CryptoService();
  crypto.initialize();
  // Simulate a configured 32-byte master key (test key, not a real secret).
  crypto.setMasterKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  return crypto;
}

// ═══════════════════════════════════════════════════════════════
// Group Z — Zombie Removal
// ═══════════════════════════════════════════════════════════════

void main() {
  group('Z: Zombie Removal — legacy LocalCache blob retirement', () {
    test(
        'Z1: SyncService.stagingStore is required (non-nullable) — '
        'no LocalCache fallback possible', () {
      final src = _syncServiceSource();
      // After Option A, the field must be required, not `StagingStore?`.
      _expectAbsent(
        src,
        'StagingStore? stagingStore;',
        why: 'Option A makes stagingStore required so the legacy LocalCache '
            'fallback is impossible at the type level.',
      );
    });

    test('Z2: `_pushBlobOnly()` no longer exists in sync_service.dart', () {
      final src = _syncServiceSource();
      _expectAbsent(
        src,
        '_pushBlobOnly',
        why: 'The blob-only push is the zombie: after retirement the remote '
            'staging blob is only ever written via row-level _pushStagingRowsToRemote.',
      );
    });

    test(
        'Z3: checkAndSync() fast path always calls the row-level fast path — '
        'no _pushBlobOnly() fallback branch', () {
      final src = _syncServiceSource();
      // The legacy branch: `else { await _pushBlobOnly(); }`.
      _expectAbsent(
        src,
        'await _pushBlobOnly();',
        why: 'checkAndSync must not have a stagingStore==null blob fallback in '
            'its cookie-match fast path.',
      );
    });

    test(
        'Z4: _reconcileAndClaim() always uses row-level reconcile — '
        'no LocalCache mergeMaps() path', () {
      final src = _syncServiceSource();
      _expectAbsent(
        src,
        'MergeEngine.mergeMaps',
        why: 'The legacy reconcile (LocalCache entries + mergeMaps) is deleted; '
            'only _reconcileAndClaimRowLevel (MergeEngine.mergeEntries) remains.',
      );
      _expectAbsent(
        src,
        'LocalCache + mergeMaps',
        why: 'The legacy _reconcileAndClaim body that merges LocalCache entries '
            'via mergeMaps() must be gone — only row-level reconcile remains.',
      );
    });

    test(
        'Z5: pushToRemote() always pushes row-level + hash index — '
        'no blob push or legacy readHashIndex()', () {
      final src = _syncServiceSource();
      _expectAbsent(
        src,
        '_pushBlobOnly();\n    await _pushCookie',
        why: 'pushToRemote must never fall back to the blob-only push.',
      );
      _expectAbsent(
        src,
        '_local.readHashIndex()',
        why: 'The legacy LocalCache hash-index read in pushToRemote is deleted; '
            'only StagingHashIndex.build(stagingStore) remains.',
      );
    });

    test('Z6: _pullRemoteBlob() always reads the row-level blob path', () {
      final src = _syncServiceSource();
      _expectAbsent(
        src,
        'StagingPaths.remoteStagingBlob',
        why: 'No code path (pull or push) may reference the legacy monolithic '
            'staging blob path after retirement.',
      );
    });

    test(
        'Z7: all mutations (capture/end/pause/unpause/modify/remove) and the '
        'by-entry-id variants use stagingStore only', () {
      final src = _syncServiceSource();
      // Legacy mutation fallback bodies read/write LocalCache entries.
      _expectAbsent(
        src,
        'final hash = await _local.append(',
        why: 'capture() must generate a row-level activity_id, not a LocalCache '
            'blob hash.',
      );
      _expectAbsent(
        src,
        'endByEntryId(entries[foundIndex][\'entry_id\'] as String',
        why: 'end() must operate on stagingStore rows, not legacy entry indices.',
      );
      _expectAbsent(
        src,
        'await _local.closePause(foundIndex, endEpoch);',
        why: 'end/pause/unpause by entry id must route through reset time-based '
            'row operations, not LocalCache pause list mutations.',
      );
      _expectAbsent(
        src,
        '_local.markCommitted',
        why: 'The legacy commitEntries() LocalCache path is deleted.',
      );
    });

    test(
        'Z8: legacy test files construct SyncService with a real StagingStore',
        () {
      // Every file that builds a SyncService must pass stagingStore:.
      const affected = [
        'test/data/sync/sync_service_test.dart',
        'test/data/sync/sync_integration_test.dart',
        'test/data/sync/restore_integration_test.dart',
        'test/data/sync/restore_pull_test.dart',
        'test/data/sync/legacy_compat_test.dart',
        'test/features/encrypted_entry_display_test.dart',
        'test/features/history_screen_test.dart',
        'test/features/onboarding_screen_test.dart',
        'test/features/sync_screen_test.dart',
        'test/features/sync_screen_overhaul_test.dart',
        'test/features/test_helpers.dart',
        'test/debug_sync.dart',
      ];
      for (final f in affected) {
        final src = _readSource(f);
        // Row-level construction must include a stagingStore: argument.
        final constructors = _constructorSites(src);
        for (final site in constructors) {
          expect(
            site.contains('stagingStore:'),
            isTrue,
            reason: '$f constructs SyncService without stagingStore: — must '
                'migrate to a real StagingStore (Z8).',
          );
        }
      }
    });

    test(
        'Z9: legacy blob assertions (M1/M2/Q1/Q2, remoteStagingBlob path '
        'checks) are removed from sync_service_test.dart', () {
      final src = _readSource('test/data/sync/sync_service_test.dart');
      // The old assertions directly asserted the canonical blob path.
      _expectAbsent(
        src,
        'StagingPaths.remoteStagingBlob',
        why: 'Legacy tests that assert _pushBlobOnly → remoteStagingBlob '
            '(M1/M2/Q1/Q2) must be removed or migrated to row-level paths.',
      );
    });

    test('Z10: no legacy blob path is touched by any row-level behavior '
        '(behavioral end-state)', () async {
      final storage = _InMemoryStorage();
      final crypto = await _readyCrypto();
      final spy = _SpyTransport();
      final svc = await _rowLevelService(spy, storage, crypto);

      // Drive a full mutation + fast-path reconcile cycle.
      final id = await svc.capture(title: 'Z10 row-level entry');
      expect(id, isNotEmpty);
      await svc.end(id, DateTime.now().millisecondsSinceEpoch);
      await svc.pushToRemote();
      await svc.checkAndSync();

      // Row-level-only end-state: never touch the legacy monolithic blob
      // (StagingPaths.remoteStagingBlob = 'staging/blobs/current.json'). The
      // device-cookie path (staging/blobs/device_cookie.bin) is legitimate and
      // retained — only the monolithic current.json blob is the zombie.
      const legacyBlob = 'staging/blobs/current.json';
      expect(
        spy.pushPaths.where((p) => p.contains(legacyBlob)).toList(),
        isEmpty,
        reason: 'After retirement, no row-level operation may push the legacy '
            'monolithic staging/blobs/current.json blob.',
      );
      expect(
        spy.pullPaths.where((p) => p.contains(legacyBlob)).toList(),
        isEmpty,
        reason: 'Row-level pulls read staging/blob, never staging/blobs/current.json.',
      );
      // Row-level paths must have been exercised.
      expect(spy.pushPaths, contains('staging/blob'),
          reason: 'Row-level push uses remoteRowLevelBlob (staging/blob).');
    });
  });
}

/// Extract every SyncService( ... ) constructor-call block from [src]
/// so Z8 can check each includes a stagingStore: argument.
List<String> _constructorSites(String src) {
  final out = <String>[];
  final marker = 'SyncService(';
  var i = 0;
  while (true) {
    final idx = src.indexOf(marker, i);
    if (idx == -1) break;
    // Only match `SyncService(` as a standalone token — a preceding
    // identifier character (e.g. `_seededSyncService(`) is a different
    // function, not a SyncService constructor call.
    if (idx > 0 && RegExp(r'[A-Za-z0-9_]').hasMatch(src[idx - 1])) {
      i = idx + marker.length;
      continue;
    }
    // Grab from the marker to the matching close paren, balancing parens.
    // Start depth at 1 to account for the `SyncService(` opening paren, so
    // nested constructor args (e.g. StagingStore(...), _FakeStorage()) don't
    // prematurely close the block.
    var depth = 1;
    var j = idx + marker.length;
    for (; j < src.length; j++) {
      final c = src[j];
      if (c == '(') {
        depth++;
      } else if (c == ')') {
        depth--;
        if (depth == 0) {
          out.add(src.substring(idx, j + 1));
          break;
        }
      }
    }
    if (depth != 0) break; // unbalanced — stop scanning defensively
    i = j + 1;
  }
  return out;
}
