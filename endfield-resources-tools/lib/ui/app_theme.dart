import 'package:flutter/material.dart';

import '../resource_calculator.dart';

abstract final class AppColors {
  static const background = Color(0xFF0D1211);
  static const surface = Color(0xFF151D1A);
  static const raised = Color(0xFF1C2722);
  static const line = Color(0xFF2C3831);
  static const text = Color(0xFFF0F4EE);
  static const muted = Color(0xFFA0AFA5);
  static const accent = Color(0xFFC5F59B);
  static const teal = Color(0xFF82DCD0);
  static const orange = Color(0xFFF0B58A);
  static const purple = Color(0xFFC8B4EF);
  static const error = Color(0xFFFFABA1);

  static Color resource(ResourceKind kind) => switch (kind) {
    ResourceKind.permits => accent,
    ResourceKind.originium => orange,
    ResourceKind.oroberyl => purple,
    ResourceKind.quota => teal,
  };
}

class ResourceIcon extends StatelessWidget {
  const ResourceIcon({
    super.key,
    required this.kind,
    required this.size,
    this.detailed = false,
  });

  final ResourceKind kind;
  final double size;
  final bool detailed;

  @override
  Widget build(BuildContext context) => Image.asset(
    'assets/resources/${kind.name}${detailed ? '' : '_wallet'}.png',
    width: size,
    height: size,
    excludeFromSemantics: true,
  );
}

const numberStyle = TextStyle(
  fontFamily: 'Segoe UI',
  fontFamilyFallback: ['Microsoft YaHei UI'],
  fontFeatures: [FontFeature.tabularFigures()],
  fontWeight: FontWeight.w600,
  letterSpacing: -0.8,
);

String formatNumber(num value, {int decimals = 2}) {
  final fixed = value.toStringAsFixed(decimals);
  final cleaned = fixed.contains('.')
      ? fixed.replaceFirst(RegExp(r'\.?0+$'), '')
      : fixed;
  final parts = (cleaned.isEmpty || cleaned == '-0' ? '0' : cleaned).split('.');
  parts[0] = parts[0].replaceAllMapped(
    RegExp(r'(\d)(?=(\d{3})+(?!\d))'),
    (m) => '${m[1]},',
  );
  return parts.join('.');
}

String signedNumber(num value) =>
    '${value > 0 ? '+' : ''}${formatNumber(value)}';

String formatFixedNumber(num value) {
  final parts = value.toStringAsFixed(2).split('.');
  return '${formatNumber(int.parse(parts.first), decimals: 0)}.${parts.last}';
}

String shortDate(DateTime date) => '${date.month}/${date.day}';
String clockTime(DateTime date) =>
    '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
String displayMoment(DateTime date) =>
    '${displayDate(date)} ${clockTime(date)}';
String displayDate(DateTime date) =>
    '${date.year}.${date.month.toString().padLeft(2, '0')}.'
    '${date.day.toString().padLeft(2, '0')}';

ThemeData appTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.accent,
    brightness: Brightness.dark,
    primary: AppColors.accent,
    onPrimary: const Color(0xFF16230E),
    surface: AppColors.surface,
    onSurface: AppColors.text,
    outline: AppColors.line,
    error: AppColors.error,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.background,
    fontFamily: 'Microsoft YaHei UI',
    fontFamilyFallback: const ['Segoe UI', 'Microsoft YaHei'],
    textTheme: const TextTheme(
      headlineLarge: TextStyle(fontSize: 28, fontWeight: FontWeight.w700),
      headlineSmall: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
      titleLarge: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
      titleMedium: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
      bodyLarge: TextStyle(fontSize: 14, height: 1.6),
      bodyMedium: TextStyle(fontSize: 13, height: 1.55),
      bodySmall: TextStyle(fontSize: 12, height: 1.5, color: AppColors.muted),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.line, space: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(100, 46),
        padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        textStyle: const TextStyle(
          fontFamily: 'Microsoft YaHei UI',
          fontSize: 13,
          fontWeight: FontWeight.w700,
        ),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: AppColors.text,
        side: const BorderSide(color: AppColors.line),
        minimumSize: const Size(48, 44),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: AppColors.muted,
        minimumSize: const Size(44, 44),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.background,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      hintStyle: const TextStyle(color: AppColors.muted),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: AppColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: AppColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: AppColors.accent, width: 1.5),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: AppColors.raised,
      contentTextStyle: const TextStyle(color: AppColors.text),
      actionTextColor: AppColors.accent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ),
    tooltipTheme: const TooltipThemeData(
      waitDuration: Duration(milliseconds: 400),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: WidgetStateProperty.all(
        AppColors.muted.withValues(alpha: .3),
      ),
      radius: const Radius.circular(8),
      thickness: WidgetStateProperty.all(5),
    ),
  );
}

class SurfacePanel extends StatelessWidget {
  const SurfacePanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(22),
    this.color = AppColors.surface,
    this.borderColor = AppColors.line,
  });
  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color color;
  final Color borderColor;

  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(
      color: color,
      border: Border.all(color: borderColor),
      borderRadius: BorderRadius.circular(16),
    ),
    child: child,
  );
}

class StatusTag extends StatelessWidget {
  const StatusTag(this.text, {super.key, this.color = AppColors.accent});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .09),
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: color.withValues(alpha: .18)),
    ),
    child: Text(text, style: TextStyle(color: color, fontSize: 11)),
  );
}
