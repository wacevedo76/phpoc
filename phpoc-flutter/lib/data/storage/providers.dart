import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/crypto/crypto_service.dart';
import '../../data/ledger/engine.dart';
import '../../data/ledger/store_adapters.dart';
import '../../data/sync/staging_storage.dart';
import '../../data/sync/staging_store.dart';
import '../../data/sync/sync_service.dart';
import '../../features/sync/periodic_sync_coordinator.dart';
import '../../routing/app_router.dart';
import '../../services/auth_service.dart';
import '../../services/ledger_backup_service.dart';
import '../../services/rekey_service.dart';
import '../../services/ledger_migration_service.dart';
import '../../services/ledger_pull_service.dart';
import '../../services/pull_stage_functions.dart' show isolateOffloadRunner;
import '../../services/ledger_push_service.dart';
import '../../services/onboarding_service.dart';
import 'database.dart';
import 'preferences.dart';
import 'secure_preferences.dart';

/// Singleton [AppDatabase] instance.
///
/// Uses a file-based database when [AppDatabase.preResolvedPath] is set
/// (production), otherwise falls back to in-memory (tests).
///
/// Disposed on provider disposal (not typical in app lifecycle — the DB
/// lives for the process duration, but this enables clean test teardown).
final databaseProvider = Provider<AppDatabase>((ref) {
  final db = AppDatabase.preResolvedPath != null
      ? AppDatabase.openSync(AppDatabase.preResolvedPath!)
      : AppDatabase.inMemory();
  ref.onDispose(() => db.close());
  return db;
});

/// Convenience provider for [EntryDao].
final entryDaoProvider = Provider<EntryDao>((ref) {
  return ref.watch(databaseProvider).entryDao;
});

/// Convenience provider for [BlockDao].
final blockDaoProvider = Provider<BlockDao>((ref) {
  return ref.watch(databaseProvider).blockDao;
});

// ═══════════════════════════════════════════════════════════════
// Service-layer providers
// ═══════════════════════════════════════════════════════════════

/// Singleton [CryptoService] — one crypto instance per app.
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  final crypto = CryptoService();
  ref.onDispose(() => crypto.clearMasterKey());
  return crypto;
});

/// Application preferences provider.
///
/// Uses a production [SharedPreferences] instance when
/// [AppPreferences.preResolvedInstance] is set, otherwise falls back
/// to the test instance.
final appPreferencesProvider = Provider<AppPreferences>((ref) {
  final prefs = AppPreferences.preResolvedInstance ?? AppPreferences.testInstance();
  ref.onDispose(() => prefs.clearAll());
  return prefs;
});

/// Secure preferences provider.
///
/// Uses platform secure storage in production, in-memory in tests.
final securePreferencesProvider = Provider<SecurePreferences>((ref) {
  return SecurePreferences();
});

/// Sync service provider — uses SQLite-backed staging storage
/// and LedgerEngine for commit operations.
final syncServiceProvider = Provider<SyncService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final storage = StagingStorage(db);
  final stagingStore = StagingStore(db);
  final engine = ref.watch(ledgerEngineProvider);
  return SyncService(
    storage: storage,
    crypto: crypto,
    stagingStore: stagingStore,
    ledgerEngine: engine,
  );
});

/// Periodic staging drift coordinator — wires the app lifecycle to the
/// SyncService periodic timer so polling runs exactly while the app is in the
/// `ready` phase. Watched (kept alive) by the app root; on entering `ready` it
/// calls [SyncService.startPeriodicSync], on leaving `ready` it stops it, and
/// on provider disposal it detaches from the lifecycle and stops the timer.
/// Never started until this provider is first read.
final periodicSyncCoordinatorProvider =
    Provider<PeriodicSyncCoordinator>((ref) {
  final sync = ref.watch(syncServiceProvider);
  // Observe the phase ValueNotifier kept in sync by AppLifecycleNotifier on
  // every transition, so the coordinator latches onto the live app phase.
  final coordinator =
      PeriodicSyncCoordinator(sync: sync, phase: appPhaseNotifier);
  ref.onDispose(coordinator.dispose);
  return coordinator;
});

/// Auth service provider — injects crypto, db, preferences, securePrefs.
final authServiceProvider = Provider<AuthService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final prefs = ref.watch(appPreferencesProvider);
  final securePrefs = ref.watch(securePreferencesProvider);
  return AuthService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: securePrefs,
  );
});

/// Onboarding service provider — injects all deps.
final onboardingServiceProvider = Provider<OnboardingService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final prefs = ref.watch(appPreferencesProvider);
  final securePrefs = ref.watch(securePreferencesProvider);
  final sync = ref.watch(syncServiceProvider);
  final ledgerPull = ref.watch(ledgerPullServiceProvider);
  return OnboardingService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: securePrefs,
    syncService: sync,
    ledgerPullService: ledgerPull,
  );
});

/// Ledger engine provider — wraps BlockDao + in-memory index store.
/// Identity secret is optional; blocks are built without identity seals
/// when null (restored from onboarding flow later).
final ledgerEngineProvider = Provider<LedgerEngine>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final store = LedgerBlockStore(db.blockDao);
  final indexStore = LedgerIndexStore();
  final stagingStorage = StagingStorage(db);
  // TODO: derive identitySecret from genesis block once onboarding is complete
  return LedgerEngine(
    crypto: crypto,
    store: store,
    indexStore: indexStore,
    stagingStore: stagingStorage,
  );
});

/// Ledger backup service provider — injects database.
final ledgerBackupServiceProvider = Provider<LedgerBackupService>((ref) {
  final db = ref.watch(databaseProvider);
  return LedgerBackupService(db: db);
});

/// Re-key (C-2 seed replacement) service provider — injects all deps.
final rekeyServiceProvider = Provider<RekeyService>((ref) {
  final auth = ref.watch(authServiceProvider);
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final prefs = ref.watch(appPreferencesProvider);
  final securePrefs = ref.watch(securePreferencesProvider);
  return RekeyService(
    auth: auth,
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: securePrefs,
    backupService: ref.watch(ledgerBackupServiceProvider),
    pushService: ref.watch(ledgerPushServiceProvider),
  );
});

/// Ledger migration service provider — injects crypto + database.
/// Used for one-time encryption standardization (dev only, removed before
/// public launch per BACKLOG.md).
final ledgerMigrationServiceProvider = Provider<LedgerMigrationService>((ref) {
  final db = ref.watch(databaseProvider);
  final crypto = ref.watch(cryptoServiceProvider);
  return LedgerMigrationService(db: db, crypto: crypto);
});

/// Ledger pull service provider — injects crypto, db, backup.
/// Transport is wired lazily by OnboardingService.connectWorker().
final ledgerPullServiceProvider = Provider<LedgerPullService>((ref) {
  final db = ref.watch(databaseProvider);
  final crypto = ref.watch(cryptoServiceProvider);

  return LedgerPullService(
    db: db,
    crypto: crypto,
    transport: null, // Wired later by connectWorker
    backupService: ref.watch(ledgerBackupServiceProvider),
    stagingStorage: StagingStorage(db),
    stagingStore: StagingStore(db),
    // Offload CPU-bound deobfuscation + chain validation to a background
    // isolate so a large cloud restore never wedges the UI thread (the ANR
    // fix). Tests inject an inline runner; production uses Isolate.run.
    offload: isolateOffloadRunner,
  );
});

/// Ledger push service provider — null when no transport configured.
/// Pushes the full ledger chain to the remote Worker/R2 blob store.
/// Watched by [SyncScreen] for the "Push Ledger to Cloud" button.
final ledgerPushServiceProvider = Provider<LedgerPushService?>((ref) {
  final sync = ref.watch(syncServiceProvider);
  if (!sync.isRemoteAvailable) return null;
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  return LedgerPushService(
      db: db, crypto: crypto, transport: sync.transport!);
});
