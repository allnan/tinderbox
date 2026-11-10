import 'dart:convert';
import 'dart:io';

import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/resource_history.dart';
import 'package:endfield_resources_tools/resource_store.dart';
import 'package:flutter_test/flutter_test.dart';

ResourceLedger savedLedger(int amount) => ResourceLedger([
  ResourceRecord(
    date: DateTime(2026, 10, 30),
    savedAt: DateTime(2026, 10, 30, 21),
    inventory: ResourceInventory(oroberyl: amount),
  ),
]);

void main() {
  late Directory directory;
  setUp(() async {
    final workspace = Directory.current.absolute.path;
    directory = Directory(
      '$workspace${Platform.pathSeparator}.dart_tool${Platform.pathSeparator}store-test-${DateTime.now().microsecondsSinceEpoch}',
    );
    await directory.create(recursive: true);
  });
  tearDown(() async {
    final expected =
        '${Directory.current.absolute.path}${Platform.pathSeparator}.dart_tool${Platform.pathSeparator}store-test-';
    expect(directory.absolute.path.startsWith(expected), isTrue);
    if (await directory.exists()) await directory.delete(recursive: true);
  });

  test('reading an empty application directory does not write files', () async {
    final store = PortableResourceStore(directory);
    expect((await store.load()).records, isEmpty);
    expect(await directory.list().toList(), isEmpty);
    expect(File(store.location).parent.path, directory.path);
  });

  test(
    'explicit save survives reopen and creates a same-directory backup',
    () async {
      final store = PortableResourceStore(directory);
      await store.load();
      await store.save(savedLedger(5000));
      await store.save(savedLedger(6000));
      expect(
        (await PortableResourceStore(
          directory,
        ).load()).latest!.inventory.oroberyl,
        6000,
      );
      final backup = ResourceLedger.fromJson(
        jsonDecode(await File('${store.location}.bak').readAsString()),
      );
      expect(backup.latest!.inventory.oroberyl, 5000);
      final files = await directory.list().toList();
      expect(
        files.every((entry) => entry.parent.path == directory.path),
        isTrue,
      );
      expect(await File('${store.location}.tmp').exists(), isFalse);
    },
  );

  test(
    'corruption recovers backup without silently overwriting original',
    () async {
      final first = PortableResourceStore(directory);
      await first.load();
      await first.save(savedLedger(5000));
      await first.save(savedLedger(6000));
      await first.file.writeAsString('{broken');
      final recovered = PortableResourceStore(directory);
      expect((await recovered.load()).latest!.inventory.oroberyl, 5000);
      expect(recovered.recoveryNotice, isNotNull);
      expect(await first.file.readAsString(), '{broken');
      await recovered.save(savedLedger(7000));
      final corrupt = (await directory.list().toList())
          .whereType<File>()
          .singleWhere((file) => file.path.contains('.corrupt-'));
      expect(await corrupt.readAsString(), '{broken');
      expect(
        (await PortableResourceStore(
          directory,
        ).load()).latest!.inventory.oroberyl,
        7000,
      );
    },
  );

  test('unrecoverable data does not permit a destructive save', () async {
    final store = PortableResourceStore(directory);
    await store.file.writeAsString('{broken');
    await expectLater(store.load(), throwsFormatException);
    await expectLater(store.save(savedLedger(0)), throwsStateError);
    expect(await store.file.readAsString(), '{broken');
  });

  test(
    'newer file versions remain intact even when an old backup exists',
    () async {
      final store = PortableResourceStore(directory);
      await store.load();
      await store.save(savedLedger(5000));
      await store.save(savedLedger(6000));
      const futureData = '{"schemaVersion":3,"records":[]}';
      await store.file.writeAsString(futureData);
      final olderApp = PortableResourceStore(directory);
      await expectLater(olderApp.load(), throwsUnsupportedError);
      await expectLater(olderApp.save(savedLedger(0)), throwsStateError);
      expect(await store.file.readAsString(), futureData);
    },
  );

  test('another application instance cannot overwrite a newer save', () async {
    final first = PortableResourceStore(directory);
    final second = PortableResourceStore(directory);
    await first.load();
    await second.load();
    await first.save(savedLedger(5000));
    await expectLater(second.save(savedLedger(100)), throwsStateError);
    expect(
      (await PortableResourceStore(
        directory,
      ).load()).latest!.inventory.oroberyl,
      5000,
    );
  });

  test(
    'legacy upgrade is read-only until save and keeps the original backup',
    () async {
      final original = jsonEncode({
        'schemaVersion': 1,
        'records': [
          {
            'date': '2026-10-30',
            'savedAt': '2026-10-30T00:37:07.254515',
            'inventory': const ResourceInventory(
              charteredPermits: 9,
              protoOriginium: 676,
              oroberyl: 119565,
              arsenalQuota: 43040,
            ).toJson(),
            'originiumUse': 'character',
            'note': '',
            'includedInTrend': true,
          },
        ],
      });
      final store = PortableResourceStore(directory);
      await store.file.writeAsString(original);
      final loaded = await store.load();
      expect(dateKey(loaded.latest!.date), '2026-10-29');
      expect(await store.file.readAsString(), original);
      expect(await File('${store.location}.pre-v2.bak').exists(), isFalse);
      final next = ResourceRecord(
        date: DateTime(2026, 10, 30),
        savedAt: DateTime(2026, 10, 30, 16),
        inventory: const ResourceInventory(oroberyl: 120000),
      );
      await store.save(loaded.upsert(next));
      expect(
        await File('${store.location}.pre-v2.bak').readAsString(),
        original,
      );
      expect(jsonDecode(await store.file.readAsString())['schemaVersion'], 2);
      final reopened = await PortableResourceStore(directory).load();
      expect(reopened.records.length, 2);
      expect(reopened.dailyRecords.length, 2);
      await store.save(reopened.upsert(next.withTrend(false)));
      expect(
        await File('${store.location}.pre-v2.bak').readAsString(),
        original,
      );
    },
  );
}
