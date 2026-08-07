import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Mirrors client/src/index.css exactly — same semantic tokens, same RGB
/// values, so the mobile app reads as the same product, not a reskin.
/// Implements ThemeExtension so screens can do
/// `Theme.of(context).extension<AppColors>()!.accent2` for tokens that
/// don't map onto Flutter's built-in ColorScheme slots (e.g. accent2, line).
class AppColors extends ThemeExtension<AppColors> {
  final Color bg, surface, elevated, line, ink, muted, accent, accent2;
  const AppColors({
    required this.bg,
    required this.surface,
    required this.elevated,
    required this.line,
    required this.ink,
    required this.muted,
    required this.accent,
    required this.accent2,
  });

  static const light = AppColors(
    bg: Color(0xFFF7F8FC),
    surface: Color(0xFFFFFFFF),
    elevated: Color(0xFFFFFFFF),
    line: Color(0xFFE6E8F2),
    ink: Color(0xFF1A1D2E),
    muted: Color(0xFF6B7194),
    accent: Color(0xFF6D5EF6),
    accent2: Color(0xFF2DD4BF),
  );

  static const dark = AppColors(
    bg: Color(0xFF0B0E1A),
    surface: Color(0xFF141829),
    elevated: Color(0xFF1C2135),
    line: Color(0xFF262C44),
    ink: Color(0xFFE7E9F5),
    muted: Color(0xFF8A90B0),
    accent: Color(0xFF7C6FFF),
    accent2: Color(0xFF2DD4BF),
  );

  @override
  AppColors copyWith({Color? bg, Color? surface, Color? elevated, Color? line, Color? ink, Color? muted, Color? accent, Color? accent2}) {
    return AppColors(
      bg: bg ?? this.bg,
      surface: surface ?? this.surface,
      elevated: elevated ?? this.elevated,
      line: line ?? this.line,
      ink: ink ?? this.ink,
      muted: muted ?? this.muted,
      accent: accent ?? this.accent,
      accent2: accent2 ?? this.accent2,
    );
  }

  @override
  AppColors lerp(ThemeExtension<AppColors>? other, double t) {
    if (other is! AppColors) return this;
    return AppColors(
      bg: Color.lerp(bg, other.bg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      elevated: Color.lerp(elevated, other.elevated, t)!,
      line: Color.lerp(line, other.line, t)!,
      ink: Color.lerp(ink, other.ink, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accent2: Color.lerp(accent2, other.accent2, t)!,
    );
  }
}

class AppTheme {
  static ThemeData _build(AppColors c, Brightness brightness) {
    final displayFont = GoogleFonts.spaceGrotesk();
    final bodyFont = GoogleFonts.inter();

    return ThemeData(
      brightness: brightness,
      scaffoldBackgroundColor: c.bg,
      fontFamily: bodyFont.fontFamily,
      colorScheme: ColorScheme(
        brightness: brightness,
        primary: c.accent,
        onPrimary: Colors.white,
        secondary: c.accent2,
        onSecondary: Colors.white,
        error: const Color(0xFFEF4444),
        onError: Colors.white,
        surface: c.surface,
        onSurface: c.ink,
      ),
      cardColor: c.surface,
      dividerColor: c.line,
      textTheme: TextTheme(
        displaySmall: displayFont.copyWith(fontSize: 24, fontWeight: FontWeight.w600, color: c.ink),
        titleLarge: displayFont.copyWith(fontSize: 18, fontWeight: FontWeight.w600, color: c.ink),
        titleMedium: displayFont.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink),
        bodyLarge: bodyFont.copyWith(fontSize: 15, color: c.ink),
        bodyMedium: bodyFont.copyWith(fontSize: 14, color: c.ink),
        bodySmall: bodyFont.copyWith(fontSize: 12, color: c.muted),
        labelLarge: bodyFont.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: c.ink),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: c.surface,
        foregroundColor: c.ink,
        elevation: 0,
        titleTextStyle: displayFont.copyWith(fontSize: 17, fontWeight: FontWeight.w600, color: c.ink),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: c.elevated,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: c.line)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: c.line)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: c.accent, width: 1.5)),
        labelStyle: bodyFont.copyWith(color: c.muted),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: c.accent,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(vertical: 15),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: bodyFont.copyWith(fontWeight: FontWeight.w600, fontSize: 15),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: c.ink,
          side: BorderSide(color: c.line),
          padding: const EdgeInsets.symmetric(vertical: 15),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      bottomNavigationBarTheme: BottomNavigationBarThemeData(
        backgroundColor: c.surface,
        selectedItemColor: c.accent,
        unselectedItemColor: c.muted,
        type: BottomNavigationBarType.fixed,
      ),
      extensions: [c],
    );
  }

  static ThemeData get light => _build(AppColors.light, Brightness.light);
  static ThemeData get dark => _build(AppColors.dark, Brightness.dark);
}
