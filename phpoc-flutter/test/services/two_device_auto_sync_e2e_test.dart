import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';

/// Two-Device staging auto-sync E2E — controlled test on the testing Worker.
///
/// Proves the Flutter staging auto-sync pipeline works end-to-end when two
/// device instances adopt the same master key (MK) via seed import — the real
/// "phone + emulator" progression where the emulator restores from the phone's
/// recovery seed. Each device keeps its OWN random cookie specifier and
/// device_uuid (import does NOT clone those); they share ONLY the MK. The
/// reconcile path must still pull+merge on MK alone.
///
/// Requires the testing Worker:
///   flutter test --tags=e2e \
///     --dart-define=PHPOC_WORKER_URL=https://phpoc-staging-testing.wacevedo.workers.dev \
///     --dart-define=PHPOC_API_KEY=MKNuQP92x2+fJyNRmoW6w9lTCbDh0lKm \
///     test/services/two_device_auto_sync_e2e_test.dart
///
/// ⚠️ Runs against phpoc-staging-testing... only — never production.

const _envWorkerUrl = String.fromEnvironment(
  'PHPOC_WORKER_URL',
  defaultValue: '',
);
const _envApiKey = String.fromEnvironment(
  'PHPOC_API_KEY',
  defaultValue: '',
);

/// Shared test seed from TEST_CREDENTIALS.md. MK derived via SHA-256(seed bytes).
const _testSeedB64 = 'RtwewIHiZc9fCSUb8HRATJ8T8X5+9CNN1pzMJpFJAl0=';

bool get _shouldRun => _envWorkerUrl.isNotEmpty && _envApiKey.isNotEmpty;

/// Derive the shared MK (hex) from the test seed.
String _deriveMkHex(CryptoService crypto) {
  final seedBytes = base64.decode(_testSeedB64);
  final seedHex = seedBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return crypto.sha256(seedHex);
}

/// In-memory backend. A single [chainStore] holds the ledger blocks+index so
/// both devices append to the same chain; each device gets its own cookie
/// [storage] (separate random cookie specifier) as in the real app.
class _Memory {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);

  // LedgerEngine store plumbing.
  dynamic readIndex() => _data['index'];
  void writeIndex(dynamic data) => _data['index'] = data;
  List<Map<String, dynamic>> readBlocks() =>
      (_data['blocks'] as List?)?.cast<Map<String, dynamic>>() ?? [];
  void appendBlocks(List blocks) {
    _data.putIfAbsent('blocks', () => []);
    (_data['blocks'] as List).addAll(blocks);
  }
  List truncate(int keepCount) {
    final blocks = (_data['blocks'] as List?) ?? [];
    final keep = blocks.sublist(0, keepCount);
    _data['blocks'] = keep;
    return blocks.sublist(keepCount);
  }
  int getBlockCount() => (_data['blocks'] as List?)?.length ?? 0;
  Map<String, dynamic>? getLastBlock() {
    final blocks = _data['blocks'] as List?;
    if (blocks == null || blocks.isEmpty) return null;
    return blocks.last as Map<String, dynamic>;
  }
}

/// Build a device SyncService. [chainStore] (shared ledger blocks+index) and
/// [cookieStorage] (this device's private cookie) may differ — exactly like the
/// real app where the ledger is shared but the cookie is per-device.
Future<SyncService> _makeDevice(
  CryptoService crypto,
  _Memory chainStore,
  _Memory cookieStorage,
  HttpTransport transport,
) async {
  final db = AppDatabase.inMemory();
  final stagingStore = StagingStore(db);
  final engine = LedgerEngine(
    crypto: crypto,
    store: chainStore,
    indexStore: chainStore,
    stagingStore: cookieStorage,
  );
  return SyncService(
    storage: cookieStorage,
    crypto: crypto,
    transport: transport,
    stagingStore: stagingStore,
    ledgerEngine: engine,
  );
}

void main() {
  final _skip = !_shouldRun;
  final _skipReason =
      'Set PHPOC_WORKER_URL and PHPOC_API_KEY dart-defines to run E2E tests';

  group('Two-Device staging auto-sync (shared MK, testing Worker)', () {
    late CryptoService crypto;
    late String mkHex;
    late HttpTransport transport;

    setUpAll(() async {
      if (_skip) return;
      crypto = CryptoService();
      await crypto.initialize();
      mkHex = _deriveMkHex(crypto);
      crypto.setMasterKey(mkHex);
      transport = HttpTransport(baseUrl: _envWorkerUrl, apiKey: _envApiKey);
    });

    test("Device B pulls Device A's captured row via staging auto-sync",
        () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      final chain = _Memory();
      final phoneStorage = _Memory(); // phone's own random cookie

      // Device A = "phone". Capture a pending entry.
      final phone = await _makeDevice(crypto, chain, phoneStorage, transport);
      final activityId = await phone.capture(title: 'Phone Task');
      await phone.end(activityId, DateTime.now().millisecondsSinceEpoch);
      // Device A sync pushes its uncommitted row to R2 staging.
      await phone.checkAndSync();

      // Device B = "emulator": same MK (seed import) but OWN random cookie.
      final emuStorage = _Memory();
      final emu = await _makeDevice(crypto, chain, emuStorage, transport);
      // initialPull() forces a full reconcile (pull + merge) rather than the
      // F1 read-only fast-path, which would short-circuit with no pending
      // writes and never fetch Device A's remote row.
      await emu.initialPull();

      final entries = await emu.getEntries();
      expect(entries.any((e) => e['title'] == 'Phone Task'), isTrue,
          reason: "Emulator must pull the phone's uncommitted staging row");
    });

    test('Device B can commit the pulled row into its ledger',
        () async {
      if (_skip) {
        print('SKIP: $_skipReason');
        return;
      }

      final chain = _Memory();
      final phoneStorage = _Memory();
      final phone = await _makeDevice(crypto, chain, phoneStorage, transport);
      final activityId = await phone.capture(title: 'Commit Task');
      await phone.end(activityId, DateTime.now().millisecondsSinceEpoch);
      await phone.checkAndSync();

      final emuStorage = _Memory();
      final emu = await _makeDevice(crypto, chain, emuStorage, transport);
      await emu.initialPull();

      // There should be one ended, uncommitted row to commit on B.
      final hash = await emu.commitEntries();
      expect(hash, isNotNull,
          reason: 'Emulator must commit the pulled ended row to its ledger');
    });
  });
}
