import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'data/storage/preferences.dart';
import 'data/storage/providers.dart' show periodicSyncCoordinatorProvider;
import 'features/shared/book_switcher.dart' show Book, bookProvider;
import 'routing/app_router.dart';
import 'theme/app_theme.dart';

/// Scroll behavior that accepts mouse (wheel) and trackpad input in addition
/// to touch. Flutter's default Android [ScrollBehavior] only recognizes
/// touch-like devices, so wheel-scrolling on the desktop emulator does
/// nothing. This makes lists scroll with the mouse wheel during development
/// and on desktop targets without affecting phone touch scrolling.
class AppScrollBehavior extends MaterialScrollBehavior {
  const AppScrollBehavior();

  @override
  Set<PointerDeviceKind> get dragDevices => {
        ...super.dragDevices,
        PointerDeviceKind.mouse,
      };
}

/// Base notifier for a persisted [ThemeVariant]. The Ledger and Commonplace
/// themes share the same load/set/parse behaviour (ADR-031 per-book theme);
/// only the storage getter/setter differ, so the two concrete notifiers just
/// supply their own read/write targets.
abstract class ThemeVariantNotifier extends StateNotifier<ThemeVariant> {
  ThemeVariantNotifier() : super(ThemeVariant.greenLight) {
    _load();
  }

  AppPreferences get _prefs =>
      AppPreferences.preResolvedInstance ?? AppPreferences.testInstance();

  /// Persisted variant name for THIS notifier's book.
  Future<String> _read();

  /// Persist the variant name for THIS notifier's book.
  Future<void> _write(String name);

  Future<void> _load() async {
    state = _parse(await _read());
  }

  Future<void> setVariant(ThemeVariant variant) async {
    await _write(variant.name);
    state = variant;
  }

  static ThemeVariant _parse(String name) {
    return ThemeVariant.values.firstWhere(
      (v) => v.name == name,
      orElse: () => ThemeVariant.greenLight,
    );
  }
}

/// Provider that reads the persisted Ledger theme variant and exposes it
/// so [MaterialApp.router] rebuilds when the user changes themes.
final themeProvider = StateNotifierProvider<ThemeNotifier, ThemeVariant>((ref) {
  return ThemeNotifier();
});

class ThemeNotifier extends ThemeVariantNotifier {
  @override
  Future<String> _read() => _prefs.getThemeMode();

  @override
  Future<void> _write(String name) => _prefs.setThemeMode(name);
}

/// Provider that reads the persisted Commonplace Book theme variant (ADR-031
/// per-book theme, stored under `commonplace_theme_mode`). Falls back to the
/// Ledger theme on first run (CPS-T6) via [AppPreferences.getCommonplaceThemeMode].
final commonplaceThemeProvider =
    StateNotifierProvider<CommonplaceThemeNotifier, ThemeVariant>((ref) {
      return CommonplaceThemeNotifier();
    });

class CommonplaceThemeNotifier extends ThemeVariantNotifier {
  @override
  Future<String> _read() => _prefs.getCommonplaceThemeMode();

  @override
  Future<void> _write(String name) => _prefs.setCommonplaceThemeMode(name);
}

/// Root widget. Watches the app lifecycle phase and shows the correct
/// initial route or a loading screen during boot.
class PhpocApp extends ConsumerWidget {
  const PhpocApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    // Resolve the theme variant for the ACTIVE book (ADR-031 per-book theme):
    // the Commonplace Book uses `commonplace_theme_mode`, the Ledger uses
    // `theme_mode`. Watching both + the active book makes the whole app
    // re-render with the right palette when either the book or its theme
    // changes (CPS-T4/T5).
    final book = ref.watch(bookProvider);
    final ledgerVariant = ref.watch(themeProvider);
    final commonplaceVariant = ref.watch(commonplaceThemeProvider);
    final variant = book == Book.commonplace
        ? commonplaceVariant
        : ledgerVariant;
    // Keep the periodic sync coordinator alive for the app lifetime. Watching
    // it here (while it self-observes the app lifecycle) means exactly one
    // coordinator exists, started/stopped by the AppPhase `ready` transitions
    // triggered in unlock/import (via AppLifecycleNotifier.goToReady).
    ref.watch(periodicSyncCoordinatorProvider);

    return MaterialApp.router(
      title: 'PH Ledger',
      theme: AppTheme.build(variant),
      themeMode: ThemeMode.light, // single-theme — variant selects palette
      scrollBehavior: const AppScrollBehavior(),
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}
