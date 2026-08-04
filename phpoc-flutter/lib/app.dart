import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'data/storage/preferences.dart';
import 'routing/app_router.dart';
import 'theme/app_theme.dart';

/// Provider that reads the persisted theme variant and exposes it
/// so [MaterialApp.router] rebuilds when the user changes themes.
final themeProvider = StateNotifierProvider<ThemeNotifier, ThemeVariant>((ref) {
  return ThemeNotifier();
});

class ThemeNotifier extends StateNotifier<ThemeVariant> {
  ThemeNotifier() : super(ThemeVariant.greenLight) {
    _load();
  }

  Future<void> _load() async {
    final name =
        await AppPreferences.preResolvedInstance!.getThemeMode();
    state = _parse(name);
  }

  Future<void> setVariant(ThemeVariant variant) async {
    await AppPreferences.preResolvedInstance!
        .setThemeMode(variant.name);
    state = variant;
  }

  static ThemeVariant _parse(String name) {
    return ThemeVariant.values.firstWhere(
      (v) => v.name == name,
      orElse: () => ThemeVariant.greenLight,
    );
  }
}

/// Root widget. Watches the app lifecycle phase and shows the correct
/// initial route or a loading screen during boot.
class PhpocApp extends ConsumerWidget {
  const PhpocApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);
    final variant = ref.watch(themeProvider);

    return MaterialApp.router(
      title: 'PH Ledger',
      theme: AppTheme.build(variant),
      themeMode: ThemeMode.light, // single-theme — variant selects palette
      routerConfig: router,
      debugShowCheckedModeBanner: false,
    );
  }
}
