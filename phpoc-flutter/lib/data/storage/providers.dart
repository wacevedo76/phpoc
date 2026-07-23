import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/crypto/crypto_service.dart';
import '../../data/sync/staging_storage.dart';
import '../../data/sync/sync_service.dart';
import '../../services/auth_service.dart';
import '../../services/ledger_backup_service.dart';
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

/// Sync service provider — uses SQLite-backed staging storage.
final syncServiceProvider = Provider<SyncService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final storage = StagingStorage(db);
  return SyncService(storage: storage, crypto: crypto);
});

/// Auth service provider — injects crypto, db, preferences.
final authServiceProvider = Provider<AuthService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final prefs = ref.watch(appPreferencesProvider);
  return AuthService(crypto: crypto, db: db, preferences: prefs);
});

/// Onboarding service provider — injects all deps.
final onboardingServiceProvider = Provider<OnboardingService>((ref) {
  final crypto = ref.watch(cryptoServiceProvider);
  final db = ref.watch(databaseProvider);
  final prefs = ref.watch(appPreferencesProvider);
  final securePrefs = ref.watch(securePreferencesProvider);
  final sync = ref.watch(syncServiceProvider);
  return OnboardingService(
    crypto: crypto,
    db: db,
    preferences: prefs,
    securePreferences: securePrefs,
    syncService: sync,
  );
});

/// Ledger backup service provider — injects database.
final ledgerBackupServiceProvider = Provider<LedgerBackupService>((ref) {
  final db = ref.watch(databaseProvider);
  return LedgerBackupService(db: db);
});
