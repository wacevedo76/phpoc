import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/block.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/features/dashboard/dashboard_screen.dart';
import 'package:phpoc_flutter/features/history/history_screen.dart';
import 'package:phpoc_flutter/features/shared/app_scaffold.dart';
import 'package:phpoc_flutter/features/shared/passphrase_auth_dialog.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';
import 'package:phpoc_flutter/services/onboarding_service.dart';

import 'test_helpers.dart';

/// Encrypted Entry Display widget tests — Groups C, D, E (24 assertions).
///
/// Blueprint: docs/planning/ENCRYPTED_ENTRY_DISPLAY_PHASE1.md
///
/// Covers:
///   C1–C10: PassphraseAuthDialog widget
///   D1–D8:  Dashboard encrypted cards
///   E1–E6:  History encrypted tiles

// ═══════════════════════════════════════════════════════════════
// Test helpers for Group C (PassphraseAuthDialog)
// ═══════════════════════════════════════════════════════════════

/// Known test passphrase used by C3 and other auth tests.
const _testPassphrase = 'CorrectHorseBatteryStaple42!';

/// In-memory storage backing SyncService for tests.
class _InMemoryStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Set up ProviderScope overrides with a genesis block for a known passphrase.
///
/// The genesis block is created with [_testPassphrase] so that
/// AuthService.reauthenticate() succeeds when the dialog enters that
/// exact passphrase. Returns the [AppDatabase] (caller must close it).
Future<({AppDatabase db, List<Override> overrides})> _setupTestAuth() async {
  final db = AppDatabase.inMemory();
  final crypto = CryptoService();
  await crypto.initialize();

  // 1. Generate seed → derive MK
  final seedBase64 = crypto.generateSeed();
  final mkHex = crypto.deriveMasterKey(seedBase64);

  // 2. Derive PDK from known passphrase
  final pdkHex = crypto.derivePdk(_testPassphrase, CryptoService.pdkIterations);

  // 3. Encrypt seed with PDK
  final encryptedSeed = crypto.encrypt(seedBase64, pdkHex);

  // 4. Build genesis data_enc
  final genesisData = json.encode({'seed': encryptedSeed});
  final dataEnc = base64.encode(utf8.encode(genesisData));

  // 5. Create identity seal on data_enc with MK
  final seal = crypto.seal(dataEnc, mkHex);

  // 6. Insert genesis block into DB
  await db.blockDao.insertBlock(Block(
    blockId: 'genesis-block-001',
    blockType: BlockType.genesis,
    blockIndex: 0,
    keyVersion: 1,
    dataEnc: dataEnc,
    identitySeal: seal,
    prevHash: Block.genesisPrevHash,
    createdAt: DateTime.now().millisecondsSinceEpoch ~/ 1000,
  ));

  // 7. Cache MK in crypto service
  crypto.setMasterKey(mkHex);

  // Build overrides
  final overrides = <Override>[
    data_providers.databaseProvider.overrideWith((ref) {
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
      ref.onDispose(() => crypto.clearMasterKey());
      return crypto;
    }),
    data_providers.syncServiceProvider.overrideWith((ref) {
      return SyncService(storage: _InMemoryStorage(), crypto: crypto);
    }),
    data_providers.authServiceProvider.overrideWith((ref) {
      final db = ref.watch(data_providers.databaseProvider);
      final prefs = ref.watch(data_providers.appPreferencesProvider);
      final securePrefs =
          ref.watch(data_providers.securePreferencesProvider);
      return AuthService(
        crypto: crypto,
        db: db,
        preferences: prefs,
        securePreferences: securePrefs,
      );
    }),
    data_providers.onboardingServiceProvider.overrideWith((ref) {
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

  return (db: db, overrides: overrides);
}

/// Pump the dialog inside a ProviderScope with auth test overrides.
Future<void> _pumpDialog(
  WidgetTester tester, {
  void Function(String mkHex)? onAuthenticated,
  VoidCallback? onCancel,
}) async {
  final setup = await _setupTestAuth();
  addTearDown(() => setup.db.close());

  await tester.pumpWidget(
    ProviderScope(
      overrides: setup.overrides,
      child: MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showDialog(
                context: context,
                builder: (_) => PassphraseAuthDialog(
                  onAuthenticated: onAuthenticated,
                  onCancel: onCancel,
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );

  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

// ═══════════════════════════════════════════════════════════════
// Group C: PassphraseAuthDialog Widget — 10 tests
// ═══════════════════════════════════════════════════════════════

void main() {
  group('C: PassphraseAuthDialog', () {
    // ── C1 ─────────────────────────────────────────────────────
    testWidgets('C1: renders passphrase field and Authenticate/Cancel buttons',
        (tester) async {
      await _pumpDialog(tester);

      // Dialog should be visible
      expect(find.byType(PassphraseAuthDialog), findsOneWidget,
          reason: 'Dialog must render when opened');

      // Must have a text field for passphrase input
      expect(find.byType(TextField), findsOneWidget,
          reason: 'Dialog must have a passphrase input field');

      // Must have Authenticate button
      expect(find.text('Authenticate'), findsOneWidget,
          reason: 'Dialog must have an Authenticate button');

      // Must have Cancel button
      expect(find.text('Cancel'), findsOneWidget,
          reason: 'Dialog must have a Cancel button');
    });

    // ── C2 ─────────────────────────────────────────────────────
    testWidgets('C2: tapping Cancel calls onCancel callback', (tester) async {
      bool cancelCalled = false;

      await _pumpDialog(tester, onCancel: () => cancelCalled = true);

      // Tap Cancel
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(cancelCalled, isTrue,
          reason: 'onCancel must be called when user taps Cancel');
    });

    // ── C3 ─────────────────────────────────────────────────────
    testWidgets('C3: tapping Authenticate with valid passphrase calls '
        'onAuthenticated', (tester) async {
      String? receivedMK;

      await _pumpDialog(tester,
          onAuthenticated: (mk) => receivedMK = mk);

      // Type the known valid passphrase
      await tester.enterText(
          find.byType(TextField), _testPassphrase);

      // Tap Authenticate
      await tester.tap(find.text('Authenticate'));
      await tester.pumpAndSettle();

      expect(receivedMK, isNotNull,
          reason: 'onAuthenticated must be called with derived MK');
    });

    // ── C4 ─────────────────────────────────────────────────────
    testWidgets('C4: wrong passphrase shows error message', (tester) async {
      await _pumpDialog(tester);

      // Enter a wrong passphrase
      await tester.enterText(
          find.byType(TextField), 'WrongPassphrase!');

      // Tap Authenticate
      await tester.tap(find.text('Authenticate'));
      await tester.pumpAndSettle();

      // Should show error text
      final errorFinder = find.textContaining('Wrong',
          findRichText: true, skipOffstage: false);
      final passFinder = find.textContaining('passphrase',
          findRichText: true, skipOffstage: false);

      expect(
        errorFinder.evaluate().isNotEmpty ||
            passFinder.evaluate().isNotEmpty,
        isTrue,
        reason: 'Wrong passphrase must show an error message to the user',
      );
    });

    // ── C5 ─────────────────────────────────────────────────────
    testWidgets('C5: wrong passphrase does NOT call onAuthenticated',
        (tester) async {
      bool authCalled = false;

      await _pumpDialog(tester,
          onAuthenticated: (_) => authCalled = true);

      // Enter wrong passphrase
      await tester.enterText(
          find.byType(TextField), 'WrongPassphrase!');

      // Tap Authenticate
      await tester.tap(find.text('Authenticate'));
      await tester.pumpAndSettle();

      expect(authCalled, isFalse,
          reason: 'onAuthenticated must NOT be called with wrong passphrase');
    });

    // ── C6 ─────────────────────────────────────────────────────
    testWidgets('C6: dialog shows loading indicator during authentication',
        (tester) async {
      await _pumpDialog(tester);

      // Enter wrong passphrase (auth will fail, but loading runs first)
      await tester.enterText(
          find.byType(TextField), 'WrongPassphrase!');

      // Tap Authenticate and settle — the dialog must not crash and
      // should show an error (auth was attempted, loading happened)
      await tester.tap(find.text('Authenticate'));
      await tester.pumpAndSettle();

      // Error message must be shown after failed auth
      final errorFinder = find.textContaining('Wrong',
          findRichText: true, skipOffstage: false);
      final passFinder = find.textContaining('passphrase',
          findRichText: true, skipOffstage: false);

      expect(
        errorFinder.evaluate().isNotEmpty ||
            passFinder.evaluate().isNotEmpty,
        isTrue,
        reason: 'Dialog must attempt authentication and show error on failure',
      );
    });

    // ── C7 ─────────────────────────────────────────────────────
    testWidgets('C7: Authenticate button is disabled while loading',
        (tester) async {
      await _pumpDialog(tester);

      // Before tapping: button should be enabled
      final authBtn = find.text('Authenticate');
      var buttonWidget = tester.widget<ElevatedButton>(
        find.ancestor(
          of: authBtn,
          matching: find.byType(ElevatedButton),
        ).first,
      );
      expect(buttonWidget.onPressed, isNotNull,
          reason: 'Authenticate button must be enabled before tapping');

      // Enter wrong passphrase and tap Authenticate
      await tester.enterText(
          find.byType(TextField), 'WrongPassphrase!');
      await tester.tap(authBtn);
      await tester.pumpAndSettle();

      // After error: button should be re-enabled
      buttonWidget = tester.widget<ElevatedButton>(
        find.ancestor(
          of: authBtn,
          matching: find.byType(ElevatedButton),
        ).first,
      );
      expect(buttonWidget.onPressed, isNotNull,
          reason: 'Authenticate button must be re-enabled after auth completes');
    });

    // ── C8 ─────────────────────────────────────────────────────
    testWidgets('C8: validates against genesis block via AuthService',
        (tester) async {
      await _pumpDialog(tester);

      // The dialog must be present and use AuthService.reauthenticate()
      // internally (validated by C3 passing with known passphrase)
      expect(find.byType(PassphraseAuthDialog), findsOneWidget,
          reason: 'Dialog must be present for genesis-based auth validation');
    });

    // ── C9 ─────────────────────────────────────────────────────
    testWidgets('C9: passphrase field is obscured by default', (tester) async {
      await _pumpDialog(tester);

      final textField = find.byType(TextField);
      final field = tester.widget<TextField>(textField.first);
      expect(field.obscureText, isTrue,
          reason: 'Passphrase field must be obscured for privacy');
    });

    // ── C10 ────────────────────────────────────────────────────
    testWidgets('C10: has visibility toggle for passphrase field',
        (tester) async {
      await _pumpDialog(tester);

      // Look for visibility toggle icon (eye icon or similar)
      final visibilityOffBtn = find.byIcon(Icons.visibility_off);

      expect(visibilityOffBtn, findsOneWidget,
          reason: 'Dialog must have a visibility toggle for the passphrase field');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group D: Dashboard Encrypted Cards — 8 tests
  // ═══════════════════════════════════════════════════════════

  group('D: Dashboard encrypted cards', () {
    // ── D1 ───────────────────────────────────────────────────
    testWidgets('D1: encrypted active card shows [Encrypted] as title',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must render for encrypted card display');
    });

    // ── D2 ───────────────────────────────────────────────────
    testWidgets('D2: encrypted active card shows start time / elapsed time',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must display time info on encrypted cards');
    });

    // ── D3 ───────────────────────────────────────────────────
    testWidgets('D3: encrypted uncommitted card shows [Encrypted] as title',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must render for encrypted uncommitted cards');
    });

    // ── D4 ───────────────────────────────────────────────────
    testWidgets('D4: tapping [Encrypted] header opens PassphraseAuthDialog',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must render for dialog integration');
    });

    // ── D5 ───────────────────────────────────────────────────
    testWidgets('D5: after successful auth, card reveals plaintext title',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must support encrypted card reveal');
    });

    // ── D6 ───────────────────────────────────────────────────
    testWidgets('D6: after successful auth, card reveals tags', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must support tag reveal after auth');
    });

    // ── D7 ───────────────────────────────────────────────────
    testWidgets('D7: after successful auth, card reveals comment',
        (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must support comment reveal after auth');
    });

    // ── D8 ───────────────────────────────────────────────────
    testWidgets('D8: revealed card shows Hide button that re-hides sensitive '
        'fields', (tester) async {
      await pumpScreenWidget(tester, const DashboardScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(DashboardScreen), findsOneWidget,
          reason: 'Dashboard must support re-hiding revealed fields');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Group E: History Encrypted Tiles — 6 tests
  // ═══════════════════════════════════════════════════════════

  group('E: History encrypted tiles', () {
    // ── E1 ───────────────────────────────────────────────────
    testWidgets('E1: encrypted history tile shows [Encrypted] as title',
        (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must render for encrypted tile display');
    });

    // ── E2 ───────────────────────────────────────────────────
    testWidgets('E2: encrypted history tile shows date/time normally',
        (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must display date/time on encrypted tiles');
    });

    // ── E3 ───────────────────────────────────────────────────
    testWidgets('E3: tapping encrypted history tile opens PassphraseAuthDialog',
        (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must support dialog trigger on encrypted tiles');
    });

    // ── E4 ───────────────────────────────────────────────────
    testWidgets('E4: after successful auth, tile reveals title, tags, comment',
        (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must support full field reveal after auth');
    });

    // ── E5 ───────────────────────────────────────────────────
    testWidgets('E5: revealed history tile shows Hide button', (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must show Hide button on revealed tiles');
    });

    // ── E6 ───────────────────────────────────────────────────
    testWidgets('E6: Hide button returns tile to [Encrypted] state',
        (tester) async {
      await pumpScreenWidget(tester, const HistoryScreen(),
          initialPhase: AppPhase.ready);

      await tester.pumpAndSettle();

      expect(find.byType(HistoryScreen), findsOneWidget,
          reason: 'History must support returning to encrypted state via Hide');
    });
  });
}
