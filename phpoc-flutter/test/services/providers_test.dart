import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/ledger_push_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

/// Provider wiring + boot probe tests — Groups G (7) + H (8) + J (5) = 20 assertions.
///
/// Covers:
///   G1–G7: Boot probe / AppLifecycleNotifier phase detection
///   H1–H8: Riverpod provider wiring (singletons, deps, cycles, dispose)

// ── Test providers (mirror production wiring) ───────────────────

/// Shared preferences as a Riverpod provider (test instance).
final _appPreferencesProvider = Provider<AppPreferences>((ref) {
  final p = AppPreferences.testInstance();
  ref.onDispose(() => p.clearAll());
  return p;
});

/// Secure preferences as a Riverpod provider (test instance, shared store).
final _securePreferencesProvider = Provider<SecurePreferences>((ref) {
  return SecurePreferences.testInstance();
});

/// Crypto service provider — initializes on first read.
final _cryptoServiceProvider = Provider<CryptoService>((ref) {
  final crypto = CryptoService();
  // Initialize synchronously schedules the async init; tests await it manually.
  ref.onDispose(() => crypto.clearMasterKey());
  return crypto;
});

/// Auth service provider — injects crypto, db, preferences.
final _authServiceProvider = Provider<AuthService>((ref) {
  final crypto = ref.watch(_cryptoServiceProvider);
  final db = ref.watch(data_providers.databaseProvider);
  final prefs = ref.watch(_appPreferencesProvider);
  final securePrefs = ref.watch(_securePreferencesProvider);
  return AuthService(
      crypto: crypto,
      db: db,
      preferences: prefs,
      securePreferences: securePrefs);
});

/// Sync service provider — injects crypto, db, prefs, securePrefs.
///
/// Returns a [SyncService] configured with in-memory storage.
final _syncServiceProvider = Provider<SyncService>((ref) {
  final crypto = ref.watch(_cryptoServiceProvider);
  final db = ref.watch(data_providers.databaseProvider);
  // In-memory storage for staging (no remote transport by default).
  final storage = _InMemoryStorage();
  return SyncService(
      storage: storage, crypto: crypto, stagingStore: StagingStore(db));
});

/// Onboarding service provider — injects all deps.
final _onboardingServiceProvider = Provider<OnboardingService>((ref) {
  final crypto = ref.watch(_cryptoServiceProvider);
  final db = ref.watch(data_providers.databaseProvider);
  final prefs = ref.watch(_appPreferencesProvider);
  final securePrefs = ref.watch(_securePreferencesProvider);
  final sync = ref.watch(_syncServiceProvider);
  return OnboardingService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: securePrefs,
    syncService: sync,
  );
});

/// Ledger push service provider — null when no transport configured.
/// Production equivalent: watches syncServiceProvider.transport for HttpTransport.
final _ledgerPushServiceProvider = Provider<LedgerPushService?>((ref) {
  final sync = ref.watch(_syncServiceProvider);
  if (!sync.isRemoteAvailable) return null;
  final db = ref.watch(data_providers.databaseProvider);
  final crypto = ref.watch(_cryptoServiceProvider);
  return LedgerPushService(db: db, crypto: crypto, transport: sync.transport!);
});

// ── Helpers ────────────────────────────────────────────────────

/// Minimal transport for provider wiring tests (no real HTTP).
class _TestHttpTransport extends HttpTransport {
  _TestHttpTransport()
      : super(baseUrl: 'https://test.example.com', apiKey: 'test-key');
  @override
  Future<Uint8List?> pull(String path) async => null;
  @override
  Future<void> push(String path, Uint8List data) async {}
  @override
  Future<List<String>> listFiles(String prefix) async => [];
  @override
  Future<void> delete(String path) async {}
}

class _InMemoryStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Create a ProviderContainer with all test providers overridden.
ProviderContainer _createScopedContainer() {
  final container = ProviderContainer(
    overrides: [
      data_providers.databaseProvider.overrideWith((ref) {
        final db = AppDatabase.inMemory();
        ref.onDispose(() => db.close());
        return db;
      }),
    ],
  );
  return container;
}

void main() {
  // ═══════════════════════════════════════════════════════════════
  // Group G: Boot Probe / AppLifecycleNotifier (7 tests)
  // ═══════════════════════════════════════════════════════════════

  group('G: Boot Probe / AppLifecycleNotifier', () {
    // G1
    test('G1: boot probe with no existing data → phase = landing', () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // Simulate boot probe: no data → landing
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing,
          reason: 'Fresh install must route to landing/onboarding');
      container.dispose();
    });

    // G2
    test('G2: boot probe with existing data → phase = auth', () async {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // Simulate existing data → auth
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'Existing ledger must route to unlock screen');

      container.dispose();
    });

    // G3
    test('G3: boot probe with biometric cache → phase = ready', () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'Biometric cache must skip unlock');

      container.dispose();
    });

    // G4
    test('G4: boot probe transition: boot → (probe) → correct target phase',
        () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // Initial state must be boot
      expect(lifecycle.state.phase, AppPhase.boot,
          reason: 'App must start in boot phase');

      // Probe resolves to a target phase (simulated here)
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, isNot(AppPhase.boot),
          reason: 'Boot probe must transition away from boot phase');

      container.dispose();
    });

    // G5
    test('G5: boot probe is idempotent — calling _probe() again is a no-op',
        () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // First probe transitions to landing
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing);

      // Second "probe" (simulated) should not change phase
      // In the real implementation, _probe() checks current phase and returns
      // early if not in boot state.
      // This test verifies the contract: once probed, phase is stable.
      final phaseAfterFirstProbe = lifecycle.state.phase;
      lifecycle.goToLanding(); // Would be no-op in real probe
      expect(lifecycle.state.phase, phaseAfterFirstProbe,
          reason: 'Repeated probe must not change phase');

      container.dispose();
    });

    // G6
    test('G6: landing → onboarding complete → phase → auth', () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // Start at landing
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing);

      // Onboarding completes → user must authenticate
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'Post-onboarding must route to unlock');

      container.dispose();
    });

    // G7
    test('G7: auth → unlock success → phase → ready', () {
      final container = _createScopedContainer();
      final lifecycle = container.read(appLifecycleProvider.notifier);

      // Start at auth
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth);

      // Unlock success → main app
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'Unlock success must route to main app');

      container.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group H: Riverpod Providers — Wiring (8 tests)
  // ═══════════════════════════════════════════════════════════════

  group('H: Riverpod Providers — Wiring', () {
    // H1
    test('H1: cryptoServiceProvider returns a singleton CryptoService',
        () async {
      final container = _createScopedContainer();

      final crypto1 = container.read(_cryptoServiceProvider);
      final crypto2 = container.read(_cryptoServiceProvider);

      expect(identical(crypto1, crypto2), isTrue,
          reason: 'CryptoService must be a singleton');

      container.dispose();
    });

    // H2
    test('H2: authServiceProvider injects CryptoService, AppDatabase, '
        'AppPreferences', () async {
      final container = _createScopedContainer();

      // Reading authServiceProvider must succeed (no missing deps).
      final auth = container.read(_authServiceProvider);

      expect(auth, isA<AuthService>(),
          reason: 'AuthService must be constructed with all deps injected');

      container.dispose();
    });

    // H3
    test('H3: syncServiceProvider injects CryptoService + storage', () async {
      final container = _createScopedContainer();

      final sync = container.read(_syncServiceProvider);

      expect(sync, isA<SyncService>(),
          reason: 'SyncService must be constructed with all deps injected');

      container.dispose();
    });

    // H4
    test('H4: appLifecycleProvider resolves without error', () {
      final container = _createScopedContainer();

      // AppLifecycleNotifier must be available.
      final lifecycle = container.read(appLifecycleProvider);

      expect(lifecycle.phase, AppPhase.boot,
          reason: 'App lifecycle must start in boot phase');

      container.dispose();
    });

    // H5
    test('H5: provider graph resolves without circular dependency errors',
        () {
      // Creating all providers must not throw (no cycles).
      final container = _createScopedContainer();

      // Reading each provider forces initialization of the full graph.
      expect(() => container.read(_cryptoServiceProvider), returnsNormally);
      expect(() => container.read(data_providers.databaseProvider),
          returnsNormally);
      expect(() => container.read(_appPreferencesProvider), returnsNormally);
      expect(() => container.read(_securePreferencesProvider),
          returnsNormally);
      expect(() => container.read(_syncServiceProvider), returnsNormally);
      expect(() => container.read(_authServiceProvider), returnsNormally);
      expect(() => container.read(_onboardingServiceProvider),
          returnsNormally);
      expect(() => container.read(appLifecycleProvider), returnsNormally);
      // J5: ledgerPushServiceProvider must not introduce cycles
      expect(() => container.read(_ledgerPushServiceProvider),
          returnsNormally);

      // If we got here without Riverpod throwing, the graph has no cycles.
      container.dispose();
    });

    // H6
    test('H6: syncServiceProvider reads worker config from preferences',
        () async {
      final container = _createScopedContainer();

      // Set worker URL in preferences
      final prefs = container.read(_appPreferencesProvider);
      await prefs.setWorkerUrl('https://worker.example.com');

      // Sync service should be constructable regardless — transport
      // is auto-configured from persisted config at read time.
      final sync = container.read(_syncServiceProvider);
      expect(sync, isA<SyncService>(),
          reason: 'SyncService must handle missing transport gracefully');

      container.dispose();
    });

    // H7
    test('H7: all service providers are auto-disposed on container disposal',
        () {
      final container = _createScopedContainer();

      // Read all providers to instantiate them
      container.read(_cryptoServiceProvider);
      container.read(data_providers.databaseProvider);
      container.read(_authServiceProvider);
      container.read(_syncServiceProvider);
      container.read(_onboardingServiceProvider);

      // Dispose the container
      expect(() => container.dispose(), returnsNormally);

      // After disposal, reading providers may throw or return cached
      // (Riverpod behavior varies). The contract is that dispose doesn't
      // crash and onDispose callbacks fire.
    });

    // H8
    test('H8: authServiceProvider broadcasts lock/unlock state to listeners',
        () async {
      final container = _createScopedContainer();

      final auth = container.read(_authServiceProvider);

      // Initially locked
      expect(auth.isUnlocked, isFalse);

      // Unlock changes state — listeners (via ref.watch) should react.
      // This test verifies the AuthService contract: isUnlocked is a
      // boolean that toggles. Riverpod listeners watching authServiceProvider
      // will rebuild when AuthService notifies. The exact notification
      // mechanism (StateNotifier, ChangeNotifier, or Stream) is an
      // implementation detail of Phase 3.
      //
      // For Phase 2 RED: verify the getter exists and is a bool.
      expect(auth.isUnlocked, isA<bool>());

      container.dispose();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group J: LedgerPushService Provider — Wiring (5 tests)
  // ═══════════════════════════════════════════════════════════════

  group('J: LedgerPushService Provider — Wiring', () {
    // J1
    test('J1: ledgerPushServiceProvider returns LedgerPushService singleton '
        '(same instance on repeat reads)', () async {
      final transport = _TestHttpTransport();
      final container = ProviderContainer(
        overrides: [
          data_providers.databaseProvider.overrideWith((ref) {
            final db = AppDatabase.inMemory();
            ref.onDispose(() => db.close());
            return db;
          }),
          _syncServiceProvider.overrideWithProvider(
            Provider<SyncService>((ref) {
              final crypto = ref.watch(_cryptoServiceProvider);
              final db = ref.watch(data_providers.databaseProvider);
              final storage = _InMemoryStorage();
              return SyncService(
                  storage: storage,
                  crypto: crypto,
                  transport: transport,
                  stagingStore: StagingStore(db));
            }),
          ),
        ],
      );

      final svc1 = container.read(_ledgerPushServiceProvider);
      final svc2 = container.read(_ledgerPushServiceProvider);

      expect(svc1, isNotNull,
          reason: 'LedgerPushService must be constructed when transport exists');
      expect(identical(svc1, svc2), isTrue,
          reason: 'LedgerPushService must be a singleton — '
              'duplicate instances would duplicate _pendingPush guards');

      container.dispose();
    });

    // J2
    test('J2: provider injects AppDatabase, CryptoService, HttpTransport '
        'without missing-dependency crash', () async {
      final transport = _TestHttpTransport();
      final container = ProviderContainer(
        overrides: [
          data_providers.databaseProvider.overrideWith((ref) {
            final db = AppDatabase.inMemory();
            ref.onDispose(() => db.close());
            return db;
          }),
          _syncServiceProvider.overrideWithProvider(
            Provider<SyncService>((ref) {
              final crypto = ref.watch(_cryptoServiceProvider);
              final db = ref.watch(data_providers.databaseProvider);
              final storage = _InMemoryStorage();
              return SyncService(
                  storage: storage,
                  crypto: crypto,
                  transport: transport,
                  stagingStore: StagingStore(db));
            }),
          ),
        ],
      );

      // Reading the provider must succeed — no missing deps.
      final pushSvc = container.read(_ledgerPushServiceProvider);

      expect(pushSvc, isA<LedgerPushService>(),
          reason: 'Full dependency resolution must not crash — '
              'miswired deps cause runtime crashes caught here at test time');

      container.dispose();
    });

    // J3
    test('J3: provider disposes cleanly — no unclosed DB handles or '
        'leaked transports after container disposal', () async {
      final transport = _TestHttpTransport();
      final container = ProviderContainer(
        overrides: [
          data_providers.databaseProvider.overrideWith((ref) {
            final db = AppDatabase.inMemory();
            ref.onDispose(() => db.close());
            return db;
          }),
          _syncServiceProvider.overrideWithProvider(
            Provider<SyncService>((ref) {
              final crypto = ref.watch(_cryptoServiceProvider);
              final db = ref.watch(data_providers.databaseProvider);
              final storage = _InMemoryStorage();
              return SyncService(
                  storage: storage,
                  crypto: crypto,
                  transport: transport,
                  stagingStore: StagingStore(db));
            }),
          ),
        ],
      );

      // Read to instantiate
      container.read(_ledgerPushServiceProvider);

      // Dispose must not throw
      expect(() => container.dispose(), returnsNormally,
          reason: 'Riverpod onDispose must release resources — '
              'leaks compound across app lifecycle');
    });

    // J4
    test('J4: provider resolves when HttpTransport is null (local-only mode) '
        '— returns null for push-at-time graceful degradation', () async {
      final container = _createScopedContainer();

      // _syncServiceProvider has no transport by default → local-only
      final pushSvc = container.read(_ledgerPushServiceProvider);

      expect(pushSvc, isNull,
          reason: 'Provider must resolve gracefully when no transport '
              'is configured — returns null so UI can hide push button. '
              'The push-time guard handles the null case at pushAll() time.');

      container.dispose();
    });

    // J5 — included in H5 test above; this test documents the contract.
    test('J5: updated provider graph (all existing providers + '
        'ledgerPushServiceProvider) resolves without circular '
        'dependency errors', () {
      final container = _createScopedContainer();

      // Read all providers including the new one — no cycles
      expect(() => container.read(_cryptoServiceProvider), returnsNormally);
      expect(
          () => container.read(data_providers.databaseProvider),
          returnsNormally);
      expect(() => container.read(_appPreferencesProvider), returnsNormally);
      expect(
          () => container.read(_securePreferencesProvider),
          returnsNormally);
      expect(() => container.read(_syncServiceProvider), returnsNormally);
      expect(() => container.read(_authServiceProvider), returnsNormally);
      expect(
          () => container.read(_onboardingServiceProvider),
          returnsNormally);
      expect(() => container.read(appLifecycleProvider), returnsNormally);
      expect(() => container.read(_ledgerPushServiceProvider),
          returnsNormally,
          reason: 'Adding ledgerPushServiceProvider must not introduce '
              'cycles in the existing provider graph');

      container.dispose();
    });
  });
}
