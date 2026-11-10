import 'dart:ui' show PointerDeviceKind;

import 'package:endfield_resources_tools/main.dart';
import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/resource_history.dart';
import 'package:endfield_resources_tools/resource_store.dart';
import 'package:endfield_resources_tools/ui/app_theme.dart';
import 'package:endfield_resources_tools/ui/trend_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

final today = DateTime(2026, 10, 30, 21);

Future<void> launch(
  WidgetTester tester,
  ResourceStore store, {
  Size size = const Size(1360, 1100),
  DateTime Function()? now,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(
    EndfieldResourceApp(store: store, now: now ?? () => today),
  );
  await tester.pumpAndSettle();
}

String total(WidgetTester tester, String name) => tester
    .widget<Text>(find.byKey(ValueKey('$name-total')))
    .textSpan!
    .toPlainText();

Future<void> enter(WidgetTester tester, ResourceKind kind, String value) async {
  await tester.enterText(find.byKey(ValueKey('amount-${kind.name}')), value);
  await tester.pump();
}

Future<void> save(WidgetTester tester) async {
  final button = find.byKey(const ValueKey('save-record'));
  await tester.ensureVisible(button);
  await tester.tap(button);
  await tester.pumpAndSettle();
}

ResourceRecord record(int day, int amount, {int hour = 20}) => ResourceRecord(
  date: DateTime(2026, 10, day),
  savedAt: DateTime(2026, 10, day, hour),
  inventory: ResourceInventory(oroberyl: amount),
);

class FailingStore extends MemoryResourceStore {
  @override
  Future<void> save(ResourceLedger ledger) async => throw StateError('测试写入失败');
}

void main() {
  testWidgets('character and arsenal well estimates use their own rates', (
    tester,
  ) async {
    await launch(tester, MemoryResourceStore());
    await enter(tester, ResourceKind.permits, '11');
    await enter(tester, ResourceKind.originium, '692');
    await enter(tester, ResourceKind.oroberyl, '123160');
    await enter(tester, ResourceKind.quota, '43260');

    for (final (title, label) in [
      ('CHARACTER', '约 3.01 井'),
      ('ARSENAL', '约 2.73 井'),
    ]) {
      final badge = find.ancestor(
        of: find.text(label),
        matching: find.byType(StatusTag),
      );
      expect(
        tester.getRect(badge).right,
        closeTo(tester.getRect(find.text(title)).right, .01),
      );
    }
    expect(find.text('可用 21 次十连'), findsNothing);
    expect(total(tester, 'character'), '361.12');
    expect(total(tester, 'weapon'), '218.48');
  });

  testWidgets('bar selection keeps the selected range daily average', (
    tester,
  ) async {
    final ledger = ResourceLedger([
      record(15, 4000),
      record(25, 5000),
      record(26, 5800),
      record(27, 6500),
      record(30, 7450),
    ]);
    await launch(tester, MemoryResourceStore(ledger));
    expect(find.text('+230 玉/天'), findsOneWidget);
    final sevenDays = find.text('7 天');
    await tester.ensureVisible(sevenDays);
    await tester.tap(sevenDays);
    await tester.pumpAndSettle();
    expect(find.text('+490 玉/天'), findsOneWidget);
    expect(find.text('10/25 → 10/30 · 5 天'), findsOneWidget);
    final chart = find.byKey(const ValueKey('resource-trend-chart'));
    await tester.ensureVisible(chart);
    await tester.pumpAndSettle();

    final geometry =
        (tester.widget<CustomPaint>(chart).painter as ResourceChartPainter)
            .geometry;
    final origin = tester.getTopLeft(chart);
    final lastBar = geometry.barRect(geometry.points.last);
    final firstBar = geometry.barRect(geometry.points.first);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer();
    addTearDown(mouse.removePointer);

    await mouse.moveTo(origin + firstBar.center);
    await tester.pump();
    expect(find.text('+800 玉'), findsOneWidget);
    expect(find.text('+490 玉/天'), findsOneWidget);

    await mouse.moveTo(
      origin + Offset(lastBar.left + lastBar.width / 4, lastBar.center.dy),
    );
    await tester.pump();
    expect(find.text('+950 玉'), findsOneWidget);
    expect(find.text('10/27 → 10/30 · 3 天'), findsOneWidget);
    expect(find.text('+490 玉/天'), findsOneWidget);

    await tester.tapAt(
      origin + Offset(firstBar.left + firstBar.width / 4, firstBar.center.dy),
    );
    await tester.pump();
    expect(find.text('+800 玉'), findsOneWidget);
    expect(find.text('+490 玉/天'), findsOneWidget);
  });

  testWidgets('decimal preview updates but persists only on save', (
    tester,
  ) async {
    final store = MemoryResourceStore();
    await launch(tester, store);
    await enter(tester, ResourceKind.permits, '8');
    await enter(tester, ResourceKind.originium, '32');
    await enter(tester, ResourceKind.oroberyl, '5000');
    await enter(tester, ResourceKind.quota, '6100');
    expect(total(tester, 'character'), '22.80');
    expect(total(tester, 'weapon'), '30.81');
    final headline = tester.widget<Text>(
      find.byKey(const ValueKey('character-total')),
    );
    final fractional =
        (headline.textSpan as TextSpan).children!.last as TextSpan;
    expect(fractional.text, '.80');
    expect(fractional.style!.fontSize, lessThan(headline.style!.fontSize!));
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('equivalent-oroberyl')))
          .data,
      '≈ 10 抽',
    );
    expect(store.saveCount, 0);
    await save(tester);
    expect(store.saveCount, 1);
    expect(store.ledger.latest!.inventory.oroberyl, 5000);
    await enter(tester, ResourceKind.oroberyl, '12000');
    await tester.pumpWidget(const SizedBox());
    expect(store.ledger.latest!.inventory.oroberyl, 5000);
    await tester.pumpWidget(
      EndfieldResourceApp(store: store, now: () => today),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('amount-oroberyl')))
          .controller!
          .text,
      '5000',
    );
  });

  testWidgets('source options change decimal totals without a save', (
    tester,
  ) async {
    final store = MemoryResourceStore();
    await launch(tester, store, size: const Size(384, 844));
    await enter(tester, ResourceKind.originium, '80');
    expect(find.text('输入预览'), findsNothing);
    expect(total(tester, 'character'), '12.00');
    final selector = find.byKey(const ValueKey('originium-use'));
    await tester.tap(find.descendant(of: selector, matching: find.text('武库')));
    await tester.pumpAndSettle();
    expect(find.text('武库 · ≈ 10.1 抽'), findsOneWidget);
    expect(total(tester, 'character'), '0.00');
    expect(total(tester, 'weapon'), '10.10');
    await tester.tap(find.descendant(of: selector, matching: find.text('保留')));
    await tester.pumpAndSettle();
    expect(total(tester, 'character'), '0.00');
    expect(total(tester, 'weapon'), '0.00');
    expect(store.saveCount, 0);
  });

  testWidgets('invalid input cannot be saved', (tester) async {
    final store = MemoryResourceStore();
    await launch(tester, store);
    await enter(tester, ResourceKind.oroberyl, '-50');
    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('save-record')))
          .onPressed,
      isNull,
    );
    expect(find.text('请输入 0～999999999 的整数'), findsOneWidget);
    expect(store.saveCount, 0);
  });

  testWidgets('daily saves replace defaults and retain each noted snapshot', (
    tester,
  ) async {
    final previousDay = record(29, 6000);
    final store = MemoryResourceStore(ResourceLedger([previousDay]));
    await launch(tester, store);
    final note = find.byKey(const ValueKey('record-note'));
    await enter(tester, ResourceKind.oroberyl, '7100');
    await tester.enterText(note, '抽卡前');
    await save(tester);
    final morning = store.ledger.dailyRecords.last;
    expect(morning.note, '抽卡前');
    expect(morning.inventory.oroberyl, 7100);
    expect(tester.widget<TextField>(note).controller!.text, isEmpty);

    await tester.pumpWidget(const SizedBox());
    await launch(tester, store);
    expect(tester.widget<TextField>(note).controller!.text, isEmpty);

    await enter(tester, ResourceKind.oroberyl, '2100');
    await save(tester);
    expect(find.byKey(const ValueKey('confirm-update')), findsNothing);
    expect(store.ledger.dailyRecords.last.inventory.oroberyl, 2100);
    expect(
      buildTrend(
        store.ledger,
        ResourceKind.oroberyl,
        TrendMode.change,
      ).single.value,
      -3900,
    );

    await tester.enterText(note, '抽卡前');
    await save(tester);
    await enter(tester, ResourceKind.oroberyl, '2000');
    await save(tester);
    await enter(tester, ResourceKind.oroberyl, '1900');
    await save(tester);
    final snapshots = store.ledger.days.last.records;
    expect(snapshots.map((r) => r.note), ['抽卡前', '抽卡前', '']);
    expect(store.ledger.byId(morning.id)!.inventory.oroberyl, 7100);
    expect(store.ledger.byId(previousDay.id), previousDay);
    expect(store.ledger.dailyRecords.last.inventory.oroberyl, 1900);
  });

  testWidgets('04:00 rollover is automatic while the window remains open', (
    tester,
  ) async {
    var now = DateTime(2026, 10, 30, 3, 59);
    final store = MemoryResourceStore();
    await launch(tester, store, now: () => now);
    await enter(tester, ResourceKind.oroberyl, '5000');
    await save(tester);
    expect(dateKey(store.ledger.latest!.date), '2026-10-29');
    now = DateTime(2026, 10, 30, 4);
    await tester.pump(const Duration(minutes: 1));
    expect(find.text('2026.10.30 游戏日'), findsWidgets);
    await save(tester);
    expect(store.ledger.records.length, 2);
    expect(dateKey(store.ledger.latest!.date), '2026-10-30');
    now = DateTime(2026, 10, 30, 16);
    await enter(tester, ResourceKind.oroberyl, '6500');
    await save(tester);
    expect(store.ledger.records.length, 2);
    expect(store.ledger.dailyRecords.length, 2);
    expect(store.ledger.dailyRecords.last.inventory.oroberyl, 6500);
  });

  testWidgets('write failure retains draft and never announces saved', (
    tester,
  ) async {
    final store = FailingStore();
    await launch(tester, store);
    await enter(tester, ResourceKind.oroberyl, '5000');
    await save(tester);
    expect(store.ledger.records, isEmpty);
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('amount-oroberyl')))
          .controller!
          .text,
      '5000',
    );
    expect(find.textContaining('保存失败'), findsWidgets);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('save-record')))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('phone charts synced days with no history page entry', (
    tester,
  ) async {
    final latest = record(30, 8000);
    final ledger = ResourceLedger([
      latest,
    ]).withSyncedTrend([record(28, 5000), latest]);
    await launch(
      tester,
      MemoryResourceStore(ledger),
      size: const Size(390, 820),
    );

    final chart = find.byKey(const ValueKey('resource-trend-chart'));
    await tester.ensureVisible(chart);
    expect(find.text('+3,000 玉'), findsOneWidget);
    expect(find.text('最近记录'), findsNothing);
    expect(find.byIcon(Icons.history_rounded), findsNothing);
    final storage = find.byTooltip('数据位置');
    await tester.ensureVisible(storage);
    await tester.tap(storage);
    await tester.pumpAndSettle();
    expect(find.text('局域网同步'), findsOneWidget);
    expect(find.text('记录历史'), findsNothing);
    expect(find.byIcon(Icons.history_rounded), findsNothing);
  });

  testWidgets('phone shows all four inputs and save without scrolling', (
    tester,
  ) async {
    final store = MemoryResourceStore();
    tester.view.padding = const FakeViewPadding(top: 42, bottom: 24);
    addTearDown(tester.view.resetPadding);
    tester.platformDispatcher.textScaleFactorTestValue = .9;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await launch(tester, store, size: const Size(384, 844));

    final character = find.byKey(const ValueKey('character-total'));
    final weapon = find.byKey(const ValueKey('weapon-total'));
    expect(tester.getTopLeft(character).dy, tester.getTopLeft(weapon).dy);
    expect(
      tester.getTopLeft(character).dx,
      lessThan(tester.getTopLeft(weapon).dx),
    );

    final inputs = [
      for (final kind in ResourceKind.values)
        find.byKey(ValueKey('amount-${kind.name}')),
    ];
    for (final input in inputs) {
      expect(input.hitTestable(), findsOneWidget);
      expect(tester.getSize(input).height, greaterThanOrEqualTo(48));
    }
    expect(tester.getTopLeft(inputs[0]).dy, tester.getTopLeft(inputs[1]).dy);
    expect(tester.getTopLeft(inputs[2]).dy, tester.getTopLeft(inputs[3]).dy);
    expect(
      tester.getTopLeft(inputs[0]).dy,
      lessThan(tester.getTopLeft(inputs[2]).dy),
    );
    expect(
      tester.getTopLeft(inputs[0]).dx,
      lessThan(tester.getTopLeft(inputs[1]).dx),
    );
    expect(
      tester.getTopLeft(inputs[2]).dx,
      lessThan(tester.getTopLeft(inputs[3]).dx),
    );

    final saveButton = find.byKey(const ValueKey('save-record'));
    final note = find.byKey(const ValueKey('record-note'));
    final date = find.byKey(const ValueKey('record-date'));
    final hint = tester.getRect(find.byKey(const ValueKey('record-hint')));
    final noteRect = tester.getRect(note);
    final noteContainer = InputDecorator.containerOf(
      tester.element(
        find.descendant(of: note, matching: find.byType(EditableText)),
      ),
    )!;
    final noteSurface =
        noteContainer.localToGlobal(Offset.zero) & noteContainer.size;
    final buttonSurface = tester.getRect(
      find.descendant(of: saveButton, matching: find.byType(Material)),
    );
    expect(note.hitTestable(), findsOneWidget);
    expect(saveButton.hitTestable(), findsOneWidget);
    expect(noteRect.width, greaterThan(220));
    expect(tester.getRect(date).bottom, lessThan(noteRect.top));
    expect(noteRect.right, lessThan(tester.getRect(saveButton).left));
    expect(buttonSurface.top, closeTo(noteSurface.top, .01));
    expect(buttonSurface.bottom, closeTo(noteSurface.bottom, .01));
    expect(buttonSurface.width, lessThan(85));
    expect(tester.getSize(saveButton).height, greaterThanOrEqualTo(48));
    expect(hint.top, greaterThan(noteRect.bottom));
    expect(hint.left, closeTo(noteRect.left + 12, .01));
    expect(hint.right, lessThan(noteRect.right));
    expect(
      tester.getCenter(saveButton).dy,
      closeTo(tester.getCenter(note).dy, .01),
    );
    expect(tester.widget<Text>(date).data, '2026.10.30 游戏日');
    await enter(tester, ResourceKind.oroberyl, '5000');
    expect(total(tester, 'character'), '10.00');
    final noteField = tester.widget<TextField>(note);
    await tester.tap(note, kind: PointerDeviceKind.touch);
    await tester.pumpAndSettle();
    expect(noteField.focusNode!.hasFocus, isTrue);
    expect(tester.testTextInput.isVisible, isTrue);
    await tester.enterText(note, '测试备注');
    await tester.tapAt(tester.getCenter(date), kind: PointerDeviceKind.touch);
    await tester.pumpAndSettle();
    expect(noteField.focusNode!.hasFocus, isFalse);
    expect(tester.testTextInput.isVisible, isFalse);
    expect(noteField.controller!.text, '测试备注');
    await tester.tap(saveButton);
    await tester.pumpAndSettle();
    expect(store.ledger.records.single.inventory.oroberyl, 5000);
    expect(store.ledger.records.single.note, '测试备注');
    expect(tester.takeException(), isNull);
  });

  for (final size in [
    const Size(320, 640),
    const Size(800, 900),
    const Size(1440, 1000),
  ]) {
    testWidgets(
      'layout remains usable at ${size.width.toInt()} logical pixels',
      (tester) async {
        await launch(tester, MemoryResourceStore(), size: size);
        expect(tester.takeException(), isNull);
        final note = find.byKey(const ValueKey('record-note'));
        final date = find.byKey(const ValueKey('record-date'));
        final saveButton = find.byKey(const ValueKey('save-record'));
        expect(tester.getRect(date).bottom, lessThan(tester.getRect(note).top));
        expect(
          tester.getRect(note).right,
          lessThan(tester.getRect(saveButton).left),
        );
        expect(
          tester.getCenter(saveButton).dy,
          closeTo(tester.getCenter(note).dy, .01),
        );
        expect(tester.widget<Text>(date).data, '2026.10.30 游戏日');
        await tester.ensureVisible(find.byKey(const ValueKey('save-record')));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
