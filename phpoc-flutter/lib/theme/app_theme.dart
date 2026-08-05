import 'package:flutter/material.dart';

/// Named theme variants selectable in Settings → Appearance.
enum ThemeVariant {
  greenLight,
  greenDark,
  fuchsiaCyan,
  fuchsiaGold,
  fuchsiaGreen,
  fuchsiaPurple,
  catppuccinLatte,
  catppuccinFrappe,
  catppuccinMacchiato,
  catppuccinMocha,
}

class AppTheme {
  AppTheme._();

  // ── Green constants ────────────────────────────────────────
  static const _greenPrimary = Color(0xFF1B5E20);
  static const _greenAccent = Color(0xFF4CAF50);
  static const _surface = Color(0xFFF5F5F5);

  // ── Fuchsia base (shared across all Fuchsia variants) ─────
  static const _fBg = Color(0xFFD812C5);
  static const _fSurface = Color(0xFF370432);
  static const _fSurfaceVariant = Color(0xFF540C4D);
  static const _fOnSurface = Color(0xFFE8EAED);
  static const _fTextSecondary = Color(0xFF9AA0A6);
  static const _fTextMuted = Color(0xFF5F6368);
  static const _fError = Color(0xFFEA4335);

  // ── Fuchsia Cyan ───────────────────────────────────────────
  static const _fCyanPrimary = Color(0xFF4DD0E1);
  static const _fCyanPrimaryContainer = Color(0xFF006064);
  static const _fCyanOnPrimaryContainer = Color(0xFFB2EBF2);
  static const _fCyanSuccess = Color(0xFF26C6DA);
  static const _fCyanInfo = Color(0xFF80DEEA);
  static const _fCyanOutline = Color(0xFF7B1FA2);

  // ── Fuchsia Gold ───────────────────────────────────────────
  static const _fGoldPrimary = Color(0xFFFFD54F);
  static const _fGoldPrimaryContainer = Color(0xFFF9A825);
  static const _fGoldOnPrimaryContainer = Color(0xFF370432);
  static const _fGoldSuccess = Color(0xFF69F0AE);
  static const _fGoldInfo = Color(0xFFE040FB);
  static const _fGoldOutline = Color(0xFF7B1FA2);

  // ── Fuchsia Green ──────────────────────────────────────────
  static const _fGreenPrimary = Color(0xFF4CAF50);
  static const _fGreenPrimaryContainer = Color(0xFF1B5E20);
  static const _fGreenOnPrimaryContainer = Color(0xFFA5D6A7);
  static const _fGreenSuccess = Color(0xFF34A853);
  static const _fGreenInfo = Color(0xFF4285F4);
  static const _fGreenOutline = Color(0xFF2D3140);

  // ── Fuchsia Purple ─────────────────────────────────────────
  static const _fPurplePrimary = Color(0xFFE040FB);
  static const _fPurplePrimaryContainer = Color(0xFF6A1B9A);
  static const _fPurpleOnPrimaryContainer = Color(0xFFF3E5F5);
  static const _fPurpleSuccess = Color(0xFFB2FF59);
  static const _fPurpleInfo = Color(0xFFCE93D8);
  static const _fPurpleOutline = Color(0xFF6A1B9A);

  // ── Catppuccin Latte ───────────────────────────────────────
  static const _clBase = Color(0xFFEFF1F5);
  static const _clSurface0 = Color(0xFFCCD0DA);
  static const _clSurface1 = Color(0xFFBCC0CC);
  static const _clSurface2 = Color(0xFFACB0BE);
  static const _clText = Color(0xFF4C4F69);
  static const _clSubtext1 = Color(0xFF5C5F77);
  static const _clSubtext0 = Color(0xFF6C6F85);
  static const _clMauve = Color(0xFF8839EF);
  static const _clMauveDark = Color(0xFF421D73);
  static const _clGreen = Color(0xFF40A02B);
  static const _clYellow = Color(0xFFDF8E1D);
  static const _clRed = Color(0xFFD20F39);
  static const _clBlue = Color(0xFF1E66F5);
  static const _clPink = Color(0xFFEA76CB);

  // ── Catppuccin Frappé ──────────────────────────────────────
  static const _cfBase = Color(0xFF303446);
  static const _cfSurface0 = Color(0xFF414559);
  static const _cfSurface1 = Color(0xFF51576D);
  static const _cfSurface2 = Color(0xFF626880);
  static const _cfText = Color(0xFFC6D0F5);
  static const _cfSubtext1 = Color(0xFFB5BFE2);
  static const _cfSubtext0 = Color(0xFFA5ADCE);
  static const _cfMauve = Color(0xFFCA9EE6);
  static const _cfMauveDark = Color(0xFF473750);
  static const _cfGreen = Color(0xFFA6D189);
  static const _cfYellow = Color(0xFFE5C890);
  static const _cfRed = Color(0xFFE78284);
  static const _cfBlue = Color(0xFF8CAAEE);
  static const _cfPink = Color(0xFFF4B8E4);

  // ── Catppuccin Macchiato ───────────────────────────────────
  static const _cmBase = Color(0xFF24273A);
  static const _cmSurface0 = Color(0xFF363A4F);
  static const _cmSurface1 = Color(0xFF494D64);
  static const _cmSurface2 = Color(0xFF5B6078);
  static const _cmText = Color(0xFFCAD3F5);
  static const _cmSubtext1 = Color(0xFFB8C0E0);
  static const _cmSubtext0 = Color(0xFFA5ADCB);
  static const _cmMauve = Color(0xFFC6A0F6);
  static const _cmMauveDark = Color(0xFF453856);
  static const _cmGreen = Color(0xFFA6DA95);
  static const _cmYellow = Color(0xFFEED49F);
  static const _cmRed = Color(0xFFED8796);
  static const _cmBlue = Color(0xFF8AADF4);
  static const _cmPink = Color(0xFFF5BDE6);

  // ── Catppuccin Mocha ───────────────────────────────────────
  static const _ckBase = Color(0xFF1E1E2E);
  static const _ckSurface0 = Color(0xFF313244);
  static const _ckSurface1 = Color(0xFF45475A);
  static const _ckSurface2 = Color(0xFF585B70);
  static const _ckText = Color(0xFFCDD6F4);
  static const _ckSubtext1 = Color(0xFFBAC2DE);
  static const _ckSubtext0 = Color(0xFFA6ADC8);
  static const _ckMauve = Color(0xFFCBA6F7);
  static const _ckMauveDark = Color(0xFF373050);
  static const _ckGreen = Color(0xFFA6E3A1);
  static const _ckYellow = Color(0xFFF9E2AF);
  static const _ckRed = Color(0xFFF38BA8);
  static const _ckBlue = Color(0xFF89B4FA);
  static const _ckPink = Color(0xFFF5C2E7);

  /// All available theme variants as a map.
  static const Map<ThemeVariant, String> variants = {
    ThemeVariant.greenLight: 'Green – Light',
    ThemeVariant.greenDark: 'Green – Dark',
    ThemeVariant.fuchsiaCyan: 'Fuchsia – Cyan',
    ThemeVariant.fuchsiaGold: 'Fuchsia – Gold',
    ThemeVariant.fuchsiaGreen: 'Fuchsia – Green',
    ThemeVariant.fuchsiaPurple: 'Fuchsia – Purple',
    ThemeVariant.catppuccinLatte: 'Catppuccin Latte',
    ThemeVariant.catppuccinFrappe: 'Catppuccin Frappé',
    ThemeVariant.catppuccinMacchiato: 'Catppuccin Macchiato',
    ThemeVariant.catppuccinMocha: 'Catppuccin Mocha',
  };

  /// Build a [ThemeData] for [variant].
  static ThemeData build(ThemeVariant variant) {
    switch (variant) {
      case ThemeVariant.greenLight:
        return _buildGreen(light: true);
      case ThemeVariant.greenDark:
        return _buildGreen(light: false);
      case ThemeVariant.fuchsiaCyan:
        return _buildFuchsia(
          primary: _fCyanPrimary,
          primaryContainer: _fCyanPrimaryContainer,
          onPrimaryContainer: _fCyanOnPrimaryContainer,
          success: _fCyanSuccess,
          info: _fCyanInfo,
          outline: _fCyanOutline,
        );
      case ThemeVariant.fuchsiaGold:
        return _buildFuchsia(
          primary: _fGoldPrimary,
          primaryContainer: _fGoldPrimaryContainer,
          onPrimaryContainer: _fGoldOnPrimaryContainer,
          success: _fGoldSuccess,
          info: _fGoldInfo,
          outline: _fGoldOutline,
        );
      case ThemeVariant.fuchsiaGreen:
        return _buildFuchsia(
          primary: _fGreenPrimary,
          primaryContainer: _fGreenPrimaryContainer,
          onPrimaryContainer: _fGreenOnPrimaryContainer,
          success: _fGreenSuccess,
          info: _fGreenInfo,
          outline: _fGreenOutline,
        );
      case ThemeVariant.fuchsiaPurple:
        return _buildFuchsia(
          primary: _fPurplePrimary,
          primaryContainer: _fPurplePrimaryContainer,
          onPrimaryContainer: _fPurpleOnPrimaryContainer,
          success: _fPurpleSuccess,
          info: _fPurpleInfo,
          outline: _fPurpleOutline,
        );
      case ThemeVariant.catppuccinLatte:
        return _buildCatppuccin(
          brightness: Brightness.light,
          base: _clBase,
          surface0: _clSurface0,
          surface1: _clSurface1,
          surface2: _clSurface2,
          text: _clText,
          subtext1: _clSubtext1,
          subtext0: _clSubtext0,
          mauve: _clMauve,
          mauveDark: _clMauveDark,
          green: _clGreen,
          yellow: _clYellow,
          red: _clRed,
          blue: _clBlue,
          pink: _clPink,
        );
      case ThemeVariant.catppuccinFrappe:
        return _buildCatppuccin(
          brightness: Brightness.dark,
          base: _cfBase,
          surface0: _cfSurface0,
          surface1: _cfSurface1,
          surface2: _cfSurface2,
          text: _cfText,
          subtext1: _cfSubtext1,
          subtext0: _cfSubtext0,
          mauve: _cfMauve,
          mauveDark: _cfMauveDark,
          green: _cfGreen,
          yellow: _cfYellow,
          red: _cfRed,
          blue: _cfBlue,
          pink: _cfPink,
        );
      case ThemeVariant.catppuccinMacchiato:
        return _buildCatppuccin(
          brightness: Brightness.dark,
          base: _cmBase,
          surface0: _cmSurface0,
          surface1: _cmSurface1,
          surface2: _cmSurface2,
          text: _cmText,
          subtext1: _cmSubtext1,
          subtext0: _cmSubtext0,
          mauve: _cmMauve,
          mauveDark: _cmMauveDark,
          green: _cmGreen,
          yellow: _cmYellow,
          red: _cmRed,
          blue: _cmBlue,
          pink: _cmPink,
        );
      case ThemeVariant.catppuccinMocha:
        return _buildCatppuccin(
          brightness: Brightness.dark,
          base: _ckBase,
          surface0: _ckSurface0,
          surface1: _ckSurface1,
          surface2: _ckSurface2,
          text: _ckText,
          subtext1: _ckSubtext1,
          subtext0: _ckSubtext0,
          mauve: _ckMauve,
          mauveDark: _ckMauveDark,
          green: _ckGreen,
          yellow: _ckYellow,
          red: _ckRed,
          blue: _ckBlue,
          pink: _ckPink,
        );
    }
  }

  // ── Green builder ──────────────────────────────────────────

  static ThemeData _buildGreen({required bool light}) {
    final seed = light ? _greenPrimary : _greenAccent;
    final fgColor = _greenPrimary;

    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(
        seedColor: seed,
        brightness: light ? Brightness.light : Brightness.dark,
      ),
      scaffoldBackgroundColor: light ? _surface : null,
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
          color: light ? Colors.grey.shade600 : Colors.grey.shade500,
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

  // ── Fuchsia builder (shared across all 4 variants) ─────────

  static ThemeData _buildFuchsia({
    required Color primary,
    required Color primaryContainer,
    required Color onPrimaryContainer,
    required Color success,
    required Color info,
    required Color outline,
  }) {
    final buttonFg = primary == _fGoldPrimary ||
            primary == _fCyanPrimary
        ? _fSurface
        : Colors.white;

    final colorScheme = ColorScheme(
      brightness: Brightness.dark,
      primary: primary,
      onPrimary: buttonFg,
      primaryContainer: primaryContainer,
      onPrimaryContainer: onPrimaryContainer,
      secondary: _fBg,
      onSecondary: Colors.white,
      secondaryContainer: _fSurfaceVariant,
      onSecondaryContainer: _fOnSurface,
      tertiary: _fBg,
      onTertiary: Colors.white,
      error: _fError,
      onError: Colors.white,
      surface: _fSurface,
      onSurface: _fOnSurface,
      surfaceContainerHighest: _fSurfaceVariant,
      onSurfaceVariant: _fTextSecondary,
      outline: outline,
      outlineVariant: outline,
      shadow: Colors.black,
      scrim: Colors.black,
      inverseSurface: _fOnSurface,
      onInverseSurface: _fSurface,
      inversePrimary: primaryContainer,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: _fBg,
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
        hintStyle: const TextStyle(
          fontFamily: 'monospace',
          color: _fTextMuted,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: primaryContainer,
          foregroundColor: buttonFg,
          padding:
              const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8)),
        ),
      ),
    );
  }

  // ── Catppuccin builder (shared across all 4 flavors) ───────

  static ThemeData _buildCatppuccin({
    required Brightness brightness,
    required Color base,
    required Color surface0,
    required Color surface1,
    required Color surface2,
    required Color text,
    required Color subtext1,
    required Color subtext0,
    required Color mauve,
    required Color mauveDark,
    required Color green,
    required Color yellow,
    required Color red,
    required Color blue,
    required Color pink,
  }) {
    final isLight = brightness == Brightness.light;
    final onPrimary = isLight ? Colors.white : base;
    final buttonFg = isLight ? Colors.white : base;

    final colorScheme = ColorScheme(
      brightness: brightness,
      primary: mauve,
      onPrimary: onPrimary,
      primaryContainer: mauveDark,
      onPrimaryContainer: text,
      secondary: blue,
      onSecondary: onPrimary,
      secondaryContainer: surface1,
      onSecondaryContainer: text,
      tertiary: pink,
      onTertiary: onPrimary,
      error: red,
      onError: onPrimary,
      surface: surface0,
      onSurface: text,
      surfaceContainerHighest: surface1,
      onSurfaceVariant: subtext1,
      outline: surface2,
      outlineVariant: surface2,
      shadow: Colors.black,
      scrim: Colors.black,
      inverseSurface: text,
      onInverseSurface: surface0,
      inversePrimary: mauveDark,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: base,
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
          color: subtext0,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: mauve,
          foregroundColor: buttonFg,
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
