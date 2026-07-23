import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/shared/loading_indicator.dart';
import '../features/landing/landing_screen.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../features/auth/unlock_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/history/history_screen.dart';
import '../features/sync/sync_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/shared/app_scaffold.dart';

/// App lifecycle phase — drives routing redirects.
enum AppPhase { boot, landing, onboarding, auth, ready }

/// Central app lifecycle state. Owned by a Riverpod provider.
class AppLifecycleState {
  final AppPhase phase;
  const AppLifecycleState({this.phase = AppPhase.boot});

  AppLifecycleState copyWith({AppPhase? phase}) =>
      AppLifecycleState(phase: phase ?? this.phase);
}

/// The app lifecycle provider — drives navigation.
final appLifecycleProvider =
    StateNotifierProvider<AppLifecycleNotifier, AppLifecycleState>((ref) {
  return AppLifecycleNotifier();
});

class AppLifecycleNotifier extends StateNotifier<AppLifecycleState> {
  AppLifecycleNotifier() : super(const AppLifecycleState());

  void goToLanding() => state = state.copyWith(phase: AppPhase.landing);
  void goToOnboarding() => state = state.copyWith(phase: AppPhase.onboarding);
  void goToAuth() => state = state.copyWith(phase: AppPhase.auth);
  void goToReady() => state = state.copyWith(phase: AppPhase.ready);
}

/// go_router provider — rebuilds when lifecycle phase changes.
final appRouterProvider = Provider<GoRouter>((ref) {
  final lifecycle = ref.watch(appLifecycleProvider);

  return GoRouter(
    initialLocation: '/loading',
    redirect: (context, state) {
      final loc = state.matchedLocation;

      // Boot → stay on loading
      if (lifecycle.phase == AppPhase.boot) {
        if (loc != '/loading') return '/loading';
        return null;
      }

      // Landing → onboarding or auth
      if (lifecycle.phase == AppPhase.landing) {
        if (loc == '/loading') return '/landing';
        return null;
      }

      // Auth → unlock screen
      if (lifecycle.phase == AppPhase.auth) {
        if (loc != '/unlock') return '/unlock';
        return null;
      }

      // Ready → main shell (block auth routes)
      if (lifecycle.phase == AppPhase.ready) {
        if (loc == '/loading' || loc == '/landing' || loc == '/unlock') {
          return '/';
        }
        return null;
      }

      return null;
    },
    routes: [
      GoRoute(
        path: '/loading',
        builder: (_, _) => const LoadingScreen(),
      ),
      GoRoute(
        path: '/landing',
        builder: (_, _) => const LandingScreen(),
      ),
      GoRoute(
        path: '/onboarding',
        builder: (_, _) => const OnboardingScreen(),
      ),
      GoRoute(
        path: '/unlock',
        builder: (_, _) => const UnlockScreen(),
      ),
      ShellRoute(
        builder: (_, _, child) => AppScaffold(child: child),
        routes: [
          GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
          GoRoute(path: '/history', builder: (_, _) => const HistoryScreen()),
          GoRoute(path: '/sync', builder: (_, _) => const SyncScreen()),
          GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
        ],
      ),
    ],
  );
});


