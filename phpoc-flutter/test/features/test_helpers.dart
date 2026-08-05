import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

// ═══════════════════════════════════════════════════════════════
// Shared test infrastructure for screen widget tests.
// ═══════════════════════════════════════════════════════════════

/// In-memory storage backing SyncService for tests.
class _InMemoryStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Default provider overrides for screen widget tests.
///
/// All services use in-memory backends (no disk I/O).
List<Override> defaultScreenOverrides() {
  return [
    // Data layer
    data_providers.databaseProvider.overrideWith((ref) {
      final db = AppDatabase.inMemory();
      ref.onDispose(() => db.close());
      return db;
    }),
    data_providers.appPreferencesProvider.overrideWith((ref) {
      final prefs = AppPreferences.testInstance();
      ref.onDispose(() => prefs.clearAll());
      return prefs;
    }),
    data_providers.securePreferencesProvider.overrideWith((ref) {
      return SecurePreferences.testInstance();
    }),
    data_providers.cryptoServiceProvider.overrideWith((ref) {
      final crypto = CryptoService();
      // Fire initialize() — in tests this is synchronous (just sets a flag).
      // The microtask completes before any widget interaction via pump().
      crypto.initialize();
      ref.onDispose(() => crypto.clearMasterKey());
      return crypto;
    }),
    data_providers.syncServiceProvider.overrideWith((ref) {
      final crypto = ref.watch(data_providers.cryptoServiceProvider);
      final storage = _InMemoryStorage();
      return SyncService(storage: storage, crypto: crypto);
    }),
    data_providers.authServiceProvider.overrideWith((ref) {
      final crypto = ref.watch(data_providers.cryptoServiceProvider);
      final db = ref.watch(data_providers.databaseProvider);
      final prefs = ref.watch(data_providers.appPreferencesProvider);
      final securePrefs = ref.watch(data_providers.securePreferencesProvider);
      return AuthService(
        crypto: crypto,
        db: db,
        preferences: prefs,
        securePreferences: securePrefs,
      );
    }),
    data_providers.onboardingServiceProvider.overrideWith((ref) {
      final crypto = ref.watch(data_providers.cryptoServiceProvider);
      final db = ref.watch(data_providers.databaseProvider);
      final prefs = ref.watch(data_providers.appPreferencesProvider);
      final securePrefs =
          ref.watch(data_providers.securePreferencesProvider);
      final sync = ref.watch(data_providers.syncServiceProvider);
      return OnboardingService(
        crypto: crypto,
        db: db,
        preferences: prefs,
        securePreferences: securePrefs,
        syncService: sync,
      );
    }),
  ];
}

/// Pump a screen widget inside a [ProviderScope] with default test overrides.
///
/// Use [initialPhase] to set the app lifecycle phase before rendering.
/// Additional [overrides] are merged with the defaults.
Future<void> pumpScreenWidget(
  WidgetTester tester,
  Widget screen, {
  AppPhase initialPhase = AppPhase.ready,
  List<Override> overrides = const [],
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        // Override lifecycle to the desired initial phase
        appLifecycleProvider.overrideWith((ref) {
          final notifier = AppLifecycleNotifier();
          // Set the initial phase by calling the appropriate method
          switch (initialPhase) {
            case AppPhase.boot:
              break; // default is boot
            case AppPhase.landing:
              notifier.goToLanding();
            case AppPhase.onboarding:
              notifier.goToOnboarding();
            case AppPhase.auth:
              notifier.goToAuth();
            case AppPhase.ready:
              notifier.goToReady();
          }
          return notifier;
        }),
        // Merge default service overrides
        ...defaultScreenOverrides(),
        ...overrides,
      ],
      child: MaterialApp(home: screen),
    ),
  );
  await tester.pump();
}

/// Convenience: pump a screen wrapped in [AppScaffold] (for main-shell screens).
Future<void> pumpShellScreen(
  WidgetTester tester,
  Widget screen, {
  AppPhase initialPhase = AppPhase.ready,
  List<Override> overrides = const [],
}) async {
  await pumpScreenWidget(
    tester,
    screen,
    initialPhase: initialPhase,
    overrides: overrides,
  );
}


