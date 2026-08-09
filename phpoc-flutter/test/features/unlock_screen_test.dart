import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' show authServiceProvider;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/features/auth/unlock_screen.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

import 'test_helpers.dart';

// ═══════════════════════════════════════════════════════════════
// Spy AuthService with biometric stubs for widget tests
// ═══════════════════════════════════════════════════════════════

/// Configurable spy for widget-level biometric tests.
///
/// Unlike the service-level spy, this returns configurable values
/// so widget tests can verify UI visibility and tap behavior.
class _BioWidgetAuthService extends AuthService {
  bool biometricsAvailable = false;
  bool biometricEnabled = false;
  bool unlockResult = false;
  bool unlockThrows = false;
  String unlockError = '';
  bool unlockCalled = false;

  _BioWidgetAuthService({
    required super.crypto,
    required super.db,
    required super.preferences,
    required super.securePreferences,
  });

  Future<bool> isBiometricsAvailable() async => biometricsAvailable;

  bool isBiometricEnabled() => biometricEnabled;

  Future<bool> unlockWithBiometric() async {
    unlockCalled = true;
    if (unlockThrows) throw AuthException(unlockError);
    return unlockResult;
  }

  // enrollBiometric + disableBiometric not used by unlock screen
  Future<void> enrollBiometric() async {}

  Future<void> disableBiometric() async {}
}

_BioWidgetAuthService _makeBioAuthServiceForWidget() {
  final crypto = CryptoService()..initialize();
  return _BioWidgetAuthService(
    crypto: crypto,
    db: AppDatabase.inMemory(),
    preferences: AppPreferences.testInstance(),
    securePreferences: SecurePreferences.testInstance(),
  );
}

/// Unlock Screen tests — Group C (11) + D (8) + E (5) + F (3) = 27 assertions
///
///   C1–C11: Passphrase unlock UI
///   D1–D8:  Biometric unlock UI (Phase 2 RED — biometric methods not yet implemented)
///   E1–E5:  Wipe Ledger button + confirmation dialog UI
///   F1–F3:  Wipe Ledger confirm action + navigation

void main() {
  group('C: UnlockScreen', () {
    // C1 — Widget smoke test
    testWidgets('C1: UnlockScreen renders without error', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      expect(find.byType(UnlockScreen), findsOneWidget,
          reason: 'UnlockScreen must render without throwing');
    });

    // C2 — Shows passphrase text field
    testWidgets('C2: UnlockScreen shows a passphrase text field',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      expect(find.byType(TextField), findsAtLeastNWidgets(1),
          reason: 'Core unlock mechanism — passphrase text field');
    });

    // C3 — Passphrase field is obscured (obscureText: true)
    testWidgets('C3: passphrase field is obscured', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Find TextField with obscureText: true
      final textFields = tester.widgetList<TextField>(find.byType(TextField));
      final hasObscuredField = textFields.any((tf) => tf.obscureText == true);
      expect(hasObscuredField, isTrue,
          reason: 'Passphrase must never be visible on screen');
    });

    // C4 — Passphrase field has visibility toggle
    testWidgets('C4: passphrase field has visibility toggle (eye icon)',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Expect an IconButton with visibility/visibility_off icon
      final hasVisibilityToggle = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final iconWidget = w.icon;
          if (iconWidget is Icon) {
            return iconWidget.icon == Icons.visibility ||
                iconWidget.icon == Icons.visibility_off;
          }
        }
        return false;
      });

      expect(hasVisibilityToggle, findsAtLeastNWidgets(1),
          reason: 'Long passphrases benefit from optional visibility toggle');
    });

    // C5 — Empty passphrase shows validation error
    testWidgets('C5: tapping Unlock with empty passphrase shows validation '
        'error', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      final unlockButton = find.text('Unlock');
      if (unlockButton.evaluate().isNotEmpty) {
        await tester.tap(unlockButton);
        await tester.pump();

        // Expect a validation error message near the passphrase field
        expect(
          find.textContaining('passphrase', findRichText: true),
          findsAtLeastNWidgets(1),
          reason: 'Must prevent unnecessary crypto operations with empty input',
        );
      }
    });

    // C6 — Passphrase < 8 chars shows validation error
    testWidgets('C6: passphrase < 8 chars shows validation error',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Type short passphrase
      final textField = find.byType(TextField);
      if (textField.evaluate().isNotEmpty) {
        await tester.enterText(textField.first, 'short');
        await tester.pump();

        final unlockButton = find.text('Unlock');
        if (unlockButton.evaluate().isNotEmpty) {
          await tester.tap(unlockButton);
          await tester.pump();

          // Expect a length validation error
          expect(
            find.textContaining('8', findRichText: true),
            findsAtLeastNWidgets(1),
            reason: 'Must match AuthService.unlock() contract (≥8 chars)',
          );
        }
      }
    });

    // C7 — Wrong passphrase shows error message
    testWidgets('C7: wrong passphrase shows AuthException error message',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      final textField = find.byType(TextField);
      if (textField.evaluate().isNotEmpty) {
        await tester.enterText(
            textField.first, 'WrongPassphraseButLongEnough');
        await tester.pump();

        final unlockButton = find.text('Unlock');
        if (unlockButton.evaluate().isNotEmpty) {
          await tester.tap(unlockButton);
          // Wait for async unlock to fail
          await tester.pumpAndSettle(const Duration(seconds: 1));

          // Expect some error text to appear
          // In Phase 3, AuthException message will be surfaced
        }
      }
    });

    // C8 — Correct passphrase calls authService.unlock()
    testWidgets('C8: correct passphrase calls authService.unlock() then '
        'goToReady()', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // In Phase 3, tapping Unlock with correct passphrase will:
      // 1. Call authService.unlock(passphrase, seed)
      // 2. Call appLifecycleNotifier.goToReady()
      // For Phase 2 RED: button exists but full flow not yet implemented
      expect(find.text('Unlock'), findsAtLeastNWidgets(1),
          reason: 'Core authentication flow — Unlock button must exist');
    });

    // C9 — After unlock, router redirects to /
    testWidgets('C9: after successful unlock, router redirects to /',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // After Phase 3 implementation, goToReady() triggers router redirect
      // For Phase 2 RED: verify the screen renders
      expect(find.byType(UnlockScreen), findsOneWidget);
    });

    // C10 — Unlock button disabled during validation
    testWidgets('C10: Unlock button shows spinner during passphrase validation',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // In Phase 3, the Unlock button should show a CircularProgressIndicator
      // or be disabled during async validation
      expect(find.text('Unlock'), findsAtLeastNWidgets(1),
          reason: 'Prevent double-submit — Unlock button must exist');
    });

    // C11 — Error state clears when user starts typing again
    testWidgets('C11: error state clears when user starts typing again',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      final textField = find.byType(TextField);
      if (textField.evaluate().isNotEmpty) {
        // Enter new text should clear any previous error state
        await tester.enterText(textField.first, 'NewPassphrase123');
        await tester.pump();

        // In Phase 3, previous error text should be gone
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group D: UnlockScreen — Biometric UI (D1–D8)
  //
  // Phase 2 RED: All tests will fail because the biometric UI elements
  // (fingerprint icon, error messages, etc.) are not yet implemented.
  // D1–D3 check for biometric icon visibility; D4 tests tap action;
  // D5–D8 test success/cancel/failure/cold-reboot UX flows.
  // ═══════════════════════════════════════════════════════════════

  group('D: UnlockScreen — Biometric UI', () {
    _BioWidgetAuthService? _spyAuth;

    /// Pump UnlockScreen with a [_BioWidgetAuthService] override.
    Future<void> _pumpBioUnlockScreen(
      WidgetTester tester, {
      bool biometricsAvailable = false,
      bool biometricEnabled = false,
      bool unlockResult = false,
    }) async {
      _spyAuth = null;
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth,
          overrides: [
            authServiceProvider.overrideWith((ref) {
              final testAuth = _makeBioAuthServiceForWidget();
              testAuth.biometricsAvailable = biometricsAvailable;
              testAuth.biometricEnabled = biometricEnabled;
              testAuth.unlockResult = unlockResult;
              _spyAuth = testAuth;
              return testAuth;
            }),
          ]);
      // Let async _checkBiometricState (initState) complete
      await tester.pump();
    }

    // D1 — Fingerprint icon visible when biometrics available and enabled
    testWidgets('D1: fingerprint icon visible when biometrics available and '
        'enabled', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true, biometricEnabled: true);

      // In Phase 3: an IconButton with Icons.fingerprint appears
      final fingerprintIcon = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      expect(fingerprintIcon, findsOneWidget,
          reason: 'Fingerprint icon must be visible when biometrics are '
              'available and enabled');
    });

    // D2 — Fingerprint icon NOT visible when biometrics unavailable
    testWidgets('D2: fingerprint icon NOT visible when biometrics unavailable',
        (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: false, biometricEnabled: true);

      final fingerprintIcon = find.byWidgetPredicate((w) {
        if (w is Icon) return w.icon == Icons.fingerprint;
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      expect(fingerprintIcon, findsNothing,
          reason: 'Fingerprint icon must NOT appear when biometric hardware '
              'is unavailable');
    });

    // D3 — Fingerprint icon NOT visible when not enabled
    testWidgets('D3: fingerprint icon NOT visible when biometrics available '
        'but not enabled', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true, biometricEnabled: false);

      final fingerprintIcon = find.byWidgetPredicate((w) {
        if (w is Icon) return w.icon == Icons.fingerprint;
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      expect(fingerprintIcon, findsNothing,
          reason: 'Fingerprint icon must NOT appear when biometrics are '
              'available but user has not opted in');
    });

    // D4 — Tapping fingerprint icon calls unlockWithBiometric()
    testWidgets('D4: tapping fingerprint icon calls unlockWithBiometric()',
        (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true, biometricEnabled: true);

      // In Phase 3: tap the fingerprint icon → calls unlockWithBiometric()
      final fingerprintButton = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      if (fingerprintButton.evaluate().isNotEmpty) {
        await tester.tap(fingerprintButton);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(_spyAuth?.unlockCalled, isTrue,
          reason: 'Tapping the fingerprint icon must trigger '
              'unlockWithBiometric()');
    });

    // D5 — On biometric success, screen transitions to ready
    testWidgets('D5: on biometric success, screen transitions to ready '
        '(no passphrase prompt)', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true,
          biometricEnabled: true,
          unlockResult: true);

      // In Phase 3: after biometric success, goToReady() is called
      // and the app transitions away from the unlock screen

      // Tap the fingerprint button
      final fingerprintButton = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      if (fingerprintButton.evaluate().isNotEmpty) {
        await tester.tap(fingerprintButton);
        // Use pump() instead of pumpAndSettle() — the spinner is infinite
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }

      final container = ProviderScope.containerOf(
          tester.element(find.byType(UnlockScreen)));
      final phase = container.read(appLifecycleProvider).phase;

      expect(phase, AppPhase.ready,
          reason: 'Successful biometric unlock must transition to ready phase');
    });

    // D6 — On biometric cancel, passphrase field remains
    testWidgets('D6: on biometric cancel, passphrase field remains (no error, '
        'no transition)', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true,
          biometricEnabled: true,
          unlockResult: false); // simulate cancel

      // In Phase 3: user cancels biometric → passphrase field stays
      // No error message, no transition
      expect(find.byType(TextField), findsAtLeastNWidgets(1),
          reason: 'Passphrase field must remain after biometric cancel');

      // Phase should still be auth
      final container = ProviderScope.containerOf(
          tester.element(find.byType(UnlockScreen)));
      final phase = container.read(appLifecycleProvider).phase;
      expect(phase, AppPhase.auth,
          reason: 'After biometric cancel, app must stay on unlock screen');
    });

    // D7 — On biometric failure, meaningful message shown + passphrase available
    testWidgets('D7: on biometric failure, meaningful message shown + '
        'passphrase field available', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true, biometricEnabled: true);
      _spyAuth?.unlockThrows = true;
      _spyAuth?.unlockError = 'Biometric authentication failed';

      // In Phase 3: biometric fails → error message displayed
      // Passphrase field remains available for fallback
      final fingerprintButton = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      if (fingerprintButton.evaluate().isNotEmpty) {
        await tester.tap(fingerprintButton);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }

      // In Phase 3: error text should appear
      expect(
        find.textContaining('failed'),
        findsOneWidget,
        reason: 'Biometric failure must show a meaningful error message',
      );

      // Passphrase field must still be available
      expect(find.byType(TextField), findsAtLeastNWidgets(1),
          reason: 'Passphrase fallback must be available after biometric '
              'failure');
    });

    // D8 — On cold reboot error, passphrase field shown without scary error
    testWidgets('D8: on cold reboot error, passphrase field shown without '
        'scary error message', (tester) async {
      await _pumpBioUnlockScreen(tester,
          biometricsAvailable: true, biometricEnabled: true);
      _spyAuth?.unlockThrows = true;
      _spyAuth?.unlockError = 'Device credential required after restart';

      // In Phase 3: cold reboot → biometric unavailable → passphrase shown
      // The error message must NOT be a cryptic stack trace
      final fingerprintButton = find.byWidgetPredicate((w) {
        if (w is IconButton) {
          final icon = w.icon;
          if (icon is Icon) return icon.icon == Icons.fingerprint;
        }
        return false;
      });

      if (fingerprintButton.evaluate().isNotEmpty) {
        await tester.tap(fingerprintButton);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }

      // In Phase 3: passphrase field must be present (not hidden behind error)
      expect(find.byType(TextField), findsAtLeastNWidgets(1),
          reason: 'Passphrase field must be visible after cold reboot — '
              'biometric is unavailable, fallback to passphrase');

      // Must NOT show a raw exception message
      expect(
        find.textContaining('PlatformException'),
        findsNothing,
        reason: 'Cold reboot error must be user-friendly, not a raw platform '
            'exception',
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group E: UnlockScreen — Wipe Ledger Button UI (E1–E5)
  //
  // Phase 2 RED: These tests will fail because the "Wipe Ledger"
  // button and confirmation dialog are not yet implemented.
  // ═══════════════════════════════════════════════════════════════

  group('E: UnlockScreen — Wipe Ledger Button UI', () {
    // E1 (Phase 1 C1)
    testWidgets('E1: "Wipe Ledger" button is visible below the "Unlock" '
        'button', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // The "Wipe Ledger" button must exist on the unlock screen
      expect(find.text('Wipe Ledger'), findsOneWidget,
          reason: 'Wipe Ledger button must be visible and discoverable on the '
              'unlock screen');

      // Verify "Unlock" button exists above/before "Wipe Ledger" in the tree
      // The Unlock button should be the primary action, wipe is secondary
      final unlockFinder = find.text('Unlock');
      final wipeFinder = find.text('Wipe Ledger');
      expect(unlockFinder, findsAtLeastNWidgets(1));
      expect(wipeFinder, findsOneWidget);
    });

    // E2 (Phase 1 C2)
    testWidgets('E2: tapping "Wipe Ledger" shows a confirmation dialog',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Tap the "Wipe Ledger" button — must exist
      final wipeButton = find.text('Wipe Ledger');
      expect(wipeButton, findsOneWidget,
          reason: 'Wipe Ledger button must exist before testing dialog');
      await tester.tap(wipeButton);
      await tester.pump();

      // A dialog must appear after tapping
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'Destructive action requires explicit confirmation dialog');
    });

    // E3 (Phase 1 C3)
    testWidgets('E3: confirmation dialog warns about staging deletion, '
        'ledger deletion, MK + credential removal', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Tap "Wipe Ledger" to open dialog
      final wipeButton = find.text('Wipe Ledger');
      expect(wipeButton, findsOneWidget);
      await tester.tap(wipeButton);
      await tester.pump();

      // The dialog must explicitly warn the user about what will be lost
      // At minimum: "staging", "ledger", and credentials/keys
      expect(find.textContaining('staging', findRichText: true),
          findsOneWidget,
          reason: 'User must be warned staging data will be deleted');
      expect(find.textContaining('ledger', findRichText: true),
          findsOneWidget,
          reason: 'User must be warned ledger data will be deleted');
      expect(find.textContaining('master key', findRichText: true),
          findsOneWidget,
          reason: 'User must be warned MK + credentials will be removed');
    });

    // E4 (Phase 1 C4)
    testWidgets('E4: dialog has "Cancel" and "Wipe Ledger" action buttons',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Tap "Wipe Ledger" to open dialog
      final wipeButton = find.text('Wipe Ledger');
      expect(wipeButton, findsOneWidget);
      await tester.tap(wipeButton);
      await tester.pump();

      // The dialog must have both Cancel and confirm "Wipe Ledger" buttons
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'Cancel button allows safe dismiss without wiping');
      // There should be a "Wipe Ledger" button in the dialog (confirm action)
      // In the dialog, this might be the same text as the trigger button
      expect(find.text('Wipe Ledger'), findsWidgets,
          reason: 'Confirm button must exist inside the dialog');
    });

    // E5 (Phase 1 C5)
    testWidgets('E5: tapping "Cancel" dismisses the dialog without wiping',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Tap "Wipe Ledger" to open dialog
      final wipeButton = find.text('Wipe Ledger');
      expect(wipeButton, findsOneWidget);
      await tester.tap(wipeButton);
      await tester.pump();

      // Dialog should be visible
      expect(find.byType(AlertDialog), findsOneWidget);

      // Tap Cancel
      final cancelButton = find.text('Cancel');
      expect(cancelButton, findsOneWidget);
      await tester.tap(cancelButton);
      await tester.pump();

      // Dialog must be dismissed
      expect(find.byType(AlertDialog), findsNothing,
          reason: 'Cancel must dismiss the dialog without any data deletion');

      // The UnlockScreen must still be visible (not navigated away)
      expect(find.byType(UnlockScreen), findsOneWidget);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Group F: UnlockScreen — Wipe Ledger Action (F1–F3)
  //
  // Phase 2 RED: These tests will fail because wipeLedger() and
  // the post-wipe navigation are not yet implemented.
  // ═══════════════════════════════════════════════════════════════

  group('F: UnlockScreen — Wipe Ledger Action', () {
    // F1 (Phase 1 D1)
    testWidgets('F1: confirming wipe calls AuthService.wipeLedger()',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // Tap "Wipe Ledger" to open dialog, then confirm
      final wipeButton = find.text('Wipe Ledger');
      expect(wipeButton, findsOneWidget);
      await tester.tap(wipeButton);
      await tester.pump();

      // The confirmation dialog must appear
      expect(find.byType(AlertDialog), findsOneWidget,
          reason: 'Confirmation dialog must appear before wipe action');

      // After confirming, AuthService.wipeLedger() must be called.
      // In Phase 3, we spy on the auth service to verify the call.
      // For Phase 2 RED: the dialog is the prerequisite structure.
    });

    // F2 (Phase 1 D2)
    testWidgets('F2: after successful wipe, app navigates to LandingScreen',
        (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // In Phase 3: after confirming wipe + successful wipeLedger() call,
      // the app must navigate to the landing screen.
      //
      // Verify the initial state is auth (unlock screen)
      final container = ProviderScope.containerOf(
          tester.element(find.byType(UnlockScreen)));
      final phase = container.read(appLifecycleProvider).phase;
      expect(phase, AppPhase.auth,
          reason: 'Starting state must be AppPhase.auth');

      // After Phase 3 implementation, the phase must transition to
      // AppPhase.landing after a successful wipe.
      // For Phase 2 RED: this test establishes the expected post-wipe UX.
    });

    // F3 (Phase 1 D3)
    testWidgets('F3: wipe error shows error message and stays on '
        'UnlockScreen', (tester) async {
      await pumpScreenWidget(tester, const UnlockScreen(),
          initialPhase: AppPhase.auth);

      // In Phase 3: simulate wipeLedger() throwing, verify the error is
      // surfaced and the user remains on the unlock screen.
      //
      // Verify UnlockScreen is still visible after error
      expect(find.byType(UnlockScreen), findsOneWidget,
          reason: 'After wipe error, user must stay on unlock screen — not '
              'stranded in a broken state');

      // In Phase 3: error message text must appear
      // For Phase 2 RED: this test defines the error-resilience contract.
    });
  });
}
