import 'dart:convert';

import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/resource_history.dart';
import 'package:flutter_test/flutter_test.dart';

ResourceRecord sample(int day, int amount, {bool included = true}) =>
    ResourceRecord(
      date: DateTime(2026, 10, day),
      savedAt: DateTime(2026, 10, day, 21),
      inventory: ResourceInventory(oroberyl: amount),
      includedInTrend: included,
    );

void main() {
  test('irregular records produce changes within the selected range', () {
    final ledger = ResourceLedger([
      sample(25, 5000),
      sample(28, 6500),
      sample(30, 6000),
    ]);
    final points = buildTrend(ledger, ResourceKind.oroberyl, TrendMode.change);
    expect(points.map((p) => p.value), [1500, -500]);
    expect(points.map((p) => p.intervalDays), [3, 2]);
    final today = DateTime(2026, 10, 30);
    final inRange = buildTrend(
      ledger,
      ResourceKind.oroberyl,
      TrendMode.change,
      today: today,
      rangeDays: 3,
    ).single;
    expect(inRange.previousDate, DateTime(2026, 10, 28));
    expect(inRange.value, -500);
    expect(inRange.intervalDays, 2);
    expect(
      buildTrend(
        ledger,
        ResourceKind.oroberyl,
        TrendMode.change,
        today: today,
        rangeDays: 2,
      ),
      isEmpty,
    );
  });

  test('excluded erroneous records are bypassed on both sides', () {
    final ledger = ResourceLedger([
      sample(25, 5000),
      sample(27, 999999, included: false),
      sample(30, 7000),
    ]);
    final points = buildTrend(ledger, ResourceKind.oroberyl, TrendMode.change);
    expect(points.length, 1);
    expect(points.single.value, 2000);
    expect(points.single.intervalDays, 5);
    expect(
      buildTrend(
        ledger,
        ResourceKind.oroberyl,
        TrendMode.balance,
      ).map((p) => p.value),
      [5000, 7000],
    );
  });

  test('first snapshot is a baseline with no fabricated earnings', () {
    final ledger = ResourceLedger([sample(30, 5000)]);
    expect(
      buildTrend(ledger, ResourceKind.oroberyl, TrendMode.change),
      isEmpty,
    );
    expect(
      buildTrend(ledger, ResourceKind.oroberyl, TrendMode.balance).single.value,
      5000,
    );
  });

  test(
    'editing an existing ID replaces only that snapshot and keeps ordering',
    () {
      final ledger = ResourceLedger([
        sample(30, 5000),
        sample(25, 1000),
      ]).upsert(sample(30, 6000));
      expect(ledger.records.length, 2);
      expect(ledger.latest!.inventory.oroberyl, 6000);
      expect(ledger.records.first.date.day, 25);
      expect(
        ResourceLedger.fromJson(
          jsonDecode(jsonEncode(ledger.toJson())),
        ).latest!.inventory.oroberyl,
        6000,
      );
    },
  );

  test('malformed data is rejected instead of silently becoming zeros', () {
    final data = sample(30, 5000).toJson();
    data['inventory']['oroberyl'] = -1;
    expect(() => ResourceRecord.fromJson(data), throwsFormatException);
    final invalidDate = sample(30, 5000).toJson()..['date'] = '2026-02-31';
    expect(() => ResourceRecord.fromJson(invalidDate), throwsFormatException);
    expect(
      () => ResourceLedger([sample(30, 1), sample(30, 2)]),
      throwsFormatException,
    );
  });

  test('04:00 switches game days across midnight and month boundaries', () {
    expect(dateKey(gameDay(DateTime(2026, 10, 30, 0, 37))), '2026-10-29');
    expect(dateKey(gameDay(DateTime(2026, 10, 30, 3, 59, 59))), '2026-10-29');
    expect(dateKey(gameDay(DateTime(2026, 10, 30, 4))), '2026-10-30');
    expect(dateKey(gameDay(DateTime(2026, 11, 1, 2))), '2026-10-31');
  });

  test(
    'multiple snapshots survive and each game day uses its last valid one',
    () {
      final first = sample(29, 5000);
      final morning = ResourceRecord(
        date: DateTime(2026, 10, 30),
        savedAt: DateTime(2026, 10, 30, 10),
        inventory: const ResourceInventory(oroberyl: 5500),
      );
      final evening = ResourceRecord(
        date: morning.date,
        savedAt: DateTime(2026, 10, 30, 22),
        inventory: const ResourceInventory(oroberyl: 7000),
      );
      final lateNight = ResourceRecord(
        date: morning.date,
        savedAt: DateTime(2026, 10, 31, 1),
        inventory: const ResourceInventory(oroberyl: 7500),
      );
      final ledger = ResourceLedger([evening, first, lateNight, morning]);
      expect(ledger.records.length, 4);
      expect(ledger.days.length, 2);
      expect(ledger.dailyRecords.map((r) => r.inventory.oroberyl), [
        5000,
        7500,
      ]);
      expect(
        buildTrend(
          ledger,
          ResourceKind.oroberyl,
          TrendMode.change,
        ).single.value,
        2500,
      );
      final excluded = ledger.upsert(lateNight.withTrend(false));
      expect(excluded.records.length, 4);
      expect(excluded.dailyRecords.last.id, evening.id);
      expect(
        buildTrend(
          excluded,
          ResourceKind.oroberyl,
          TrendMode.change,
        ).single.value,
        2000,
      );
    },
  );

  test('new snapshots get independent IDs even with identical clock ticks', () {
    final now = DateTime(2026, 10, 30, 21);
    final first = ResourceRecord(
      id: ResourceLedger().nextRecordId(now),
      date: gameDay(now),
      savedAt: now,
      inventory: const ResourceInventory(oroberyl: 5000),
    );
    final ledger = ResourceLedger([first]);
    final second = ResourceRecord(
      id: ledger.nextRecordId(now),
      date: first.date,
      savedAt: now,
      inventory: const ResourceInventory(oroberyl: 6000),
    );
    final combined = ledger.upsert(second);
    expect(first.id, isNot(second.id));
    expect(combined.records.length, 2);
    expect(combined.dailyRecords.single.inventory.oroberyl, 6000);
  });

  test(
    'legacy midnight saves are reclassified and explicit backfills retain dates',
    () {
      final midnight = {
        'date': '2026-10-30',
        'savedAt': '2026-10-30T00:37:07.254515',
        'inventory': const ResourceInventory(oroberyl: 119565).toJson(),
        'originiumUse': 'character',
        'note': '',
        'includedInTrend': true,
      };
      final backfill = Map<String, dynamic>.from(midnight)
        ..['date'] = '2026-10-25';
      final migrated = ResourceLedger.fromJson({
        'schemaVersion': 1,
        'records': [midnight, backfill],
      });
      expect(migrated.records.length, 2);
      expect(dateKey(migrated.latest!.date), '2026-10-29');
      expect(migrated.latest!.recordedAt.hour, 0);
      expect(dateKey(migrated.records.first.date), '2026-10-25');
      expect(migrated.records.first.isBackfill, isTrue);
      final reopened = ResourceLedger.fromJson(
        jsonDecode(jsonEncode(migrated.toJson())),
      );
      expect(reopened.latest!.id, migrated.latest!.id);
      expect(dateKey(reopened.latest!.date), '2026-10-29');
    },
  );
}
