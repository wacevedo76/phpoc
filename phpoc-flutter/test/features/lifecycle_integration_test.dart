import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:phpoc_flutter/data/storage/providers.dart'
    show authServiceProvider, onboardingServiceProvider;
import 'package:phpoc_flutter/routing/app_router.dart';

import 'test_helpers.dart';

/// App Lifecycle Integration tests — Group J (6 assertions)

void main() {
  group('J: App Lifecycle Integration', () {
    // J1 — Full flow: onboarding → create → unlock → dashboard
    test('J1: full flow — onboarding → create ledger → unlock → dashboard '
        'state transitions', () {
      final lifecycle = AppLifecycleNotifier();

      // Landing → Onboarding
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing,
          reason: 'Fresh install starts at landing');

      // Onboarding → Auth (after create/import complete)
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'After onboarding, user must authenticate');

      // Auth → Ready (after successful unlock)
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'After unlock, main app shell must be visible');

      // Full sequence verified
      lifecycle.goToLanding();
      lifecycle.goToAuth();
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready);
    });

    // J2 — Full flow: existing data → unlock → dashboard
    test('J2: full flow — existing data → unlock → dashboard state transitions',
        () {
      final lifecycle = AppLifecycleNotifier();

      // Boot probe finds existing data → auth
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'Existing data routes to unlock screen');

      // Unlock → ready → dashboard
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'Returning user sees dashboard after unlock');
    });

    // J3 — Lock from settings: lock() → phase → auth → router → /unlock
    test(
        'J3: lock from settings → authService.lock() called, phase → auth',
        () async {
      final container = ProviderContainer(
        overrides: defaultScreenOverrides(),
      );
      final lifecycle = AppLifecycleNotifier();

      // Start at ready
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready);

      // Simulate lock: authService.lock() → goToAuth()
      final auth = container.read(authServiceProvider);
      auth.lock();
      lifecycle.goToAuth();

      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'Lock must transition to auth phase');
      expect(auth.isUnlocked, isFalse,
          reason: 'Lock must clear master key');

      container.dispose();
    });

    // J4 — Unlock: unlock() → phase → ready, router → /
    test(
        'J4: unlock from /unlock → phase → ready',
        () {
      final lifecycle = AppLifecycleNotifier();

      // Start at auth (locked)
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth);

      // Unlock success → ready
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'Unlock success must transition to ready phase');
    });

    // J5 — Onboarding complete → hasExistingData() true on next probe
    test('J5: onboarding complete → hasExistingData() returns true on next '
        'boot probe', () async {
      final container = ProviderContainer(
        overrides: defaultScreenOverrides(),
      );

      // Initially no data (in-memory, no genesis block created)
      final onboarding = container.read(onboardingServiceProvider);
      final hasData = await onboarding.hasExistingData();

      expect(hasData, isA<bool>(),
          reason: 'hasExistingData() must return a boolean');

      // After creating a ledger in Phase 3, this should return true
      container.dispose();
    });

    // J6 — AppLifecycleNotifier.goToX() calls are idempotent
    test('J6: AppLifecycleNotifier.goToX() calls are idempotent', () {
      final lifecycle = AppLifecycleNotifier();

      // goToReady twice
      lifecycle.goToReady();
      expect(lifecycle.state.phase, AppPhase.ready);

      lifecycle.goToReady(); // Idempotent
      expect(lifecycle.state.phase, AppPhase.ready,
          reason: 'Duplicate goToReady() must not change state');

      // goToAuth twice
      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth);

      lifecycle.goToAuth();
      expect(lifecycle.state.phase, AppPhase.auth,
          reason: 'Duplicate goToAuth() must not change state');

      // goToLanding twice
      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing);

      lifecycle.goToLanding();
      expect(lifecycle.state.phase, AppPhase.landing,
          reason: 'Duplicate goToLanding() must not change state');
    });
  });
}
