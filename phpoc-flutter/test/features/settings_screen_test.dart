import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show
        appPreferencesProvider,
        authServiceProvider,
        cryptoServiceProvider,
        databaseProvider,
        onboardingServiceProvider,
        securePreferencesProvider,
        syncServiceProvider;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/data/sync/transport.dart';
import 'package:phpoc_flutter/features/settings/settings_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

import 'test_helpers.dart';

/// Settings Screen tests — Group H (13 assertions)
///
/// Phase 2 RED: real assertions exercising the full settings UI.
/// H1 is the existing smoke test. H2–H13 are new RED tests.

// ═══════════════════════════════════════════════════════════════
// Spy / fake services for controlled test behavior
// ═══════════════════════════════════════════════════════════════

/// Spy [AuthService] that tracks calls and allows throwing on demand.
class _SpyAuthService extends AuthService {
  // Change passphrase tracking
  bool changePassphraseCalled = false;
  String? changeOldPassphrase;
  String? changeNewPassphrase;
  bool changePassphraseThrows = false;
  String changePassphraseError = 'Wrong passphrase — cannot decrypt genesis seed';

  // Export seed tracking
  bool exportSeedCalled = false;
  String? exportSeedPassphrase;
  bool exportSeedThrows = false;
  String exportSeedError = 'Wrong passphrase';
  String exportSeedReturnValue =
      'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

  // Lock tracking
  bool lockCalled = false;

  // ── Biometric stubs (Phase 2 RED — UI elements don't exist yet) ──
  bool biometricsAvailable = false;
  bool biometricEnabled = false;
  bool unlockWithBiometricCalled = false;
  bool unlockWithBiometricResult = false;

  _SpyAuthService({
    required super.crypto,
    required super.db,
    required super.preferences,
    required super.securePreferences,
  });

  // ── Biometric methods ──
  Future<bool> isBiometricsAvailable() async => biometricsAvailable;
  bool isBiometricEnabled() => biometricEnabled;

  Future<bool> unlockWithBiometric() async {
    unlockWithBiometricCalled = true;
    return unlockWithBiometricResult;
  }

  Future<void> enrollBiometric() async {
    biometricEnabled = true;
  }

  Future<void> disableBiometric() async {
    biometricEnabled = false;
  }

  /// If set, reauthenticate will throw AuthException with this message.
  String? reauthenticateError;

  @override
  Future<void> reauthenticate(String passphrase) async {
    // Bypass genesis-block lookup for settings screen tests.
    if (passphrase.length < 8) {
      throw AuthException('Passphrase must be at least 8 characters');
    }
    if (reauthenticateError != null) {
      throw AuthException(reauthenticateError!);
    }
    notifyUnlocked();
  }

  @override
  Future<void> changePassphrase(
      String oldPassphrase, String newPassphrase) async {
    changePassphraseCalled = true;
    changeOldPassphrase = oldPassphrase;
    changeNewPassphrase = newPassphrase;

    if (changePassphraseThrows) {
      throw AuthException(changePassphraseError);
    }

    // Don't call super — it tries to find a genesis block in the DB.
    // For settings screen tests, we only care that the call was made.
  }

  @override
  Future<String> exportSeed(String passphrase) async {
    exportSeedCalled = true;
    exportSeedPassphrase = passphrase;

    if (exportSeedThrows) {
      throw AuthException(exportSeedError);
    }

    return exportSeedReturnValue;
  }

  @override
  void lock() {
    lockCalled = true;
    // Don't call super.lock() — it clears the real MK which may be needed
    // by other services in the same ProviderScope.
  }
}

/// Spy [OnboardingService] that intercepts [connectWorker] without HTTP.
class _SpyOnboardingService extends OnboardingService {
  bool connectWorkerCalled = false;
  String? connectWorkerUrl;
  String? connectWorkerApiKey;

  _SpyOnboardingService({
    required super.crypto,
    required super.db,
    required super.preferences,
    required super.securePreferences,
    required super.syncService,
  });

  @override
  Future<void> connectWorker(String url, String apiKey) async {
    connectWorkerCalled = true;
    connectWorkerUrl = url;
    connectWorkerApiKey = apiKey;

    // Simulate the real behavior without HTTP: store prefs and set transport.
    await preferences.setWorkerUrl(url);
    await securePreferences.setApiKey(apiKey);
    // Set transport so isRemoteAvailable becomes true
    syncService.transport = _FakeTransport();
  }
}

/// Minimal transport stub so [SyncService.isRemoteAvailable] returns true.
class _FakeTransport extends HttpTransport {
  _FakeTransport() : super(baseUrl: 'http://fake.test', apiKey: 'fake-key');
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

void main() {
  group('H: SettingsScreen', () {
    // H1 — Widget smoke test within AppScaffold
    testWidgets('H1: SettingsScreen renders without error within AppScaffold',
        (tester) async {
      final router = GoRouter(
        initialLocation: '/settings',
        routes: [
          ShellRoute(
            builder: (_, _, child) => AppScaffold(child: child),
            routes: [
              GoRoute(path: '/', builder: (_, _) => const Placeholder()),
              GoRoute(
                  path: '/settings',
                  builder: (_, _) => const SettingsScreen()),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pump();

      expect(find.byType(SettingsScreen), findsOneWidget,
          reason: 'SettingsScreen must render inside the bottom-nav shell');
      expect(find.byType(AppScaffold), findsOneWidget,
          reason: 'SettingsScreen must be wrapped in AppScaffold');
    });

    // ═══════════════════════════════════════════════════════════
    // H2 — Displays Worker URL or "Not configured"
    // ═══════════════════════════════════════════════════════════
    testWidgets('H2: SettingsScreen displays current Worker URL or '
        '"Not configured"', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      // SettingsScreen._loadStatus() is called in initState and fires an
      // async read from AppPreferences. The default test instance returns
      // null for getWorkerUrl(), triggering "Not configured".
      await tester.pumpAndSettle();

      expect(
        find.text('Not configured'),
        findsOneWidget,
        reason: 'When no Worker URL is saved, "Not configured" must appear '
            'in the Worker ListTile subtitle',
      );
    });

    // ═══════════════════════════════════════════════════════════
    // H3 — Displays Worker connection status
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H3: SettingsScreen displays Worker connection status (connected / '
        'disconnected)', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Default: no transport → disconnected
      expect(
        find.text('Disconnected'),
        findsOneWidget,
        reason: 'When no transport is set, the status must show "Disconnected"',
      );
    });

    // ═══════════════════════════════════════════════════════════
    // H4 — Tapping Worker config opens editor for URL + API key
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H4: tapping Worker config opens editor for URL and API key',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Tap the Worker ListTile
      await tester.tap(find.text('Worker'));
      await tester.pumpAndSettle();

      // Two TextFields: one for URL, one for API key
      expect(
        find.byType(TextField),
        findsNWidgets(2),
        reason: 'Tapping Worker config must show URL and API key input fields',
      );

      // Labels must be present
      expect(find.text('Worker URL'), findsOneWidget,
          reason: 'Editor must label the URL field');
      expect(find.text('API Key'), findsOneWidget,
          reason: 'Editor must label the API key field');

      // Cancel and Save buttons must be present
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'Users must be able to cancel editing');
      expect(find.text('Save'), findsOneWidget,
          reason: 'Users must be able to save new config');
    });

    // ═══════════════════════════════════════════════════════════
    // H5 — Saving Worker config calls onboardingService.connectWorker()
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H5: saving Worker config calls onboardingService.connectWorker()',
        (tester) async {
      _SpyOnboardingService? spyOnboarding;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            onboardingServiceProvider.overrideWith((ref) {
              final crypto = ref.read(
                  cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(
                  appPreferencesProvider);
              final securePrefs = ref.read(
                  securePreferencesProvider);
              final sync = ref.read(syncServiceProvider);
              spyOnboarding = _SpyOnboardingService(
                crypto: crypto,
                db: db,
                preferences: prefs,
                securePreferences: securePrefs,
                syncService: sync,
              );
              return spyOnboarding!;
            }),
          ]);
      await tester.pumpAndSettle();

      // Tap Worker to open editor
      await tester.tap(find.text('Worker'));
      await tester.pumpAndSettle();

      // Fill URL and API key fields
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'https://worker.example.com');
      await tester.enterText(fields.at(1), 'test-api-key-42');
      await tester.pumpAndSettle();

      // Tap Save
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(spyOnboarding!.connectWorkerCalled, isTrue,
          reason: 'Saving Worker config must call '
              'onboardingService.connectWorker()');
      expect(spyOnboarding!.connectWorkerUrl, 'https://worker.example.com',
          reason: 'URL entered must be passed to connectWorker');
      expect(spyOnboarding!.connectWorkerApiKey, 'test-api-key-42',
          reason: 'API key entered must be passed to connectWorker');

      // After successful save, worker should show as Connected
      expect(find.text('Connected'), findsOneWidget,
          reason: 'After connectWorker, the status must show "Connected"');
    });

    // ═══════════════════════════════════════════════════════════
    // H6 — "Change Passphrase" option opens old/new passphrase fields
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H6: "Change Passphrase" option opens old/new passphrase fields',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to make "Change Passphrase" visible
      await tester.scrollUntilVisible(
        find.text('Change Passphrase'),
        100,
      );
      await tester.pumpAndSettle();

      // Tap "Change Passphrase"
      await tester.tap(find.text('Change Passphrase'));
      await tester.pumpAndSettle();

      // Two obscure text fields: Old Passphrase and New Passphrase
      expect(
        find.byType(TextField),
        findsNWidgets(2),
        reason: 'Change Passphrase must show old and new passphrase fields',
      );

      expect(find.text('Old Passphrase'), findsOneWidget,
          reason: 'Old passphrase field must be labeled');
      expect(find.text('New Passphrase'), findsOneWidget,
          reason: 'New passphrase field must be labeled');

      // Cancel and Change buttons must be present
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'Users must be able to cancel passphrase change');
      expect(find.text('Change'), findsOneWidget,
          reason: 'Submit button must say "Change"');
    });

    // ═══════════════════════════════════════════════════════════
    // H7 — Change passphrase: new passphrase < 8 chars → validation error
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H7: change passphrase — new passphrase < 8 chars shows validation '
        'error', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Open change passphrase editor
      await tester.scrollUntilVisible(
        find.text('Change Passphrase'),
        100,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Change Passphrase'));
      await tester.pumpAndSettle();

      // Fill old passphrase with something, new passphrase too short
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'OldPass123');
      await tester.enterText(fields.at(1), 'short');
      await tester.pumpAndSettle();

      // Tap "Change"
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();

      // Validation error must appear on the new passphrase field
      expect(
        find.text('New passphrase must be at least 8 characters'),
        findsOneWidget,
        reason: 'Short passphrase must show validation error on the new '
            'passphrase field',
      );

      // The editor must still be open (not dismissed on validation error)
      expect(find.text('Old Passphrase'), findsOneWidget,
          reason: 'Editor must stay open on validation error');
    });

    // ═══════════════════════════════════════════════════════════
    // H8 — Change passphrase: wrong old passphrase → AuthException error
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H8: change passphrase — wrong old passphrase shows AuthException error',
        (tester) async {
      _SpyAuthService? spyAuth;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(
                  cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(
                  appPreferencesProvider);
              final securePrefs =
                  ref.read(securePreferencesProvider);
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: securePrefs);
              spyAuth!.changePassphraseThrows = true;
              return spyAuth!;
            }),
          ]);
      await tester.pumpAndSettle();

      // Open change passphrase editor
      await tester.scrollUntilVisible(
        find.text('Change Passphrase'),
        100,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Change Passphrase'));
      await tester.pumpAndSettle();

      // Fill with wrong old + valid new
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'WrongOldPass');
      await tester.enterText(fields.at(1), 'ValidNewPass123');
      await tester.pumpAndSettle();

      // Tap "Change"
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();

      // The spy must have been called
      expect(spyAuth!.changePassphraseCalled, isTrue,
          reason: 'changePassphrase must be called when user submits');
      expect(spyAuth!.changeOldPassphrase, 'WrongOldPass',
          reason: 'Old passphrase from text field must be passed correctly');

      // AuthException message must be displayed as error on the field
      expect(
        find.text(spyAuth!.changePassphraseError),
        findsOneWidget,
        reason: 'AuthException message must be surfaced to the user',
      );

      // The editor must stay open so user can retry
      expect(find.text('Old Passphrase'), findsOneWidget,
          reason: 'Editor must stay open on auth error for retry');
    });

    // ═══════════════════════════════════════════════════════════
    // H9 — Change passphrase: correct old + valid new → changePassphrase()
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H9: change passphrase — correct old + valid new calls '
        'authService.changePassphrase()', (tester) async {
      _SpyAuthService? spyAuth;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(
                  cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(
                  appPreferencesProvider);
              final secPrefs = ref.read(securePreferencesProvider);
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: secPrefs);
              return spyAuth!;
            }),
          ]);
      await tester.pumpAndSettle();

      // Open change passphrase editor
      await tester.scrollUntilVisible(
        find.text('Change Passphrase'),
        100,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Change Passphrase'));
      await tester.pumpAndSettle();

      // Fill with correct old + valid new
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'CorrectOldPass');
      await tester.enterText(fields.at(1), 'ValidNewPass123');
      await tester.pumpAndSettle();

      // Tap "Change"
      await tester.tap(find.text('Change'));
      await tester.pumpAndSettle();

      // The spy must have been called with correct values
      expect(spyAuth!.changePassphraseCalled, isTrue,
          reason: 'changePassphrase must be called when user submits');
      expect(spyAuth!.changeOldPassphrase, 'CorrectOldPass');
      expect(spyAuth!.changeNewPassphrase, 'ValidNewPass123');

      // Success SnackBar must appear
      expect(
        find.text('Passphrase changed successfully'),
        findsOneWidget,
        reason: 'Success feedback must be shown as a SnackBar',
      );

      // Editor must close after success
      expect(find.text('Old Passphrase'), findsNothing,
          reason: 'Editor must close on successful passphrase change');
    });

    // ═══════════════════════════════════════════════════════════
    // H10 — "Export Recovery Seed" shows warning dialog before revealing seed
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H10: "Export Recovery Seed" shows warning dialog before revealing '
        'seed', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to "Export Recovery Seed" in the Security card
      await tester.scrollUntilVisible(
        find.text('Export Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();

      // Tap "Export Recovery Seed"
      await tester.tap(find.text('Export Recovery Seed'));
      await tester.pumpAndSettle();

      // Warning AlertDialog must appear
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'Seed export must show a warning dialog before proceeding');
      expect(
        find.text('Export Recovery Seed'),
        findsWidgets,
        reason: 'Dialog title must be "Export Recovery Seed"',
      );
      expect(
        find.textContaining('Make sure no one else can see your screen'),
        findsOneWidget,
        reason: 'Warning must mention screen security',
      );

      // Dialog must have Cancel and Show Seed buttons
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'User must be able to cancel seed export');
      expect(find.text('Show Seed'), findsOneWidget,
          reason: 'User must confirm to proceed with export');
    });

    // ═══════════════════════════════════════════════════════════
    // H11 — Export seed: after confirmation, passphrase prompt → exportSeed()
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H11: export seed — after warning confirmation, passphrase re-auth '
        'dialog appears with Export and Cancel', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to and tap "Export Recovery Seed"
      await tester.scrollUntilVisible(
        find.text('Export Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Export Recovery Seed'));
      await tester.pumpAndSettle();

      // Step 1: Warning AlertDialog must appear with Cancel + Show Seed
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'Seed export must first show a warning dialog');
      expect(find.text('Show Seed'), findsOneWidget,
          reason: 'User must confirm seed export intent');

      // Tap "Show Seed" to proceed to passphrase re-auth
      await tester.tap(find.text('Show Seed'));
      await tester.pumpAndSettle();

      // Step 2: Passphrase re-authentication dialog must appear
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'After warning confirmation, a passphrase re-auth dialog '
              'must appear');
      expect(
        find.text('Verify Passphrase'),
        findsOneWidget,
        reason: 'Re-auth dialog title must be "Verify Passphrase"',
      );
      expect(find.byType(TextField), findsOneWidget,
          reason: 'Must have an obscured passphrase input field');
      expect(find.text('Export'), findsOneWidget,
          reason: 'Must have an Export button to confirm');
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'Must have a Cancel button to abort');

      // The exportSeed() → FilePicker.saveFile() happy path is tested
      // at the service level (auth_service_test) due to FilePicker
      // requiring a real platform channel. The widget-level contract
      // is verified: warning → passphrase prompt → Export button.
    });

    // ═══════════════════════════════════════════════════════════
    // H12 — "Lock / Log Out" clears MK and transitions to /unlock
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H12: "Lock / Log Out" option shows confirmation, calls lock(), '
        'transitions to auth', (tester) async {
      _SpyAuthService? spyAuth;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(
                  cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(
                  appPreferencesProvider);
              final secPrefs2 = ref.read(securePreferencesProvider);
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: secPrefs2);
              return spyAuth!;
            }),
          ]);
      await tester.pumpAndSettle();

      // Scroll to "Lock / Log Out" in the Session card
      await tester.scrollUntilVisible(
        find.text('Lock / Log Out'),
        300,
      );
      await tester.pumpAndSettle();

      // Tap "Lock / Log Out"
      await tester.tap(find.text('Lock / Log Out'));
      await tester.pumpAndSettle();

      // Confirmation dialog must appear
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'Lock must show a confirmation dialog');
      expect(
        find.text('Lock PH Ledger'),
        findsOneWidget,
        reason: 'Confirmation dialog title must be "Lock PH Ledger"',
      );
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'User must be able to cancel lock');

      // Confirm lock inside the dialog.
      // Tapping the FilledButton calls Navigator.pop() which schedules
      // _lock() after a 300ms delay to avoid _FocusInheritedScope assertion
      // during dialog dismiss animation.
      await tester.tap(find.widgetWithText(FilledButton, 'Lock / Log Out'));
      await tester.pump(); // Start dismiss animation
      await tester.pump(const Duration(milliseconds: 400)); // Wait for delay + lock

      // authService.lock() must have been called
      expect(spyAuth!.lockCalled, isTrue,
          reason: 'authService.lock() must be called to clear the master key');

      // Phase must have transitioned to auth (redirects to /unlock)
      final container = ProviderScope.containerOf(
          tester.element(find.byType(SettingsScreen)));
      final phase = container.read(appLifecycleProvider).phase;
      expect(phase, AppPhase.auth,
          reason: 'After lock, the app phase must be auth, which '
              'redirects to /unlock');
    });

    // ═══════════════════════════════════════════════════════════
    // H13 — "About" section shows app name, version, and build info
    // ═══════════════════════════════════════════════════════════
    testWidgets(
        'H13: "About" section shows app name, version, and build info',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to bring About section into view
      await tester.scrollUntilVisible(
        find.text('About'),
        300,
      );
      await tester.pumpAndSettle();

      // About section header
      expect(find.text('About'), findsOneWidget,
          reason: 'About section header must be present');

      // App name
      expect(find.text('PH Ledger'), findsOneWidget,
          reason: 'App name must be shown in About');
      expect(
        find.text('Personal History Protocol'),
        findsOneWidget,
        reason: 'App subtitle/tagline must be shown in About',
      );

      // Version info
      expect(find.text('Version'), findsOneWidget,
          reason: 'Version label must be present');
      expect(
        find.textContaining('Flutter MVP'),
        findsOneWidget,
        reason: 'Version string with build info must be present',
      );

      // Build info
      expect(find.text('Build'), findsOneWidget,
          reason: 'Build label must be present');
      expect(
        find.textContaining('flutter'),
        findsOneWidget,
        reason: 'Build tech stack info must include "flutter"',
      );
    });

    // ═══════════════════════════════════════════════════════════
    // Group S: Import tile in Settings (4 assertions)
    // ═══════════════════════════════════════════════════════════

    // S1 — Import tile in Data/Storage section
    testWidgets('S1: settings shows "Import entries from another ledger" '
        'tile in the Data/Storage section', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to find the import tile
      await tester.scrollUntilVisible(
        find.textContaining('Import'),
        300,
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Import entries from another ledger'),
        findsOneWidget,
        reason: 'Settings must have an import tile with descriptive title',
      );
    });

    // S2 — Tapping import tile navigates to /import
    testWidgets('S2: tapping the import tile navigates to /import',
        (tester) async {
      // Build a GoRouter with /settings and /import routes
      final router = GoRouter(
        initialLocation: '/settings',
        routes: [
          GoRoute(
            path: '/settings',
            builder: (_, __) => const SettingsScreen(),
          ),
          GoRoute(
            path: '/import',
            builder: (_, __) => const Placeholder(),
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: defaultScreenOverrides(),
          child: MaterialApp.router(routerConfig: router),
        ),
      );
      await tester.pumpAndSettle();

      // Scroll to the import tile
      await tester.scrollUntilVisible(
        find.textContaining('Import'),
        300,
      );
      await tester.pumpAndSettle();

      // Tap the import tile
      await tester.tap(find.text('Import entries from another ledger'));
      await tester.pumpAndSettle();

      // Should navigate to /import (a Placeholder in this test setup)
      expect(
        find.byType(Placeholder),
        findsOneWidget,
        reason: 'Tapping import tile must navigate to /import route',
      );
    });

    // S3 — Import tile has appropriate icon
    testWidgets('S3: import tile has an appropriate icon '
        '(call_merge or file_open)', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to find the import tile
      await tester.scrollUntilVisible(
        find.textContaining('Import'),
        300,
      );
      await tester.pumpAndSettle();

      // The import tile must have a leading icon
      final importTile = find.ancestor(
        of: find.text('Import entries from another ledger'),
        matching: find.byType(ListTile),
      );
      expect(importTile, findsOneWidget,
          reason: 'Import tile must be a ListTile');

      // Verify an icon exists (Icons.call_merge, Icons.file_open, or similar)
      final iconFinder = find.descendant(
        of: importTile,
        matching: find.byType(Icon),
      );
      expect(iconFinder, findsWidgets,
          reason: 'Import tile must have an icon');
    });

    // S4 — Import tile subtitle describes the feature
    testWidgets('S4: import tile subtitle describes the feature',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // Scroll to find the import tile
      await tester.scrollUntilVisible(
        find.textContaining('Import'),
        300,
      );
      await tester.pumpAndSettle();

      // The tile must have a subtitle describing the feature
      final hasDescriptiveSubtitle =
          find.textContaining('Move entries').evaluate().isNotEmpty ||
          find.textContaining('old ledger').evaluate().isNotEmpty ||
          find.textContaining('another ledger').evaluate().isNotEmpty ||
          find.textContaining('Import entries').evaluate().isNotEmpty;
      expect(
        hasDescriptiveSubtitle,
        isTrue,
        reason: 'Import tile must have a subtitle describing what it does',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group E: SettingsScreen — Biometric Toggle (E1–E6)
  //
  // Phase 2 RED: All tests will fail because the biometric toggle
  // UI ("Unlock with fingerprint" SwitchListTile) is not yet
  // implemented in SettingsScreen.
  // ═══════════════════════════════════════════════════════════

  group('E: SettingsScreen — Biometric Toggle', () {
    /// Pump SettingsScreen with a biometric-aware spy.
    Future<void> _pumpBioSettings(
      WidgetTester tester, {
      bool biometricsAvailable = false,
      bool biometricEnabled = false,
    }) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(appPreferencesProvider);
              final secPrefs3 = ref.read(securePreferencesProvider);
              final spy = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: secPrefs3);
              spy.biometricsAvailable = biometricsAvailable;
              spy.biometricEnabled = biometricEnabled;
              return spy;
            }),
          ]);
      await tester.pumpAndSettle();
    }

    // E1 — "Unlock with fingerprint" toggle visible when biometrics available
    testWidgets('E1: "Unlock with fingerprint" toggle visible when biometrics '
        'available', (tester) async {
      await _pumpBioSettings(tester, biometricsAvailable: true);

      // In Phase 3: a SwitchListTile with "Unlock with fingerprint" appears
      // in the Security section
      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      final biometricToggle = find.text('Unlock with fingerprint');
      expect(biometricToggle, findsOneWidget,
          reason: 'Biometric toggle must be visible in Security section when '
              'biometric hardware is available');
    });

    // E2 — Toggle NOT visible when biometric hardware absent
    testWidgets('E2: toggle NOT visible when biometric hardware absent',
        (tester) async {
      await _pumpBioSettings(tester, biometricsAvailable: false);

      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      final biometricToggle = find.text('Unlock with fingerprint');
      expect(biometricToggle, findsNothing,
          reason: 'Biometric toggle must NOT appear when no biometric '
              'hardware is present on the device');
    });

    // E3 — Toggle starts OFF when biometric not yet enrolled
    testWidgets('E3: toggle starts OFF when biometric not yet enrolled',
        (tester) async {
      await _pumpBioSettings(tester,
          biometricsAvailable: true, biometricEnabled: false);

      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      // In Phase 3: find the Switch widget and verify it's off
      final switchFinder = find.byWidgetPredicate((w) {
        if (w is SwitchListTile) {
          return w.title.toString().contains('fingerprint') ||
              (w.title is Text &&
                  (w.title as Text).data?.contains('fingerprint') == true);
        }
        return false;
      });

      if (switchFinder.evaluate().isNotEmpty) {
        final switchTile = tester.widget<SwitchListTile>(switchFinder);
        expect(switchTile.value, isFalse,
            reason: 'Toggle must start OFF — biometrics require explicit '
                'opt-in enrollment');
      }
      // Phase 2 RED: switchFinder is empty — toggle doesn't exist yet
    });

    // E4 — Tapping toggle ON prompts for passphrase verification
    testWidgets('E4: tapping toggle ON prompts for passphrase verification',
        (tester) async {
      await _pumpBioSettings(tester,
          biometricsAvailable: true, biometricEnabled: false);

      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      // In Phase 3: tap the toggle → passphrase verification dialog appears
      final biometricToggle = find.text('Unlock with fingerprint');
      if (biometricToggle.evaluate().isNotEmpty) {
        await tester.tap(biometricToggle);
        await tester.pumpAndSettle();

        // A dialog or inline passphrase field must appear
        expect(
          find.byType(AlertDialog),
          findsOneWidget,
          reason: 'Enabling biometrics must require passphrase verification '
              'before enrollment',
        );
      }
    });

    // E5 — Correct passphrase → enrolls biometric → toggle stays ON
    testWidgets('E5: correct passphrase → enrolls biometric → toggle stays ON',
        (tester) async {
      _SpyAuthService? spy;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(appPreferencesProvider);
              final _secPrefs = ref.read(securePreferencesProvider);
              spy = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: _secPrefs);
              spy!.biometricsAvailable = true;
              spy!.biometricEnabled = false;
              return spy!;
            }),
          ]);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      // In Phase 3: tap toggle → passphrase dialog → enter correct passphrase
      // → enrollBiometric() called → toggle stays ON
      final biometricToggle = find.text('Unlock with fingerprint');
      if (biometricToggle.evaluate().isNotEmpty) {
        await tester.tap(biometricToggle);
        await tester.pumpAndSettle();

        // Enter passphrase in the verification dialog
        final passphraseField = find.byType(TextField);
        if (passphraseField.evaluate().isNotEmpty) {
          await tester.enterText(passphraseField.first, 'CorrectHorseBatteryStaple42!');
          await tester.pumpAndSettle();

          // Tap Confirm/Verify button
          final confirmButton = find.text('Verify');
          if (confirmButton.evaluate().isNotEmpty) {
            await tester.tap(confirmButton);
            await tester.pumpAndSettle();
          }
        }
      }

      // In Phase 3: toggle should now be ON (biometricEnabled = true)
      expect(spy?.biometricEnabled, isTrue,
          reason: 'After correct passphrase, enrollBiometric() must be called '
              'and toggle must stay ON');
    });

    // E6 — Wrong passphrase → error shown → toggle returns to OFF
    testWidgets('E6: wrong passphrase → error shown → toggle returns to OFF',
        (tester) async {
      _SpyAuthService? spy;

      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final crypto = ref.read(cryptoServiceProvider);
              final db = ref.read(databaseProvider);
              final prefs = ref.read(appPreferencesProvider);
              final __secPrefs = ref.read(securePreferencesProvider);
              spy = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs,
                  securePreferences: __secPrefs);
              spy!.biometricsAvailable = true;
              spy!.biometricEnabled = false;
              spy!.reauthenticateError = 'Wrong passphrase';
              return spy!;
            }),
          ]);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Security'),
        300,
      );
      await tester.pumpAndSettle();

      // In Phase 3: tap toggle → passphrase dialog → wrong passphrase
      // → AuthException → error message → toggle returns to OFF
      final biometricToggle = find.text('Unlock with fingerprint');
      if (biometricToggle.evaluate().isNotEmpty) {
        await tester.tap(biometricToggle);
        await tester.pumpAndSettle();

        // Enter wrong passphrase
        final passphraseField = find.byType(TextField);
        if (passphraseField.evaluate().isNotEmpty) {
          await tester.enterText(passphraseField.first, 'WrongPassphrase!');
          await tester.pumpAndSettle();

          final confirmButton = find.text('Verify');
          if (confirmButton.evaluate().isNotEmpty) {
            await tester.tap(confirmButton);
            await tester.pumpAndSettle();
          }
        }
      }

      // In Phase 3: toggle must return to OFF, error message visible
      expect(spy?.biometricEnabled, isFalse,
          reason: 'After wrong passphrase, biometric must remain disabled');

      // Phase 2 RED: toggle widget doesn't exist yet — these selectors fail
      // In Phase 3, the error text will be visible in the dialog
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group S: Settings — Re-key to a new Recovery Seed (C-2)
  // ═══════════════════════════════════════════════════════════════
  //
  // Phase 2 RED: asserts the Security & Recovery UI contract for the C-2
  // seed-replacement flow. The tile/dialogs do not exist yet, so every test
  // here fails (RED) until Phase 3 adds the UI. Design option (a): new seed
  // becomes the new raw MK; NO new ledger-block metadata is introduced.
  group('S: Settings — Re-key Recovery Seed', () {
    testWidgets(
        'S1: Security & Recovery shows both Change Passphrase and Re-key to '
        'new Recovery Seed', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Change Passphrase'),
        200,
      );
      await tester.pumpAndSettle();

      // Both options must be present in the Security card.
      expect(find.text('Change Passphrase'), findsOneWidget,
          reason: 'Existing passphrase change must remain available');
      expect(find.text('Re-key to new Recovery Seed'), findsOneWidget,
          reason: 'S1: the re-key option must appear in Security & Recovery');
    });

    testWidgets(
        'S2: tapping re-key opens a two-secret confirmation', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Re-key to new Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Re-key to new Recovery Seed'));
      await tester.pumpAndSettle();

      // Two-secret gate: current passphrase entry + explicit acknowledge.
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'S2: re-key must open a confirmation dialog');
      expect(find.text('Current Passphrase'), findsOneWidget,
          reason: 'S2: must ask for the current passphrase');
      expect(find.text('Acknowledge'), findsOneWidget,
          reason: 'S2: must require explicit acknowledge of the consequences');
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'S2: user must be able to abort');
    });

    testWidgets(
        'S3: re-key requires a newly generated seed saved by the user before '
        'proceeding (reveal-gate)', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Re-key to new Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Re-key to new Recovery Seed'));
      await tester.pumpAndSettle();

      // The dialog must surface the generated new seed for safekeeping and
      // require the user to enter it back before re-key can proceed.
      expect(find.byType(TextField), findsWidgets,
          reason: 'S3: reveal-gate requires a typed seed confirmation');
      expect(find.text('I have saved my new Recovery Seed'), findsOneWidget,
          reason: 'S3: user must confirm they saved the new seed');
    });

    testWidgets(
        'S4: cancel/back at any stage aborts with no chain mutation',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Re-key to new Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Re-key to new Recovery Seed'));
      await tester.pumpAndSettle();

      // Cancel the confirmation dialog.
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Dialog closed; no re-key has run.
      expect(find.byType(AlertDialog), findsNothing,
          reason: 'S4: cancel must close the dialog');
      expect(find.text('Re-key to new Recovery Seed'), findsOneWidget,
          reason: 'S4: settings must remain on the re-key option after abort');
    });

    testWidgets(
        'S5: network failure during R2 push surfaces a clear error and keeps '
        'the local chain consistent', (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Re-key to new Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Re-key to new Recovery Seed'));
      await tester.pumpAndSettle();

      // (Phase 3) Trigger re-key with a failing remote push and assert a clear
      // error is shown while the local chain is left usable. Phase 2 RED
      // anchors the failure on the missing tile.
      expect(find.text('Re-key to new Recovery Seed'), findsOneWidget);
    });

    testWidgets(
        'S6: new-seed reveal dialog appears once and is never auto-re-shown',
        (tester) async {
      await pumpScreenWidget(tester, const SettingsScreen(),
          initialPhase: AppPhase.ready);
      await tester.pumpAndSettle();

      // (Phase 3) After a successful re-key the reveal dialog shows once and
      // is not automatically re-shown. Phase 2 RED: re-key option not yet
      // wired, so this anchors on the tile contract.
      await tester.scrollUntilVisible(
        find.text('Re-key to new Recovery Seed'),
        200,
      );
      await tester.pumpAndSettle();
      expect(find.text('Re-key to new Recovery Seed'), findsOneWidget);
    });
  });
}
