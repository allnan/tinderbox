import 'dart:convert';
import 'dart:io';

import 'package:endfield_resources_tools/lan_sync.dart';
import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/resource_history.dart';
import 'package:flutter_test/flutter_test.dart';

ResourceRecord record(int day, int hour, int amount, {String note = ''}) =>
    ResourceRecord(
      date: DateTime(2026, 11, day),
      savedAt: DateTime(2026, 11, day, hour),
      inventory: ResourceInventory(oroberyl: amount),
      note: note,
    );

LanSyncSnapshot snapshot(ResourceLedger ledger) =>
    (latest: ledger.latest, daily: ledger.dailyRecords);

ResourceLedger merge(ResourceLedger ledger, LanSyncSnapshot remote) =>
    ledger.syncLatest(remote.latest).withSyncedTrend(remote.daily);

LanSyncApplied applied(ResourceLedger before, ResourceLedger after) =>
    (snapshot: snapshot(after), changes: LanSyncChanges.between(before, after));

void main() {
  test(
    'exchanges the latest record and restores the other days on the chart',
    () async {
      final oldDay = record(3, 20, 500, note: '仅在电脑保留的备注');
      final desktopNote = record(4, 8, 900, note: '早上');
      final desktopDefault = record(4, 9, 1100);
      final phoneDefault = record(4, 10, 1500);
      var desktop = ResourceLedger([oldDay, desktopNote, desktopDefault]);
      var phone = ResourceLedger([phoneDefault]);
      final host = await LanSyncHost.start(InternetAddress.loopbackIPv4, (
        incoming,
      ) async {
        final before = desktop;
        desktop = merge(desktop, incoming);
        return applied(before, desktop);
      }, discoveryPort: 0);
      addTearDown(host.close);
      final peers = await discoverLanSync(
        destination: InternetAddress.loopbackIPv4,
        port: host.discoveryPort,
      );
      expect(peers, hasLength(1));
      final peer = peers.single;
      expect(peer.name, host.name);

      phone = merge(
        phone,
        (await exchangeLatest(peer, snapshot(phone))).snapshot,
      );
      expect(desktop.latest!.id, phoneDefault.id);
      expect(phone.latest!.id, phoneDefault.id);
      expect(desktop.byId(oldDay.id), same(oldDay));
      expect(desktop.byId(desktopNote.id), same(desktopNote));
      expect(desktop.byId(desktopDefault.id), isNull);
      expect(phone.records, hasLength(1));
      expect(phone.byId(oldDay.id), isNull);
      expect(phone.syncedTrend.first.note, isEmpty);
      expect(
        buildTrend(
          ResourceLedger.fromJson(phone.toJson()),
          ResourceKind.oroberyl,
          TrendMode.change,
        ).single.value,
        1000,
      );

      final newerDesktop = record(4, 12, 2000, note: '中午');
      desktop = desktop.saveCapture(newerDesktop);
      phone = merge(
        phone,
        (await exchangeLatest(peer, snapshot(phone))).snapshot,
      );
      expect(phone.latest!.id, newerDesktop.id);
      expect(phone.latest!.note, '中午');
      expect(phone.latest!.inventory, newerDesktop.inventory);
      expect(phone.byId(phoneDefault.id), same(phoneDefault));
      expect(
        merge(phone, (await exchangeLatest(peer, snapshot(phone))).snapshot),
        same(phone),
      );
      desktop = desktop.upsert(oldDay.withTrend(false));
      phone = merge(
        phone,
        (await exchangeLatest(peer, snapshot(phone))).snapshot,
      );
      expect(phone.trendDailyRecords, hasLength(1));
    },
  );

  test('computer discovers a phone and pulls its newer saved record', () async {
    final address = InternetAddress.loopbackIPv4;
    final current = record(4, 10, 1500, note: '手机保存');
    final phone = ResourceLedger([record(3, 20, 500), current]);
    final desktop = ResourceLedger([record(4, 9, 1000)]);
    final host = await LanSyncHost.start(
      address,
      (incoming) async => applied(phone, merge(phone, incoming)),
      discoveryPort: 0,
      device: LanSyncDevice.phone,
      deviceName: '测试手机',
    );
    addTearDown(host.close);

    final results = await Future.wait([
      discoverLanSync(destination: address, port: host.discoveryPort),
      discoverLanSync(
        subnetBroadcasts: [address],
        port: host.discoveryPort,
        device: LanSyncDevice.phone,
      ),
    ]);
    expect(results.first, isEmpty);
    final peer = results.last.single;
    expect(peer.name, '测试手机');
    final reply = await exchangeLatest(peer, snapshot(desktop));
    final synced = merge(desktop, reply.snapshot);
    expect(synced.latest!.id, current.id);
    expect(synced.latest!.note, '手机保存');
    expect(synced.trendDailyRecords, hasLength(2));
    expect(reply.peerChanges!.isEmpty, isTrue);
    expect(
      lanSyncSummary(
        local: applied(desktop, synced),
        peerChanges: reply.peerChanges,
        peerLabel: '手机',
      ),
      '同步完成\n最新记录：已从手机接收\n图表：本机更新了 2 个游戏日',
    );
  });

  test(
    'reports a push to the phone and no updates on repeated exchanges',
    () async {
      final address = InternetAddress.loopbackIPv4;
      final old = record(4, 9, 1000);
      var desktop = ResourceLedger([
        record(3, 20, 500),
        old,
        record(5, 10, 1500),
      ]);
      var phone = ResourceLedger([old]);
      final host = await LanSyncHost.start(
        address,
        (incoming) async {
          final before = phone;
          phone = merge(phone, incoming);
          return applied(before, phone);
        },
        discoveryPort: 0,
        device: LanSyncDevice.phone,
      );
      addTearDown(host.close);
      final peer = (await discoverLanSync(
        destination: address,
        port: host.discoveryPort,
        device: LanSyncDevice.phone,
      )).single;
      final before = desktop;
      final reply = await exchangeLatest(peer, snapshot(desktop));
      desktop = merge(desktop, reply.snapshot);
      expect(desktop.latest!.id, phone.latest!.id);
      expect(applied(before, desktop).changes.isEmpty, isTrue);
      expect(reply.peerChanges!.latestChanged, isTrue);
      expect(reply.peerChanges!.chartDaysChanged, 2);
      expect(
        lanSyncSummary(
          local: applied(before, desktop),
          peerChanges: reply.peerChanges,
          peerLabel: '手机',
        ),
        '同步完成\n最新记录：已发送到手机\n图表：手机更新了 2 个游戏日',
      );

      for (var attempt = 0; attempt < 3; attempt++) {
        final before = desktop;
        final reply = await exchangeLatest(peer, snapshot(desktop));
        desktop = merge(desktop, reply.snapshot);
        expect(reply.peerChanges!.isEmpty, isTrue);
        expect(
          lanSyncSummary(
            local: applied(before, desktop),
            peerChanges: reply.peerChanges,
            peerLabel: '手机',
          ),
          '同步完成 · 本次无更新',
        );
      }
    },
  );

  test('counts chart balance changes rather than transferred summary rows', () {
    final first = record(3, 20, 500);
    final latest = record(5, 10, 1500);
    final before = ResourceLedger([latest]).withSyncedTrend([first, latest]);
    final copied = ResourceLedger.fromJson(before.toJson());
    expect(LanSyncChanges.between(before, copied).isEmpty, isTrue);

    final metadataOnly = ResourceRecord(
      id: 'another-record-with-the-same-balances',
      date: first.date,
      savedAt: first.savedAt.add(const Duration(hours: 1)),
      inventory: first.inventory,
    );
    final after = before.withSyncedTrend([metadataOnly, latest]);
    expect(LanSyncChanges.between(before, after).chartDaysChanged, 0);

    final changed = before.withSyncedTrend([record(3, 21, 600), latest]);
    expect(LanSyncChanges.between(before, changed).chartDaysChanged, 1);
    final removed = before.withSyncedTrend([latest]);
    expect(LanSyncChanges.between(before, removed).chartDaysChanged, 1);
    final added = before.withSyncedTrend([first, record(4, 20, 1000), latest]);
    expect(LanSyncChanges.between(before, added).chartDaysChanged, 1);
    final localHistory = ResourceLedger([first, latest]);
    expect(
      LanSyncChanges.between(
        localHistory,
        localHistory.withSyncedTrend([latest]),
      ).chartDaysChanged,
      0,
    );
  });

  test('describes chart-only changes on both devices independently', () {
    final latest = record(5, 10, 1500);
    final before = ResourceLedger([latest]);
    final after = before.withSyncedTrend([record(3, 20, 500), latest]);
    expect(
      lanSyncSummary(
        local: applied(before, after),
        peerChanges: const LanSyncChanges(
          latestChanged: false,
          chartDaysChanged: 2,
        ),
        peerLabel: '电脑',
      ),
      '同步完成\n最新记录：两端已一致\n图表：本机更新了 1 个游戏日；电脑更新了 2 个游戏日',
    );
    expect(
      lanSyncSummary(
        local: applied(ResourceLedger(), ResourceLedger()),
        peerChanges: const LanSyncChanges(
          latestChanged: false,
          chartDaysChanged: 0,
        ),
        peerLabel: '电脑',
      ),
      '同步完成 · 两端都还没有已保存的记录。',
    );
  });

  test(
    'accepts older replies without guessing whether the peer changed',
    () async {
      final address = InternetAddress.loopbackIPv4;
      final data = ResourceLedger([record(4, 10, 1500)]);
      final host = await LanSyncHost.start(
        address,
        (incoming) async => applied(data, merge(data, incoming)),
        discoveryPort: 0,
      );
      addTearDown(host.close);
      final peer = (await discoverLanSync(
        destination: address,
        port: host.discoveryPort,
      )).single;
      await host.close();
      final legacy = await HttpServer.bind(address, peer.port);
      addTearDown(() => legacy.close(force: true));
      legacy.listen((request) async {
        await request.drain<void>();
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'version': 1,
            'record': data.latest!.toJson(),
            'trend': data.dailyRecords
                .map((record) => record.toJson())
                .toList(),
          }),
        );
        await request.response.close();
      });
      final reply = await exchangeLatest(peer, snapshot(data));
      expect(reply.peerChanges, isNull);
      expect(
        lanSyncSummary(
          local: applied(data, merge(data, reply.snapshot)),
          peerChanges: reply.peerChanges,
          peerLabel: '手机',
        ),
        '同步完成\n最新记录：两端已一致\n图表：本机无变化',
      );
    },
  );

  test(
    'refreshes a computer after its synchronization server restarts',
    () async {
      final address = InternetAddress.loopbackIPv4;
      var calls = 0;
      Future<LanSyncApplied> apply(LanSyncSnapshot incoming) async {
        calls++;
        final before = ResourceLedger();
        return applied(before, merge(before, incoming));
      }

      final first = await LanSyncHost.start(address, apply, discoveryPort: 0);
      addTearDown(first.close);
      final port = first.discoveryPort;
      Future<List<LanSyncPeer>> discover() =>
          discoverLanSync(destination: address, port: port);
      final cached = (await discover()).single;
      await first.close();
      expect(await discover(), isEmpty);
      final reopened = await LanSyncHost.start(
        address,
        apply,
        discoveryPort: port,
      );
      addTearDown(reopened.close);

      final data = snapshot(ResourceLedger([record(4, 10, 1500)]));
      await expectLater(exchangeLatest(cached, data), throwsFormatException);
      expect(calls, 0);
      final online = (await discover()).single;
      expect(online.name, cached.name);
      expect(
        (await exchangeLatest(online, data)).snapshot.latest?.id,
        data.latest?.id,
      );
      expect(calls, 1);
    },
  );
}
