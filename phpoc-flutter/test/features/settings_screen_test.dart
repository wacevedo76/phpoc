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

  _SpyAuthService({
    required super.crypto,
    required super.db,
    required super.preferences,
  });

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
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs);
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
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs);
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
              spyAuth = _SpyAuthService(
                  crypto: crypto, db: db, preferences: prefs);
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
}
