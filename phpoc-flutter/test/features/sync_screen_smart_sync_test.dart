import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/ledger/engine.dart';
import 'package:phpoc_flutter/data/ledger/store_adapters.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/sync/staging_storage.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/features/sync/sync_screen.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/ledger_backup_service.dart';
import 'package:phpoc_flutter/services/ledger_pull_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';

import 'test_helpers.dart';

/// Smart Sync Button — Phase 2 RED tests (Group B, UI rewiring).
///
/// Blueprint: `docs/planning/flutter/SMART_SYNC_BUTTON_PHASE1.md` (Group B =
/// 4 assertions). Tapping the unified **Sync** button must route through
/// `SyncService.smartSync()`:
///   B1  online + configured → reconcile + push success
///   B2  not configured       → local commit, no error
///   B3  configured + offline → local commit, no error
///   B4  busy-state spinner / disabled while smartSync runs
///
/// RED in Phase 2: written against a SyncScreen rewired to `smartSync()`
/// (Phase 3 change). They fail until `_unifiedSync` routes through `smartSync`
/// and the busy-state spinner covers the smartSync window.

/// In-memory storage backing SyncService.
class _FakeStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
  Map<String, dynamic>? readIndex() => _data['index'];
  void writeIndex(Map<String, dynamic>? data) => _data['index'] = data;
}

/// In-memory remote transport with a configurable health-check failure.
class _MemoryTransport extends HttpTransport {
  final Map<String, Uint8List> remote = {};
  bool throwOnHealthCheck = false;
  int ledgerPushCount = 0;

  _MemoryTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');

  @override
  Future<void> push(String path, Uint8List data) async {
    if (path.startsWith('ledger/')) ledgerPushCount++;
    remote[path] = data;
  }

  @override
  Future<Uint8List?> pull(String path) async => remote[path];

  @override
  Future<List<String>> listFiles(String prefix) async => [];

  @override
  Future<void> delete(String path) async => remote.remove(path);

  @override
  Future<void> healthCheck() async {
    if (throwOnHealthCheck) {
      throw HttpTransportException('offline', 500);
    }
  }
}

Future<CryptoService> _makeCrypto() async {
  final crypto = CryptoService();
  await crypto.initialize();
  crypto.setMasterKey(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  );
  return crypto;
}

/// Build a production-style device harness (shared DB-backed engine + pull +
/// push + transport), plus one ended uncommitted entry so the Sync button is
/// enabled.
class _Device {
  final AppDatabase db;
  final CryptoService crypto;
  final _MemoryTransport transport;
  final StagingStore store;
  final SyncService sync;
  final LedgerPushService push;

  _Device._(this.db, this.crypto, this.transport, this.store, this.sync,
      this.push);

  static Future<_Device> build({bool online = true}) async {
    final crypto = await _makeCrypto();
    final db = AppDatabase.inMemory();
    final store = StagingStore(db);
    final transport = _MemoryTransport();
    transport.throwOnHealthCheck = !online;

    final engine = LedgerEngine(
      crypto: crypto,
      store: LedgerBlockStore(db.blockDao),
      indexStore: LedgerIndexStore(),
      stagingStore: store,
    );
    engine.chain.append(engine.chain.buildGenesisBlock(
      username: 'tester',
      email: 't@example.com',
      recoverySeedEnc: 's',
      identityPubKey: 'pk',
      identitySecretEncFallback: 'f',
    ));

    final backup = LedgerBackupService(db: db);
    final pull = LedgerPullService(
      db: db,
      crypto: crypto,
      transport: transport,
      backupService: backup,
      stagingStorage: StagingStorage(db),
      stagingStore: store,
    );
    final push = LedgerPushService(db: db, crypto: crypto, transport: transport);
    final sync = SyncService(
      storage: _FakeStorage(),
      crypto: crypto,
      transport: transport,
      stagingStore: store,
      ledgerEngine: engine,
      ledgerPull: pull,
      ledgerPush: push,
    );

    // Seed one ended uncommitted entry so the unified Sync button enables.
    final id = await sync.capture(title: 'Smart Sync Task');
    await sync.end(id, 1700001000000);
    sync.dispose(); // stop the debounced auto-push timer; rebuild fresh.
    final sync2 = SyncService(
      storage: _FakeStorage(),
      crypto: crypto,
      transport: transport,
      stagingStore: store,
      ledgerEngine: engine,
      ledgerPull: pull,
      ledgerPush: push,
    );
    return _Device._(db, crypto, transport, store, sync2, push);
  }
}

void main() {
  testWidgets(
    'B1: Sync (online+configured) → smartSync reconciles & reports success',
    (tester) async {
      final device = await _Device.build(online: true);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => device.sync),
            data_providers.ledgerPushServiceProvider
                .overrideWith((ref) => device.push),
          ]);

      final syncButton = find.text('Sync');
      expect(syncButton, findsAtLeastNWidgets(1),
          reason: 'the unified Sync button must be present');
      await tester.tap(syncButton.first);
      await tester.pumpAndSettle();

      // smartSync ran: the ledger was pushed to remote on the online path.
      expect(device.transport.ledgerPushCount, greaterThan(0),
          reason: 'tapping Sync on an online configured device pushes the ledger');
      final rows = await device.store.getAllRows();
      expect(rows.any((r) => r['committed'] == true), isTrue,
          reason: 'the online Sync reconciled and committed the ended entry');
      device.sync.dispose();
      await device.db.close();
    },
  );

  testWidgets(
    'B2: Sync (not configured) → local commit, no error',
    (tester) async {
      final device = await _Device.build(online: true);
      final unconfigured = SyncService(
        storage: _FakeStorage(),
        crypto: device.crypto,
        stagingStore: device.store,
        ledgerEngine: null,
      );

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => unconfigured),
            data_providers.ledgerPushServiceProvider.overrideWith((_) => null),
          ]);

      final syncButton = find.text('Sync').first;
      await tester.tap(syncButton);
      await tester.pumpAndSettle();

      expect(find.byType(SyncScreen), findsOneWidget,
          reason: 'unconfigured Sync must gracefully commit locally (no error)');
      unconfigured.dispose();
      await device.db.close();
    },
  );

  testWidgets(
    'B3: Sync (configured + offline) → local commit, no push, no error',
    (tester) async {
      final device = await _Device.build(online: false);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => device.sync),
            data_providers.ledgerPushServiceProvider
                .overrideWith((ref) => device.push),
          ]);

      final syncButton = find.text('Sync').first;
      await tester.tap(syncButton);
      await tester.pumpAndSettle();

      expect(find.byType(SyncScreen), findsOneWidget,
          reason: 'offline Sync must degrade to a local commit without error');
      // RED (assert contract): an offline device must NOT push the ledger
      // — the smartSync fallback is local-only while the old commitAndSync
      // blindly pushed even when the transport was unreachable.
      expect(device.transport.ledgerPushCount, 0,
          reason: 'offline smartSync must not push ledger blocks to R2');
      // The ended entry is committed locally (marked), not MOVE-deleted.
      final rows = await device.store.getAllRows();
      expect(rows.any((r) => r['committed'] == true), isTrue,
          reason: 'offline smartSync commits locally (marked committed)');
      device.sync.dispose();
      await device.db.close();
    },
  );

  testWidgets(
    'B4: Sync button shows spinner + disables while smartSync runs',
    (tester) async {
      final device = await _Device.build(online: true);

      await pumpScreenWidget(tester, const SyncScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            data_providers.syncServiceProvider
                .overrideWith((ref) => device.sync),
            data_providers.ledgerPushServiceProvider
                .overrideWith((ref) => device.push),
          ]);

      expect(find.text('Sync'), findsAtLeastNWidgets(1));

      // RED (assert contract): while smartSync runs, the unified Sync button
      // shows a busy spinner / "Syncing…" label and is disabled, guarding
      // against double-taps / duplicate pushes.
      final spinner = find.byType(CircularProgressIndicator);
      await tester.tap(find.text('Sync').first);
      await tester.pump();

      expect(
        find.text('Syncing…').evaluate().isNotEmpty ||
            spinner.evaluate().isNotEmpty,
        isTrue,
        reason: 'the Sync button shows a busy spinner / Syncing… during smartSync',
      );
      await tester.pumpAndSettle();
      device.sync.dispose();
      await device.db.close();
    },
  );
}
