import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../resource_calculator.dart';
import '../resource_history.dart';
import 'app_theme.dart';

class TrendPanel extends StatefulWidget {
  const TrendPanel({super.key, required this.ledger, required this.today});
  final ResourceLedger ledger;
  final DateTime today;

  @override
  State<TrendPanel> createState() => _TrendPanelState();
}

class _TrendPanelState extends State<TrendPanel> {
  ResourceKind _kind = ResourceKind.oroberyl;
  TrendMode _mode = TrendMode.change;
  int _range = 30;
  int? _selected;

  @override
  Widget build(BuildContext context) {
    final points = buildTrend(
      widget.ledger,
      _kind,
      _mode,
      today: widget.today,
      rangeDays: _range,
    );
    final selected = points.isEmpty
        ? null
        : points[(_selected ?? points.length - 1).clamp(0, points.length - 1)];
    final accent = AppColors.resource(_kind);

    return SurfacePanel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 16,
            runSpacing: 12,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(
                    Icons.insights_rounded,
                    size: 20,
                    color: AppColors.accent,
                  ),
                  const SizedBox(width: 10),
                  Text('资源波动', style: Theme.of(context).textTheme.titleLarge),
                ],
              ),
              SegmentedButton<int>(
                segments: const [
                  ButtonSegment(value: 7, label: Text('7 天')),
                  ButtonSegment(value: 30, label: Text('30 天')),
                  ButtonSegment(value: 0, label: Text('全部')),
                ],
                selected: {_range},
                showSelectedIcon: false,
                style: const ButtonStyle(
                  visualDensity: VisualDensity.compact,
                  textStyle: WidgetStatePropertyAll(
                    TextStyle(fontFamily: 'Microsoft YaHei UI', fontSize: 11),
                  ),
                ),
                onSelectionChanged: (values) => setState(() {
                  _range = values.first;
                  _selected = null;
                }),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 7,
            runSpacing: 7,
            children: [
              for (final kind in ResourceKind.values)
                ChoiceChip(
                  key: ValueKey('chart-${kind.name}'),
                  label: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ResourceIcon(kind: kind, size: 16),
                      const SizedBox(width: 4),
                      Text(kind.shortLabel),
                    ],
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  labelPadding: const EdgeInsets.symmetric(horizontal: 4),
                  selected: kind == _kind,
                  showCheckmark: false,
                  labelStyle: TextStyle(
                    fontSize: 11,
                    color: kind == _kind
                        ? AppColors.resource(kind)
                        : AppColors.muted,
                  ),
                  selectedColor: AppColors.resource(
                    kind,
                  ).withValues(alpha: .15),
                  side: const BorderSide(color: AppColors.line),
                  onSelected: (_) => setState(() {
                    _kind = kind;
                    _selected = null;
                  }),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 14,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final mode in TrendMode.values)
                TextButton(
                  key: ValueKey('mode-${mode.name}'),
                  onPressed: () => setState(() {
                    _mode = mode;
                    _selected = null;
                  }),
                  style: TextButton.styleFrom(
                    foregroundColor: _mode == mode
                        ? AppColors.text
                        : AppColors.muted,
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    textStyle: TextStyle(
                      fontFamily: 'Microsoft YaHei UI',
                      fontSize: 12,
                      fontWeight: _mode == mode
                          ? FontWeight.w700
                          : FontWeight.w400,
                    ),
                  ),
                  child: Text(mode == TrendMode.change ? '区间净变化' : '余额走势'),
                ),
              Text(
                '单位：${_kind.unit}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
          if (points.isEmpty)
            SizedBox(
              height: 220,
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(15),
                      decoration: const BoxDecoration(
                        color: AppColors.raised,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.show_chart_rounded,
                        color: AppColors.muted,
                        size: 28,
                      ),
                    ),
                    const SizedBox(height: 15),
                    Text(
                      _mode == TrendMode.change
                          ? '当前范围内至少需要两个游戏日的有效记录'
                          : '这个时间范围还没有记录',
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        color: AppColors.muted,
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 5),
                    const Text(
                      '无需每天记录，按实际间隔计算',
                      style: TextStyle(color: AppColors.muted, fontSize: 11),
                    ),
                  ],
                ),
              ),
            )
          else ...[
            if (_mode == TrendMode.change) ...[
              _averageSummary(points, accent),
              const SizedBox(height: 8),
            ],
            SizedBox(
              height: 195,
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final geometry = ChartGeometry(
                    points,
                    _mode,
                    Size(constraints.maxWidth, 195),
                  );
                  void selectAt(Offset position) {
                    final index = geometry.indexAtX(position.dx);
                    if (_selected != index) {
                      setState(() => _selected = index);
                    }
                  }

                  return Semantics(
                    label:
                        '${_kind.label}${_mode == TrendMode.change ? '净变化' : '余额'}图，${points.length}个已确认数据点',
                    child: MouseRegion(
                      onHover: (event) => selectAt(event.localPosition),
                      child: GestureDetector(
                        onTapDown: (details) => selectAt(details.localPosition),
                        child: CustomPaint(
                          key: const ValueKey('resource-trend-chart'),
                          size: Size(constraints.maxWidth, 195),
                          painter: ResourceChartPainter(
                            geometry: geometry,
                            accent: accent,
                            selectedIndex: (_selected ?? points.length - 1)
                                .clamp(0, points.length - 1),
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.background,
                borderRadius: BorderRadius.circular(9),
              ),
              child: Wrap(
                spacing: 14,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    selected!.previousDate == null
                        ? displayDate(selected.date)
                        : '${shortDate(selected.previousDate!)} → ${shortDate(selected.date)} · ${selected.intervalDays} 天',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.muted,
                    ),
                  ),
                  Text(
                    '${_mode == TrendMode.change ? signedNumber(selected.value) : formatNumber(selected.value)} ${_kind.unit}',
                    style: numberStyle.copyWith(
                      fontSize: 16,
                      color: selected.value < 0 ? AppColors.orange : accent,
                    ),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          const Text(
            '每天 04:00 切换游戏日，每日取最后一条有效记录。净变化包含获取与消耗，漏记不补值。',
            style: TextStyle(fontSize: 11, height: 1.6, color: AppColors.muted),
          ),
        ],
      ),
    );
  }

  Widget _averageSummary(List<TrendPoint> points, Color accent) {
    final start = points.first.previousDate!;
    final end = points.last.date;
    final days = daysBetween(start, end);
    final netChange = points.fold<int>(
      0,
      (total, point) => total + point.value,
    );
    final average = netChange / days;
    const muted = TextStyle(fontSize: 11, color: AppColors.muted);
    return Wrap(
      spacing: 10,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        const Text('日均净变化', style: muted),
        Text(
          '${signedNumber(average)} ${_kind.unit}/天',
          style: numberStyle.copyWith(
            fontSize: 14,
            color: average < 0 ? AppColors.orange : accent,
          ),
        ),
        Text('${shortDate(start)} → ${shortDate(end)} · $days 天', style: muted),
      ],
    );
  }
}

class ChartGeometry {
  ChartGeometry(this.points, this.mode, this.size) {
    final values = points.map((point) => point.value);
    minimum = math.min(0, values.reduce(math.min)).toDouble();
    maximum = math.max(0, values.reduce(math.max)).toDouble();
    if (minimum == maximum) maximum = minimum + 1;
    final margin = (maximum - minimum) * .12;
    if (minimum < 0) minimum -= margin;
    if (maximum > 0) maximum += margin;
    firstDate = mode == TrendMode.change
        ? points.first.previousDate!
        : points.first.date;
    lastDate = points.last.date;
  }
  final List<TrendPoint> points;
  final TrendMode mode;
  final Size size;
  late double minimum;
  late double maximum;
  late final DateTime firstDate;
  late final DateTime lastDate;
  Rect get plot => Rect.fromLTRB(57, 12, size.width - 16, size.height - 28);
  double x(DateTime date) {
    final span = daysBetween(firstDate, lastDate);
    if (span == 0) return plot.center.dx;
    return plot.left + daysBetween(firstDate, date) / span * plot.width;
  }

  double y(num value) =>
      plot.bottom - (value - minimum) / (maximum - minimum) * plot.height;

  int indexAtX(double position) {
    if (mode == TrendMode.change) {
      // Bars occupy date intervals. The next bar begins at this bar's end date.
      final index = points.indexWhere((point) => position < x(point.date));
      return index == -1 ? points.length - 1 : index;
    }
    var nearest = 0;
    var distance = double.infinity;
    for (var i = 0; i < points.length; i++) {
      final next = (x(points[i].date) - position).abs();
      if (next < distance) {
        nearest = i;
        distance = next;
      }
    }
    return nearest;
  }

  Rect barRect(TrendPoint point) {
    final start = x(point.previousDate!);
    final end = x(point.date);
    final inset = math.min(4.0, (end - start) / 4);
    final zero = y(0);
    final value = y(point.value);
    final top = math.min(zero, value);
    return Rect.fromLTRB(
      start + inset,
      top,
      end - inset,
      math.max(top + 2, math.max(zero, value)),
    );
  }
}

class ResourceChartPainter extends CustomPainter {
  ResourceChartPainter({
    required this.geometry,
    required this.accent,
    required this.selectedIndex,
  });
  final ChartGeometry geometry;
  final Color accent;
  final int selectedIndex;

  void label(
    Canvas canvas,
    String text,
    Offset position, {
    bool centered = false,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: const TextStyle(
          fontFamily: 'Segoe UI',
          fontSize: 10,
          color: AppColors.muted,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(
      canvas,
      position - Offset(centered ? painter.width / 2 : painter.width, 0),
    );
  }

  String compact(num value) {
    if (value.abs() >= 1000000) {
      return '${formatNumber(value / 1000000, decimals: 1)}M';
    }
    if (value.abs() >= 10000) {
      return '${formatNumber(value / 1000, decimals: 1)}k';
    }
    return formatNumber(value, decimals: 0);
  }

  void dashed(Canvas canvas, Offset start, Offset end, Paint paint) {
    final vector = end - start;
    final length = vector.distance;
    if (length == 0) return;
    for (double distance = 0; distance < length; distance += 9) {
      canvas.drawLine(
        start + vector * (distance / length),
        start + vector * (math.min(distance + 4, length) / length),
        paint,
      );
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final g = geometry;
    final grid = Paint()
      ..color = AppColors.line
      ..strokeWidth = 1;
    for (var i = 0; i <= 3; i++) {
      final value = g.minimum + (g.maximum - g.minimum) * i / 3;
      final y = g.y(value);
      dashed(canvas, Offset(g.plot.left, y), Offset(g.plot.right, y), grid);
      label(canvas, compact(value), Offset(g.plot.left - 9, y - 6));
    }
    canvas.drawLine(
      Offset(g.plot.left, g.y(0)),
      Offset(g.plot.right, g.y(0)),
      grid,
    );
    final selected = g.points[selectedIndex];
    final guideX = g.mode == TrendMode.change
        ? g.barRect(selected).center.dx
        : g.x(selected.date);
    dashed(
      canvas,
      Offset(guideX, g.plot.top),
      Offset(guideX, g.plot.bottom),
      Paint()..color = AppColors.muted.withValues(alpha: .35),
    );

    if (g.mode == TrendMode.change) {
      for (var i = 0; i < g.points.length; i++) {
        final point = g.points[i];
        canvas.drawRRect(
          RRect.fromRectAndRadius(g.barRect(point), const Radius.circular(4)),
          Paint()
            ..color = (point.value < 0 ? AppColors.orange : accent).withValues(
              alpha: i == selectedIndex ? .95 : .5,
            ),
        );
      }
    } else {
      if (g.points.length > 1) {
        final area = Path()..moveTo(g.x(g.points.first.date), g.y(0));
        for (final point in g.points) {
          area.lineTo(g.x(point.date), g.y(point.value));
        }
        area
          ..lineTo(g.x(g.points.last.date), g.y(0))
          ..close();
        canvas.drawPath(
          area,
          Paint()
            ..shader = LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [
                accent.withValues(alpha: .17),
                accent.withValues(alpha: .01),
              ],
            ).createShader(g.plot),
        );
        for (var i = 1; i < g.points.length; i++) {
          final a = g.points[i - 1];
          final b = g.points[i];
          final paint = Paint()
            ..color = accent
            ..strokeWidth = 2;
          final start = Offset(g.x(a.date), g.y(a.value));
          final end = Offset(g.x(b.date), g.y(b.value));
          if (daysBetween(a.date, b.date) > 1) {
            dashed(canvas, start, end, paint);
          } else {
            canvas.drawLine(start, end, paint);
          }
        }
      }
      for (var i = 0; i < g.points.length; i++) {
        final point = g.points[i];
        final center = Offset(g.x(point.date), g.y(point.value));
        if (i == selectedIndex) {
          canvas.drawCircle(
            center,
            8,
            Paint()..color = accent.withValues(alpha: .16),
          );
        }
        canvas.drawCircle(
          center,
          i == selectedIndex ? 4 : 3,
          Paint()..color = accent,
        );
      }
    }

    final labelCount = math.min(5, math.max(2, (g.plot.width / 100).floor()));
    final days = daysBetween(g.firstDate, g.lastDate);
    final shown = <String>{};
    for (var i = 0; i < labelCount; i++) {
      final date = g.firstDate.add(
        Duration(days: (days * i / (labelCount - 1)).round()),
      );
      if (shown.add(dateKey(date))) {
        label(
          canvas,
          shortDate(date),
          Offset(g.x(date), g.plot.bottom + 10),
          centered: true,
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant ResourceChartPainter oldDelegate) => true;
}
