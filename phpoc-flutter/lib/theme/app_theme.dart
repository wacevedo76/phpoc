import 'package:flutter/material.dart';

/// Named theme variants selectable in Settings → Appearance.
enum ThemeVariant {
  greenLight,
  greenDark,
  fusciaLight,
  fusciaDark,
}

class AppTheme {
  AppTheme._();

  /// Brand colors.
  static const _greenPrimary = Color(0xFF1B5E20);
  static const _greenAccent = Color(0xFF4CAF50);
  static const _fusciaPrimary = Color(0xFFC2185B);
  static const _fusciaAccent = Color(0xFFE91E63);
  static const _surface = Color(0xFFF5F5F5);

  /// All available theme variants as a map.
  static const Map<ThemeVariant, String> variants = {
    ThemeVariant.greenLight: 'Green – Light',
    ThemeVariant.greenDark: 'Green – Dark',
    ThemeVariant.fusciaLight: 'Fuscia – Light',
    ThemeVariant.fusciaDark: 'Fuscia – Dark',
  };

  /// Build a [ThemeData] for [variant].
  static ThemeData build(ThemeVariant variant) {
    final isDark = variant == ThemeVariant.greenDark ||
        variant == ThemeVariant.fusciaDark;
    final isFuscia = variant == ThemeVariant.fusciaLight ||
        variant == ThemeVariant.fusciaDark;

    final seed = isFuscia
        ? (isDark ? _fusciaAccent : _fusciaPrimary)
        : (isDark ? _greenAccent : _greenPrimary);

    final fgColor = isFuscia ? _fusciaPrimary : _greenPrimary;

    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: seed,
        brightness: isDark ? Brightness.dark : Brightness.light,
      ),
      scaffoldBackgroundColor: isDark ? null : _surface,
      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
      ),
      cardTheme: CardThemeData(
        elevation: 1,
        shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        hintStyle: TextStyle(
          fontFamily: 'monospace',
          color: isDark ? Colors.grey.shade500 : Colors.grey.shade600,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: fgColor,
          foregroundColor: Colors.white,
          padding:
              const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8)),
        ),
      ),
    );
  }

  // ── Convenience getters for backward compat ──────────────

  static ThemeData get light => build(ThemeVariant.greenLight);
  static ThemeData get dark => build(ThemeVariant.greenDark);
}
