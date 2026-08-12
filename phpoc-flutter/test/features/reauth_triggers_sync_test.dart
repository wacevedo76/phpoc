import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/core/crypto/crypto_service.dart';
import 'package:phpoc_flutter/core/models/sync_result.dart';
import 'package:phpoc_flutter/data/storage/database.dart';
import 'package:phpoc_flutter/data/storage/preferences.dart';
import 'package:phpoc_flutter/data/storage/providers.dart' as data_providers;
import 'package:phpoc_flutter/data/storage/secure_preferences.dart';
import 'package:phpoc_flutter/data/sync/staging_store.dart';
import 'package:phpoc_flutter/data/sync/sync_service.dart';
import 'package:phpoc_flutter/features/auth/unlock_screen.dart';
import 'package:phpoc_flutter/routing/app_router.dart';
import 'package:phpoc_flutter/services/auth_service.dart';

import 'test_helpers.dart';

/// Phase 2 (RED) — Trigger stage sync after re-authentication via the
/// Unlock screen (passphrase and biometric).
///
/// Blueprint: docs/planning/flutter/REAUTH_TRIGGERS_STAGE_SYNC_PHASE1.md
/// Groups U1 (passphrase unlock → checkAndSync + forced flag + fire-and-forget),
/// U2 (biometric parity), U3 (failed-auth no-sync / no-transport no-op).
///
/// Debug-first fact (2026-08-11): after a successful unlock
/// (`masterKeyCached = true`), `checkAndSyncCalls == 0` — the sync never runs.

// ═══════════════════════════════════════════════════════════════════
// Test infrastructure
// ═══════════════════════════════════════════════════════════════════

class _InMemoryStorage {
  final Map<String, dynamic> _data = {};
  Future<dynamic> get(String key) async => _data[key];
  Future<void> set(String key, dynamic value) async => _data[key] = value;
  Future<void> remove(String key) async => _data.remove(key);
}

/// Spy SyncService recording whether/when `checkAndSync` is invoked and the
/// `skipReadOnlyFastPath` flag it received. `transport` stays null so the
/// production `checkAndSync` returns `ready` immediately (D15 no-op), but the
/// call itself is recorded and the flag is captured.
class _SpySyncService extends SyncService {
  _SpySyncService()
      : super(
            storage: _InMemoryStorage(),
            crypto: _makeCrypto(),
            stagingStore: StagingStore(AppDatabase.inMemory()));

  int checkAndSyncCalls = 0;
  final List<bool> capturedSkipReadOnlyFastPath = [];

  @override
  Future<SyncCheckResult> checkAndSync({
    int cookieTtlMinutes = 30,
    bool skipReadOnlyFastPath = false,
  }) async {
    checkAndSyncCalls++;
    capturedSkipReadOnlyFastPath.add(skipReadOnlyFastPath);
    return super.checkAndSync(
      cookieTtlMinutes: cookieTtlMinutes,
      skipReadOnlyFastPath: skipReadOnlyFastPath,
    );
  }
}

CryptoService _makeCrypto() {
  final c = CryptoService();
  c.initialize();
  return c;
}

const _passphrase = 'CorrectHorseBatteryStaple42!';
const _seedB64 = 'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=';

class _ReauthFakeAuthService extends AuthService {
  _ReauthFakeAuthService({
    required super.crypto,
    required super.db,
    required super.preferences,
    required super.securePreferences,
    required this.mkHexForBiometric,
  });

  String? mkHexForBiometric;
  bool biometricsAvailable = true;
  bool biometricEnabled = true;

  @override
  Future<bool> isBiometricsAvailable() async => biometricsAvailable;

  @override
  bool isBiometricEnabled() => biometricEnabled;

  @override
  Future<bool> unlockWithBiometric() async {
    final mk = mkHexForBiometric;
    if (mk == null) return false;
    crypto.setMasterKey(mk);
    notifyUnlocked();
    return true;
  }
}

/// Seeds a seed vault (and optional biometric MK) for the given crypto/db
/// and returns the fake env bundle used to override providers.
class _FakeEnv {
  final CryptoService crypto;
  final AppDatabase db;
  final AppPreferences prefs;
  final SecurePreferences securePrefs;
  _FakeEnv(this.crypto, this.db, this.prefs, this.securePrefs);
}

Future<_FakeEnv> _seedEnv({
  bool seedVault = true,
}) async {
  final crypto = _makeCrypto();
  final db = AppDatabase.inMemory();
  final prefs = AppPreferences.testInstance();
  final securePrefs = SecurePreferences.testInstance();
  if (seedVault) {
    final pdk = crypto.derivePdk(_passphrase, CryptoService.pdkIterations);
    final encryptedSeed = crypto.encrypt(_seedB64, pdk);
    await db.setSeedVault(encryptedSeed);
  }
  return _FakeEnv(crypto, db, prefs, securePrefs);
}


Future<void> _pumpUnlock(
  WidgetTester tester,
  _SpySyncService spy,
  _FakeEnv env, {
  AuthService? authOverride,
}) async {
  final overrides = <Override>[
    data_providers.cryptoServiceProvider.overrideWith((ref) => env.crypto),
    data_providers.databaseProvider.overrideWith((ref) => env.db),
    data_providers.syncServiceProvider.overrideWith((ref) => spy),
  ];
  if (authOverride != null) {
    overrides.add(
      data_providers.authServiceProvider.overrideWith((ref) => authOverride),
    );
  }
  await pumpScreenWidget(
    tester,
    const UnlockScreen(),
    initialPhase: AppPhase.auth,
    overrides: overrides,
  );
}

Future<void> _doPassphraseUnlock(WidgetTester tester) async {
  await tester.enterText(find.byType(TextField).first, _passphrase);
  await tester.tap(find.text('Unlock').last);
  await tester.runAsync(() async {
    await Future<void>.delayed(const Duration(seconds: 4));
  });
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  group('U1: passphrase unlock triggers a fire-and-forget staging sync', () {
    testWidgets(
        'U1.1: after a successful passphrase unlock, checkAndSync is invoked',
        (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();

      await _pumpUnlock(tester, spy, env);
      await _doPassphraseUnlock(tester);

      expect(env.crypto.hasMasterKey, isTrue,
          reason: 'U1.1 precondition: reauth must cache the master key');
      expect(spy.checkAndSyncCalls, greaterThanOrEqualTo(1),
          reason: 'U1.1: unlock must wire the staging sync entry point');

      await env.db.close();
    });

    testWidgets(
        'U1.2: the post-reauth checkAndSync forwards skipReadOnlyFastPath: true',
        (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();

      await _pumpUnlock(tester, spy, env);
      await _doPassphraseUnlock(tester);

      expect(spy.capturedSkipReadOnlyFastPath, isNotEmpty,
          reason: 'U1.2: unlock must call checkAndSync at least once');
      expect(spy.capturedSkipReadOnlyFastPath.last, isTrue,
          reason: 'U1.2: post-reauth sync must force past F1 so remote rows '
              'are pulled even with empty local staging');

      await env.db.close();
    });

    testWidgets(
        'U1.3: the trigger is fire-and-forget — unlock reaches ready without '
        'gating on the sync result', (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();

      await _pumpUnlock(tester, spy, env);
      await _doPassphraseUnlock(tester);

      expect(env.crypto.hasMasterKey, isTrue,
          reason: 'U1.3: unlock is complete');
      expect(spy.checkAndSyncCalls, greaterThanOrEqualTo(1),
          reason: 'U1.3: the fire-and-forget sync still runs');

      await env.db.close();
    });
  });

  group('U2: biometric unlock parity', () {
    testWidgets(
        'U2.1: after a successful biometric unlock, checkAndSync is invoked',
        (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();
      final fakeAuth = _ReauthFakeAuthService(
        crypto: env.crypto,
        db: env.db,
        preferences: env.prefs,
        securePreferences: env.securePrefs,
        mkHexForBiometric: env.crypto.deriveMasterKey(_seedB64),
      );
      fakeAuth.biometricsAvailable = true;
      fakeAuth.biometricEnabled = true;

      await _pumpUnlock(tester, spy, env, authOverride: fakeAuth);
      // Unlock screen shows the biometric icon (fingerprint) when available.
      expect(find.byIcon(Icons.fingerprint), findsOneWidget,
          reason: 'U2.1: biometric button must be visible');

      await tester.tap(find.byIcon(Icons.fingerprint));
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 300));
      });
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(env.crypto.hasMasterKey, isTrue,
          reason: 'U2.1 precondition: biometric unlock must cache MK');
      expect(spy.checkAndSyncCalls, greaterThanOrEqualTo(1),
          reason: 'U2.1: biometric unlock must also trigger the sync');

      await env.db.close();
    });
  });

  group('U3: fail-safe / non-regression guards', () {
    testWidgets(
        'U3.1: a wrong passphrase does NOT goToReady nor call checkAndSync',
        (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();

      await _pumpUnlock(tester, spy, env);

      await tester.enterText(find.byType(TextField).first, 'DefinitelyNotThePassphrase');
      await tester.tap(find.text('Unlock').last);
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(seconds: 4));
      });
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(env.crypto.hasMasterKey, isFalse,
          reason: 'U3.1: failed auth must NOT cache the master key');
      expect(spy.checkAndSyncCalls, 0,
          reason: 'U3.1: no sync on a rejected passphrase');

      await env.db.close();
    });

    testWidgets(
        'U3.2: no-transport unlock is a local-only no-op that still navigates',
        (tester) async {
      final env = await _seedEnv();
      final spy = _SpySyncService();

      await _pumpUnlock(tester, spy, env);
      await _doPassphraseUnlock(tester);

      // Local-only (no transport): unlock succeeds and no error escapes.
      expect(env.crypto.hasMasterKey, isTrue,
          reason: 'U3.2: unlock succeeds on a local-only device');
      expect(tester.takeException(), isNull,
          reason: 'U3.2: the fire-and-forget sync must not throw on no transport');

      await env.db.close();
    });
  });
}
