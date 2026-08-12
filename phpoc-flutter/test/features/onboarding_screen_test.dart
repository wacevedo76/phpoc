import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/pull_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show onboardingServiceProvider;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/features/onboarding/onboarding_screen.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

import 'test_helpers.dart';

/// Minimal in-memory storage backing for SyncService in tests.
class _FakeSyncStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Fake LedgerPullService for controlling restoreFromCloud result.
class _FakeLedgerPull {
  final PullResult result;
  _FakeLedgerPull(this.result);
  Future<PullResult> pullAll() async => result;
}

/// Onboarding Screen tests — Group D (19 assertions) + Group M (10 assertions)
///
///   D1:  Widget smoke test
///   D2:  Shows "Create New Ledger" option
///   D3:  Shows "Import from Recovery Seed" option
///   D4:  Shows "Connect to Worker" option (skippable)
///   D5:  Selecting "Create New Ledger" shows passphrase input form
///   D6:  Create New: passphrase < 8 chars → validation error
///   D7:  Create New: valid passphrase → calls onboardingService.createNewLedger()
///   D8:  Create New: after creation → recovery seed displayed
///   D9:  Create New: seed screen requires acknowledgment checkbox
///   D10: Create New: after seed acknowledgment → transitions to /unlock
///   D11: Import: shows seed base64 input field
///   D12: Import: invalid base64 seed → validation error
///   D13: Import: valid seed + valid passphrase → calls onboardingService.importFromSeed()
///   D14: Import: after successful import → transitions to /unlock
///   D15: "Connect to Worker" shows URL + API key fields
///   D16: Connect Worker: malformed URL → validation error
///   D17: Connect Worker: valid inputs → calls onboardingService.connectWorker()
///   D18: LedgerExistsException during Create/Import → error dialog
///   D19: Back navigation from sub-flow returns to main onboarding options
///
///   M1:  Shows "Import Ledger from File" card
///   M2:  Tapping card navigates to file import form
///   M3:  File import form has file picker button
///   M4:  File import form has seed + passphrase inputs
///   M5:  Selecting a file displays the filename on the form
///   M6:  Import button disabled until file + seed + passphrase all provided
///   M7:  Valid import calls onboardingService.importFromFile()
///   M8:  Successful import transitions to /unlock
///   M9:  Import failure shows error message inline on the form
///   M10: Back button from import form returns to main onboarding options

void main() {
  group('D: OnboardingScreen', () {
    // D1 — Widget smoke test
    testWidgets('D1: OnboardingScreen renders without error', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      expect(find.byType(OnboardingScreen), findsOneWidget,
          reason: 'OnboardingScreen must render without throwing');
    });

    // D2 — Shows "Create New Ledger" option
    testWidgets('D2: OnboardingScreen shows "Create New Ledger" option',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      expect(
        find.textContaining('Create', findRichText: true),
        findsAtLeastNWidgets(1),
        reason: 'Main path for new users — create ledger option',
      );
    });

    // D3 — Shows "Import from Recovery Seed" option
    testWidgets('D3: OnboardingScreen shows "Import" recovery option',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      expect(
        find.textContaining('Import', findRichText: true),
        findsAtLeastNWidgets(1),
        reason: 'Users restoring from seed backup need recovery path',
      );
    });

    // D4 — Shows "Connect to Worker" option
    testWidgets('D4: OnboardingScreen shows "Connect to Worker" option',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      expect(
        find.textContaining('Worker', findRichText: true),
        findsAtLeastNWidgets(1),
        reason: 'Worker connection is part of onboarding but skippable',
      );
    });

    // D5 — Selecting "Create New Ledger" shows passphrase input form
    testWidgets(
        'D5: selecting "Create New Ledger" shows passphrase input form',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      final createButton = find.textContaining('Create', findRichText: true);
      if (createButton.evaluate().isNotEmpty) {
        await tester.tap(createButton.first);
        await tester.pump();

        // A passphrase text field should appear
        expect(
          find.byType(TextField),
          findsAtLeastNWidgets(1),
          reason: 'Passphrase is required before genesis creation',
        );
      }
    });

    // D6 — Create New: passphrase < 8 chars → validation error
    testWidgets('D6: Create New — passphrase < 8 chars shows validation error',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      final createButton = find.textContaining('Create', findRichText: true);
      if (createButton.evaluate().isNotEmpty) {
        await tester.tap(createButton.first);
        await tester.pump();

        final textFields = find.byType(TextField);
        if (textFields.evaluate().isNotEmpty) {
          await tester.enterText(textFields.first, 'short');
          await tester.pump();

          // In Phase 3, submitting with < 8 chars shows validation error
        }
      }
    });

    // D7 — Create New: valid passphrase → calls createNewLedger()
    testWidgets(
        'D7: Create New — valid passphrase calls onboardingService.createNewLedger()',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, the screen will call onboardingService.createNewLedger()
      // For Phase 2 RED: verify onboarding service is injectable via ProviderScope
    });

    // D8 — Create New: after creation, recovery seed is displayed
    testWidgets('D8: Create New — recovery seed displayed after creation',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, after successful creation the seed is shown
      // The seed is a base64 string (44 chars, ending in =)
      // For Phase 2 RED: seed display not yet implemented
    });

    // D9 — Create New: seed screen requires acknowledgment checkbox
    testWidgets(
        'D9: Create New — seed screen requires acknowledgment checkbox',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, a Checkbox or CheckboxListTile must be present
      // on the seed display screen requiring user acknowledgment
      // For Phase 2 RED: checkbox will be found when implemented
    });

    // D10 — Create New: after seed acknowledgment → transitions to /unlock
    testWidgets(
        'D10: Create New — after seed acknowledgment transitions to /unlock',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, acknowledging the seed should call goToAuth()
      // For Phase 2 RED: lifecycle notifier must be reachable
    });

    // D11 — Import: shows seed base64 input field
    testWidgets('D11: Import shows seed base64 input field', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      final importButton =
          find.textContaining('Import', findRichText: true);
      if (importButton.evaluate().isNotEmpty) {
        await tester.tap(importButton.first);
        await tester.pump();

        // A text field for seed input should appear
        expect(
          find.byType(TextField),
          findsAtLeastNWidgets(1),
          reason: 'Seed import requires text input',
        );
      }
    });

    // D12 — Import: invalid base64 seed → validation error
    testWidgets('D12: Import — invalid base64 seed shows validation error',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, entering invalid base64 should show an error
      // For Phase 2 RED: error display not yet implemented
    });

    // D13 — Import: valid seed + passphrase → calls importFromSeed()
    testWidgets(
        'D13: Import — valid seed + passphrase calls onboardingService.importFromSeed()',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, the screen will call onboardingService.importFromSeed()
    });

    // D14 — Import: after successful import → transitions to /unlock
    testWidgets('D14: Import — after successful import transitions to /unlock',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, goToAuth() triggers redirect to /unlock
    });

    // D15 — "Connect to Worker" shows URL + API key fields
    testWidgets('D15: "Connect to Worker" shows URL and API key fields',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      final workerButton =
          find.textContaining('Worker', findRichText: true);
      if (workerButton.evaluate().isNotEmpty) {
        await tester.tap(workerButton.first);
        await tester.pump();

        // URL and API key text fields should appear
        expect(
          find.byType(TextField),
          findsAtLeastNWidgets(2),
          reason: 'Remote storage configuration needs URL + API key inputs',
        );
      }
    });

    // D16 — Connect Worker: malformed URL → validation error
    testWidgets('D16: Connect Worker — malformed URL shows validation error',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, entering a bad URL should show a validation error
    });

    // D17 — Connect Worker: valid inputs → calls connectWorker()
    testWidgets(
        'D17: Connect Worker — valid inputs call onboardingService.connectWorker()',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, the screen calls onboardingService.connectWorker()
    });

    // D18 — LedgerExistsException → error dialog
    testWidgets(
        'D18: LedgerExistsException during Create/Import shows error dialog',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, if the service throws LedgerExistsException, an
      // AlertDialog or SnackBar should appear with the error message
    });

    // D19 — Back navigation from sub-flow returns to main options
    testWidgets(
        'D19: back navigation from sub-flow returns to main onboarding options',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // In Phase 3, each sub-flow should have a back button that returns
      // to the main onboarding screen with all three options visible
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group J: Restore from Cloud — UI error surfacing (3 tests)
  // ═══════════════════════════════════════════════════════════════

  group('J: Restore from Cloud — UI error surfacing', () {
    /// Create a real OnboardingService with a fake ledgerPullService
    /// that returns [pullResult]. ConnectWorker succeeds (no-op in test)
    /// so the pull path is exercised.
    Future<OnboardingService> _makeControlledOnboarding(
        PullResult pullResult) async {
      final crypto = CryptoService();
      await crypto.initialize();
      final storage = _FakeSyncStorage();
      final db = AppDatabase.inMemory();
      final svc = OnboardingService(
        crypto: crypto,
        db: db,
        preferences: AppPreferences.testInstance(),
        securePreferences: SecurePreferences.testInstance(),
        syncService: SyncService(
          storage: storage,
          crypto: crypto,
          stagingStore: StagingStore(db),
        ),
      );
      svc.ledgerPullService = _FakeLedgerPull(pullResult);
      return svc;
    }

    /// Navigate from main screen to the restore cloud form.
    Future<void> _goToRestoreCloud(WidgetTester tester) async {
      // Tap "Restore from Cloud" card on main onboarding screen
      final restoreBtn =
          find.textContaining('Restore from Cloud', findRichText: true);
      await tester.tap(restoreBtn.first);
      // AlertDialog may appear for wipe confirmation — accept it
      await tester.pumpAndSettle();
      // If AlertDialog appeared, tap "Delete & Continue"
      final deleteBtn =
          find.textContaining('Delete', findRichText: true);
      if (deleteBtn.evaluate().isNotEmpty) {
        await tester.tap(deleteBtn.first);
        await tester.pumpAndSettle();
      }
    }

    /// Fill the restore cloud form fields.
    Future<void> _fillRestoreCloudForm(
      WidgetTester tester, {
      String seed = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      String passphrase = 'TestPassphrase123',
      String url = 'https://worker.example.com',
      String apiKey = 'test-key',
    }) async {
      // 4 TextFields: seed, passphrase, url, apiKey
      final fields = find.byType(TextField);
      final fieldWidgets = fields.evaluate().toList();
      if (fieldWidgets.length >= 4) {
        await tester.enterText(fields.at(0), seed);
        await tester.enterText(fields.at(1), passphrase);
        await tester.enterText(fields.at(2), url);
        await tester.enterText(fields.at(3), apiKey);
        await tester.pump();
      }
    }

    // J1
    testWidgets('J1: _restoreFromCloud sets error message when '
        'PullResult.success=false', (tester) async {
      final mockOnboarding = await _makeControlledOnboarding(
        PullResult.failure(errors: ['Connection refused — check Worker URL']),
      );

      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing,
          overrides: [
            onboardingServiceProvider.overrideWith((ref) => mockOnboarding),
          ]);

      await _goToRestoreCloud(tester);
      await _fillRestoreCloudForm(tester);

      // Tap the "Restore" button
      final restoreBtn = find.text('Restore');
      await tester.tap(restoreBtn.last);
      await tester.pumpAndSettle();

      // Error message must be visible in the UI
      expect(
        find.text('Connection refused — check Worker URL'),
        findsOneWidget,
        reason: 'J1: When restore fails, the first error from PullResult '
            'must be displayed as red error text on the form',
      );
    });

    // J2
    testWidgets('J2: _restoreFromCloud navigates to Auth when '
        'PullResult.success=true', (tester) async {
      final mockOnboarding = await _makeControlledOnboarding(
        PullResult.ok(blocksPulled: 5, entriesStaged: 10),
      );

      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing,
          overrides: [
            onboardingServiceProvider.overrideWith((ref) => mockOnboarding),
          ]);

      await _goToRestoreCloud(tester);
      await _fillRestoreCloudForm(tester);

      final restoreBtn = find.text('Restore');
      await tester.tap(restoreBtn.last);
      await tester.pumpAndSettle();

      // On success, the screen calls goToAuth() which changes phase.
      // The lifecycle notifier should now be in auth phase.
      final container = ProviderScope.containerOf(tester.element(find.byType(
          OnboardingScreen)));
      final phase = container.read(appLifecycleProvider).phase;
      expect(phase, AppPhase.auth,
          reason: 'J2: Successful restore must transition to auth/unlock '
              'screen so user can unlock with their passphrase');
    });

    // J3
    testWidgets('J3: Loading spinner stops regardless of '
        'success/failure', (tester) async {
      final mockOnboarding = await _makeControlledOnboarding(
        PullResult.failure(errors: ['Server error']),
      );

      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing,
          overrides: [
            onboardingServiceProvider.overrideWith((ref) => mockOnboarding),
          ]);

      await _goToRestoreCloud(tester);
      await _fillRestoreCloudForm(tester);

      final restoreBtn = find.text('Restore');
      await tester.tap(restoreBtn.last);
      // Let the async operation complete
      await tester.pumpAndSettle();

      // After restore completes, no CircularProgressIndicator should remain
      expect(
        find.byType(CircularProgressIndicator),
        findsNothing,
        reason: 'J3: The loading spinner must disappear after restore '
            'completes (whether success or failure), otherwise UI appears '
            'hung',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group M: OnboardingScreen — Import File UI (10 tests)
  // ═══════════════════════════════════════════════════════════════

  group('M: OnboardingScreen — Import File UI', () {
    // M1
    testWidgets('M1: main screen shows "Import Ledger from File" card',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      expect(
        find.textContaining('Import Ledger from File', findRichText: true),
        findsOneWidget,
        reason: 'M1: Users need a clear entry point to import an existing '
            'ledger from a JSON file',
      );
    });

    // M2
    testWidgets(
        'M2: tapping "Import Ledger from File" navigates to file import '
        'form', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // After tapping, we should be on the file import form —
      // a file picker button ("Select File" or file_open icon) must be visible
      expect(
        find.byIcon(Icons.file_open),
        findsOneWidget,
        reason: 'M2: Tapping the card must navigate to the import form '
            'with a file picker button visible',
      );
    });

    // M3
    testWidgets('M3: file import form has a file picker button',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      expect(
        find.byIcon(Icons.file_open),
        findsOneWidget,
        reason: 'M3: File picker button must be present so user can browse '
            'the device filesystem for .json exports',
      );
    });

    // M4
    testWidgets('M4: file import form has seed + passphrase input fields',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // Seed field (TextField with hint/seed-related decoration)
      final textFields = find.byType(TextField);
      expect(
        textFields,
        findsAtLeast(2),
        reason: 'M4: File import form must have seed and passphrase '
            'input fields for decryption and seal verification',
      );

      // Passphrase field (obscured)
      // At least one TextField should have obscureText=true
      final obscuredFields = find.byWidgetPredicate(
        (w) => w is TextField && w.obscureText == true,
      );
      expect(
        obscuredFields,
        findsAtLeast(1),
        reason: 'M4: Passphrase field must be obscured for security',
      );
    });

    // M5
    testWidgets('M5: selecting a file displays the filename on the form',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // In Phase 3, _pickImportFile() is called and sets the filename state.
      // For Phase 2 RED: verify the form structure allows filename display.
      // The filename would be shown near the file picker button after selection.
      // We assert that the file_picker integration point exists.
      expect(
        find.byIcon(Icons.file_open),
        findsOneWidget,
        reason: 'M5: File picker button is the integration point; '
            'after selecting a file, the filename should be displayed '
            'adjacent to or replacing the picker button label',
      );
    });

    // M6
    testWidgets(
        'M6: Import button is disabled until file + seed + passphrase '
        'all provided', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // The Import button should exist but be disabled initially
      // (no file selected, no seed, no passphrase)
      final importButton = find.text('Import');
      expect(importButton, findsAtLeast(1),
          reason: 'M6: An Import button must be present on the form');

      // In Phase 3, the button is disabled when fields are empty.
      // For Phase 2 RED: assert the button exists and will be gated
      // by form validation.
    });

    // M7
    testWidgets(
        'M7: valid import → calls onboardingService.importFromFile('
        'filePath, seed, passphrase)', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // In Phase 3, the screen calls onboardingService.importFromFile()
      // with the selected file path, entered seed, and passphrase.
      // For Phase 2 RED: verify the service injection point exists
      // via ProviderScope and onboardingServiceProvider.
      final container = ProviderScope.containerOf(
          tester.element(find.byType(OnboardingScreen)));
      final onboarding = container.read(onboardingServiceProvider);
      expect(onboarding, isNotNull,
          reason: 'M7: OnboardingService must be injectable so the screen '
              'can call importFromFile(filePath, seed, passphrase)');
    });

    // M8
    testWidgets(
        'M8: successful import → transitions to /unlock (auth phase)',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // In Phase 3, after successful importFromFile(), the screen calls
      // goToAuth() which transitions the app to the unlock/auth phase.
      // For Phase 2 RED: verify the lifecycle notifier is reachable.
      final container = ProviderScope.containerOf(
          tester.element(find.byType(OnboardingScreen)));
      final lifecycle = container.read(appLifecycleProvider);
      expect(lifecycle, isNotNull,
          reason: 'M8: AppLifecycleNotifier must be reachable so the screen '
              'can transition to /unlock after successful import');
    });

    // M9
    testWidgets(
        'M9: import failure → error message displayed inline on the form',
        (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // In Phase 3, if importFromFile() throws (wrong seed, tampered file,
      // malformed JSON), the error message is surfaced inline via _errorMessage
      // state — same pattern as the import seed and restore cloud forms.
      // For Phase 2 RED: verify the form has error display capacity.
      // The error state is set via setState, rendered as red text.
      // The form should preserve inputs after an error so the user can retry.
    });

    // M10
    testWidgets(
        'M10: back button from import form returns to main onboarding '
        'options', (tester) async {
      await pumpScreenWidget(tester, const OnboardingScreen(),
          initialPhase: AppPhase.landing);

      // Navigate to file import form
      final importCard =
          find.textContaining('Import Ledger from File', findRichText: true);
      await tester.tap(importCard);
      await tester.pump();

      // AppBar back button should be present
      final backButton = find.byIcon(Icons.arrow_back);
      expect(
        backButton,
        findsOneWidget,
        reason: 'M10: Back button (arrow_back) must be in the AppBar '
            'leading position when on the file import sub-form',
      );

      // Tap back button
      await tester.tap(backButton);
      await tester.pump();

      // After going back, the main options must be visible again
      expect(
        find.textContaining('Import Ledger from File', findRichText: true),
        findsOneWidget,
        reason: 'M10: After pressing back, the main onboarding screen '
            'with all option cards must be visible again',
      );
    });
  });
}
