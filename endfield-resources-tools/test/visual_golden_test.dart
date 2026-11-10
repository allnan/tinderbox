import 'dart:io';

import 'package:endfield_resources_tools/main.dart';
import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/resource_history.dart';
import 'package:endfield_resources_tools/resource_store.dart';
import 'package:endfield_resources_tools/ui/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets(
    'desktop dashboard with real Chinese fonts and irregular history',
    (tester) async {
      await tester.runAsync(() async {
        for (final font in {
          'Microsoft YaHei UI': r'C:\Windows\Fonts\msyh.ttc',
          'Segoe UI': r'C:\Windows\Fonts\segoeui.ttf',
        }.entries) {
          final loader = FontLoader(font.key)
            ..addFont(
              File(
                font.value,
              ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
            );
          await loader.load();
        }
        await (FontLoader(
          'MaterialIcons',
        )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
      });
      final ledger = ResourceLedger([
        for (final item in [
          (17, 109200),
          (20, 111600),
          (24, 111000),
          (27, 116600),
          (29, 118000),
          (30, 119565),
        ])
          ResourceRecord(
            date: DateTime(2026, 10, item.$1),
            savedAt: DateTime(2026, 10, item.$1, 21),
            inventory: ResourceInventory(
              oroberyl: item.$2,
              protoOriginium: 676,
              charteredPermits: 9,
              arsenalQuota: 43040,
            ),
            note: item.$1 == 30 ? '日常与探索奖励' : '',
          ),
        ResourceRecord(
          date: DateTime(2026, 10, 29),
          savedAt: DateTime(2026, 10, 30, 0, 37),
          inventory: const ResourceInventory(
            oroberyl: 118500,
            protoOriginium: 676,
            charteredPermits: 9,
            arsenalQuota: 43040,
          ),
          note: '睡前记录',
        ),
        ResourceRecord(
          date: DateTime(2026, 10, 30),
          savedAt: DateTime(2026, 10, 30, 10, 20),
          inventory: const ResourceInventory(
            oroberyl: 119000,
            protoOriginium: 676,
            charteredPermits: 9,
            arsenalQuota: 43040,
          ),
          note: '上午记录',
        ),
      ]);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1440, 1420);
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(
        EndfieldResourceApp(
          store: MemoryResourceStore(ledger),
          now: () => DateTime(2026, 10, 30, 21),
        ),
      );
      await tester.runAsync(() async {
        final dashboard = tester.element(find.byType(ResourceDashboard));
        final icons = tester.widgetList<Image>(
          find.descendant(
            of: find.byType(ResourceIcon),
            matching: find.byType(Image),
          ),
        );
        await Future.wait(
          icons.map((icon) => precacheImage(icon.image, dashboard)),
        );
      });
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.history_rounded), findsNothing);
      expect(find.text('记录'), findsNothing);
      await expectLater(
        find.byType(ResourceDashboard),
        matchesGoldenFile('goldens/dashboard_desktop.png'),
      );
    },
    skip: !Platform.isWindows,
  );
}
