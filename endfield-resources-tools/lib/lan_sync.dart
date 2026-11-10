import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'resource_history.dart';

const _discoveryPort = 47831;
const _probePrefix = 'endfield-ledger/3/';
const _discoveryTimeout = Duration(milliseconds: 1600);
const _requestTimeout = Duration(seconds: 10);
const _maxBodyBytes = 2 * 1024 * 1024;

typedef LanSyncSnapshot = ({
  ResourceRecord? latest,
  List<ResourceRecord>? daily,
});

typedef LanSyncApplied = ({LanSyncSnapshot snapshot, LanSyncChanges changes});

typedef LanSyncReply = ({
  LanSyncSnapshot snapshot,
  LanSyncChanges? peerChanges,
});

class LanSyncChanges {
  const LanSyncChanges({
    required this.latestChanged,
    required this.chartDaysChanged,
  });

  factory LanSyncChanges.between(ResourceLedger before, ResourceLedger after) {
    final beforeDays = {
      for (final record in before.trendDailyRecords)
        dateKey(record.date): record.inventory,
    };
    final afterDays = {
      for (final record in after.trendDailyRecords)
        dateKey(record.date): record.inventory,
    };
    // Count visible chart changes, including added and removed days. Receiving
    // another copy of the same balances does not change the chart.
    final changedDays = {
      ...beforeDays.keys,
      ...afterDays.keys,
    }.where((day) => beforeDays[day] != afterDays[day]);
    String latestJson(ResourceRecord? record) =>
        jsonEncode(record == null ? null : _encodeRecord(record));
    return LanSyncChanges(
      latestChanged: latestJson(before.latest) != latestJson(after.latest),
      chartDaysChanged: changedDays.length,
    );
  }

  factory LanSyncChanges.fromJson(dynamic json) {
    if (json is! Map<String, dynamic> ||
        json['latestChanged'] is! bool ||
        json['chartDaysChanged'] is! int ||
        (json['chartDaysChanged'] as int) < 0) {
      throw const FormatException('同步结果格式无效。');
    }
    return LanSyncChanges(
      latestChanged: json['latestChanged'] as bool,
      chartDaysChanged: json['chartDaysChanged'] as int,
    );
  }

  final bool latestChanged;
  final int chartDaysChanged;
  bool get isEmpty => !latestChanged && chartDaysChanged == 0;

  Map<String, dynamic> toJson() => {
    'latestChanged': latestChanged,
    'chartDaysChanged': chartDaysChanged,
  };
}

String lanSyncSummary({
  required LanSyncApplied local,
  required LanSyncChanges? peerChanges,
  required String peerLabel,
}) {
  final received = local.changes;
  if (received.isEmpty && peerChanges?.isEmpty == true) {
    return local.snapshot.latest == null
        ? '同步完成 · 两端都还没有已保存的记录。'
        : '同步完成 · 本次无更新';
  }
  final latest = received.latestChanged
      ? peerChanges?.latestChanged == true
            ? '两端最新记录均有更新'
            : '已从$peerLabel接收'
      : peerChanges?.latestChanged == true
      ? '已发送到$peerLabel'
      : local.snapshot.latest == null
      ? '两端暂无已保存的记录'
      : '两端已一致';
  final chart = <String>[
    if (received.chartDaysChanged > 0)
      '本机更新了 ${received.chartDaysChanged} 个游戏日',
    if (peerChanges != null && peerChanges.chartDaysChanged > 0)
      '$peerLabel更新了 ${peerChanges.chartDaysChanged} 个游戏日',
  ];
  // Older versions do not acknowledge their changes. Describe only the local
  // result in that case, without guessing whether the peer was updated.
  final chartMessage = chart.isNotEmpty
      ? chart.join('；')
      : peerChanges == null
      ? '本机无变化'
      : '本次无变化';
  return '同步完成\n最新记录：$latest\n图表：$chartMessage';
}

enum LanSyncDevice { computer, phone }

String _token() {
  final random = Random.secure();
  return base64UrlEncode(List.generate(16, (_) => random.nextInt(256)));
}

bool _isLocalAddress(InternetAddress address) {
  if (address.type != InternetAddressType.IPv4) return false;
  final bytes = address.rawAddress;
  return address.isLoopback ||
      bytes[0] == 10 ||
      (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) ||
      (bytes[0] == 192 && bytes[1] == 168);
}

Future<List<InternetAddress>> lanSyncAddresses() async {
  final interfaces = await NetworkInterface.list(
    type: InternetAddressType.IPv4,
  );
  bool isWifi(NetworkInterface interface) => RegExp(
    r'wlan|wi[ -]?fi|无线',
    caseSensitive: false,
  ).hasMatch(interface.name);
  final ordered = [
    ...interfaces.where(isWifi),
    ...interfaces.where((interface) => !isWifi(interface)),
  ];
  return {
    for (final interface in ordered)
      for (final address in interface.addresses)
        if (_isLocalAddress(address) && !address.isLoopback) address,
  }.toList();
}

Map<String, dynamic> _encodeRecord(ResourceRecord record) => {
  ...record.toJson(),
  'recordedAt': record.recordedAt.toUtc().toIso8601String(),
  'savedAt': record.savedAt.toUtc().toIso8601String(),
};

String _encode(LanSyncSnapshot snapshot, {LanSyncChanges? receipt}) =>
    jsonEncode({
      'version': 1,
      'record': snapshot.latest == null
          ? null
          : _encodeRecord(snapshot.latest!),
      if (snapshot.daily case final daily?)
        'trend': [
          for (final record in daily) {..._encodeRecord(record), 'note': ''},
        ],
      if (receipt != null) 'receipt': receipt.toJson(),
    });

Future<String> _readBody(Stream<List<int>> stream) async {
  final bytes = <int>[];
  await for (final chunk in stream.timeout(_requestTimeout)) {
    if (bytes.length + chunk.length > _maxBodyBytes) {
      throw const FormatException('同步数据超过大小限制。');
    }
    bytes.addAll(chunk);
  }
  return utf8.decode(bytes);
}

Future<LanSyncReply> _decode(Stream<List<int>> stream) async {
  final data = jsonDecode(await _readBody(stream));
  if (data is! Map<String, dynamic> ||
      data['version'] != 1 ||
      !data.containsKey('record')) {
    throw const FormatException('同步数据格式不支持。');
  }
  final record = data['record'];
  if (record != null && record is! Map<String, dynamic>) {
    throw const FormatException('同步记录格式无效。');
  }
  return (
    snapshot: (
      latest: record == null ? null : ResourceRecord.fromJson(record),
      daily: data.containsKey('trend')
          ? decodeTrendSummaries(data['trend'])
          : null,
    ),
    peerChanges: data.containsKey('receipt')
        ? LanSyncChanges.fromJson(data['receipt'])
        : null,
  );
}

class LanSyncPeer {
  const LanSyncPeer._(this.address, this.port, this.name, this._session);

  final InternetAddress address;
  final int port;
  final String name;
  final String _session;

  Uri endpoint(String path) =>
      Uri(scheme: 'http', host: address.address, port: port, path: path);
}

Future<List<LanSyncPeer>> discoverLanSync({
  InternetAddress? destination,
  Iterable<InternetAddress> subnetBroadcasts = const [],
  int port = _discoveryPort,
  LanSyncDevice device = LanSyncDevice.computer,
}) async {
  final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
  final probe = '$_probePrefix${_token()}';
  final bytes = utf8.encode(probe);
  final targets = destination != null
      ? {destination}
      : subnetBroadcasts.isEmpty
      ? {InternetAddress('255.255.255.255')}
      : subnetBroadcasts.toSet();
  final found = <String, LanSyncPeer>{};
  socket.broadcastEnabled = true;
  final listener = socket.listen((event) {
    if (event != RawSocketEvent.read) return;
    Datagram? packet;
    while ((packet = socket.receive()) != null) {
      final datagram = packet!;
      if (datagram.data.length > 512 || !_isLocalAddress(datagram.address)) {
        continue;
      }
      try {
        final reply = jsonDecode(utf8.decode(datagram.data));
        if (reply is! Map<String, dynamic> ||
            reply['probe'] != probe ||
            reply['address'] != datagram.address.address ||
            (reply['device'] ?? LanSyncDevice.computer.name) != device.name) {
          continue;
        }
        final endpoint = reply['port'];
        final name = reply['name'];
        final session = reply['session'];
        if (endpoint is int &&
            endpoint > 0 &&
            endpoint <= 65535 &&
            name is String &&
            name.isNotEmpty &&
            name.length <= 64 &&
            session is String &&
            RegExp(r'^[A-Za-z0-9_-]{22}==$').hasMatch(session)) {
          found['${datagram.address.address}:$endpoint'] = LanSyncPeer._(
            datagram.address,
            endpoint,
            name,
            session,
          );
        }
      } on FormatException {
        // Other apps may use the same UDP port.
      }
    }
  });
  try {
    for (var attempt = 0; attempt < 2; attempt++) {
      for (final target in targets) {
        try {
          socket.send(bytes, target, port);
        } on SocketException {
          if (targets.length == 1) rethrow;
        }
      }
      await Future<void>.delayed(_discoveryTimeout ~/ 2);
    }
    return found.values.toList()..sort((a, b) => a.name.compareTo(b.name));
  } finally {
    await listener.cancel();
    socket.close();
  }
}

/// Serves only the selected local address while the app is running.
class LanSyncHost {
  LanSyncHost._(
    this._server,
    this._discovery,
    this.name,
    this._device,
    this._exchange,
  ) {
    _server.listen(_handle);
    _discovery.listen(_announce);
  }

  final HttpServer _server;
  final RawDatagramSocket _discovery;
  final String name;
  final LanSyncDevice _device;
  final Future<LanSyncApplied> Function(LanSyncSnapshot) _exchange;
  final String _session = _token();
  bool _closed = false;
  bool _busy = false;

  int get discoveryPort => _discovery.port;
  InternetAddress get address => _server.address;

  static Future<LanSyncHost> start(
    InternetAddress address,
    Future<LanSyncApplied> Function(LanSyncSnapshot) exchange, {
    int discoveryPort = _discoveryPort,
    LanSyncDevice device = LanSyncDevice.computer,
    String? deviceName,
  }) async {
    if (!_isLocalAddress(address)) {
      throw const FormatException('请选择本机的局域网地址。');
    }
    final server = await HttpServer.bind(address, 0);
    server.idleTimeout = _requestTimeout;
    try {
      final fallback = device == LanSyncDevice.phone ? '手机' : '电脑';
      final name = (deviceName ?? Platform.localHostname).trim();
      final discovery = await RawDatagramSocket.bind(
        InternetAddress.anyIPv4,
        discoveryPort,
        reuseAddress: false,
      );
      return LanSyncHost._(
        server,
        discovery,
        name.isEmpty ? fallback : name.substring(0, min(name.length, 64)),
        device,
        exchange,
      );
    } catch (_) {
      await server.close(force: true);
      rethrow;
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _discovery.close();
    await _server.close(force: true);
  }

  void _announce(RawSocketEvent event) {
    if (event != RawSocketEvent.read || _closed) return;
    Datagram? packet;
    while ((packet = _discovery.receive()) != null) {
      final datagram = packet!;
      if (!_isLocalAddress(datagram.address) ||
          datagram.data.length != _probePrefix.length + 24) {
        continue;
      }
      final probe = ascii.decode(datagram.data, allowInvalid: true);
      if (!probe.startsWith(_probePrefix)) continue;
      _discovery.send(
        utf8.encode(
          jsonEncode({
            'probe': probe,
            'address': _server.address.address,
            'port': _server.port,
            'name': name,
            'device': _device.name,
            'session': _session,
          }),
        ),
        datagram.address,
        datagram.port,
      );
    }
  }

  Future<void> _handle(HttpRequest request) async {
    final response = request.response;
    final peerAddress = request.connectionInfo?.remoteAddress;
    final authorization = request.headers[HttpHeaders.authorizationHeader];
    try {
      if (request.method != 'POST' || request.uri.path != '/sync') {
        response.statusCode = HttpStatus.notFound;
      } else if (_closed ||
          peerAddress == null ||
          !_isLocalAddress(peerAddress) ||
          authorization?.length != 1 ||
          authorization!.single != 'Bearer $_session') {
        response.statusCode = HttpStatus.forbidden;
      } else if (_busy) {
        response.statusCode = HttpStatus.conflict;
      } else {
        _busy = true;
        try {
          final incoming = await _decode(request);
          if (_closed) return;
          final applied = await _exchange(incoming.snapshot);
          response.headers.contentType = ContentType.json;
          response.write(_encode(applied.snapshot, receipt: applied.changes));
        } finally {
          _busy = false;
        }
      }
    } on FormatException {
      response.statusCode = HttpStatus.badRequest;
    } on StateError catch (error) {
      response.statusCode = HttpStatus.conflict;
      response.headers.contentType = ContentType.text;
      response.write(error.message);
    } catch (_) {
      response.statusCode = HttpStatus.internalServerError;
    } finally {
      try {
        await response.close();
      } on IOException {
        // The other device may close its sync window during a request.
      }
    }
  }
}

Future<LanSyncReply> exchangeLatest(
  LanSyncPeer peer,
  LanSyncSnapshot local,
) async {
  if (!_isLocalAddress(peer.address)) {
    throw const FormatException('请选择同一局域网内的设备。');
  }

  final client = HttpClient()
    ..connectionTimeout = _requestTimeout
    ..findProxy = (_) => 'DIRECT';
  try {
    final request = await client
        .postUrl(peer.endpoint('/sync'))
        .timeout(_requestTimeout);
    request.followRedirects = false;
    request.headers.contentType = ContentType.json;
    request.headers.set(
      HttpHeaders.authorizationHeader,
      'Bearer ${peer._session}',
    );
    request.write(_encode(local));
    final response = await request.close().timeout(_requestTimeout);
    switch (response.statusCode) {
      case HttpStatus.ok:
        return await _decode(response);
      case HttpStatus.forbidden:
        throw const FormatException('对端已重新开启同步，请重新搜索后再试。');
      case HttpStatus.conflict:
        final reason = await _readBody(response);
        throw FormatException(reason.isEmpty ? '对端正在处理记录，请稍后再试。' : reason);
      default:
        throw const FormatException('对端未完成同步，请稍后重试。');
    }
  } on TimeoutException {
    throw const FormatException('已找到设备，但同步请求超时。请确认对方的账本已打开，并检查局域网连接。');
  } on SocketException {
    throw const FormatException('连不上设备，请检查局域网连接及 Windows 防火墙。');
  } finally {
    client.close(force: true);
  }
}
