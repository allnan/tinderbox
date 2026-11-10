import 'resource_calculator.dart';

DateTime calendarDate(DateTime date) =>
    DateTime(date.year, date.month, date.day);

/// A game day starts at 04:00 in the device's local time.
DateTime gameDay(DateTime timestamp) =>
    calendarDate(timestamp.toLocal().subtract(const Duration(hours: 4)));

String dateKey(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-'
    '${date.month.toString().padLeft(2, '0')}-'
    '${date.day.toString().padLeft(2, '0')}';

int daysBetween(DateTime start, DateTime end) => DateTime.utc(
  end.year,
  end.month,
  end.day,
).difference(DateTime.utc(start.year, start.month, start.day)).inDays;

class ResourceRecord {
  ResourceRecord({
    String? id,
    required DateTime date,
    required DateTime savedAt,
    DateTime? recordedAt,
    required this.inventory,
    this.originiumUse = OriginiumUse.character,
    this.note = '',
    this.includedInTrend = true,
  }) : date = calendarDate(date),
       savedAt = savedAt.toLocal(),
       recordedAt = (recordedAt ?? savedAt).toLocal(),
       id =
           id ??
           'record-${(recordedAt ?? savedAt).microsecondsSinceEpoch}-${dateKey(date)}';

  final String id;

  /// The game day selected for this snapshot; independent of later edits.
  final DateTime date;

  /// Original capture time, retained when editing a historical snapshot.
  final DateTime recordedAt;
  final DateTime savedAt;
  final ResourceInventory inventory;
  final OriginiumUse originiumUse;
  final String note;
  final bool includedInTrend;
  bool get isBackfill => dateKey(gameDay(recordedAt)) != dateKey(date);

  ResourceRecord withTrend(bool included) => ResourceRecord(
    id: id,
    date: date,
    recordedAt: recordedAt,
    savedAt: savedAt,
    inventory: inventory,
    originiumUse: originiumUse,
    note: note,
    includedInTrend: included,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'date': dateKey(date),
    'recordedAt': recordedAt.toIso8601String(),
    'savedAt': savedAt.toIso8601String(),
    'inventory': inventory.toJson(),
    'originiumUse': originiumUse.name,
    'note': note,
    'includedInTrend': includedInTrend,
  };

  factory ResourceRecord.fromJson(
    Map<String, dynamic> json, {
    bool legacy = false,
  }) {
    final dateText = json['date'];
    final savedText = json['savedAt'];
    final recordedText = legacy ? savedText : json['recordedAt'];
    final inventory = json['inventory'];
    final use = json['originiumUse'];
    final note = json['note'];
    final included = json['includedInTrend'];
    final date = dateText is String ? DateTime.tryParse(dateText) : null;
    final savedAt = savedText is String
        ? DateTime.tryParse(savedText)?.toLocal()
        : null;
    final recordedAt = recordedText is String
        ? DateTime.tryParse(recordedText)?.toLocal()
        : null;
    if (date == null ||
        date.year < 2026 ||
        dateKey(date) != dateText ||
        savedAt == null ||
        recordedAt == null ||
        inventory is! Map<String, dynamic> ||
        note is! String ||
        note.length > 120 ||
        included is! bool ||
        !OriginiumUse.values.any((item) => item.name == use)) {
      throw const FormatException('记录格式无效');
    }
    final id = legacy
        ? 'legacy-$dateText-${savedAt.microsecondsSinceEpoch}'
        : json['id'];
    if (id is! String || id.isEmpty || id.length > 160) {
      throw const FormatException('记录编号无效');
    }
    // V1 defaulted to the calendar date. Reclassify ordinary saves by 04:00;
    // explicitly backdated V1 snapshots keep the date selected by the user.
    final assignedDay = legacy && dateKey(date) == dateKey(savedAt)
        ? gameDay(savedAt)
        : calendarDate(date);
    return ResourceRecord(
      id: id,
      date: assignedDay,
      recordedAt: recordedAt,
      savedAt: savedAt,
      inventory: ResourceInventory.fromJson(inventory),
      originiumUse: OriginiumUse.values.byName(use as String),
      note: note,
      includedInTrend: included,
    );
  }
}

class RecordDay {
  RecordDay(this.date, Iterable<ResourceRecord> records)
    : records = List.unmodifiable(records);
  final DateTime date;
  final List<ResourceRecord> records;
  ResourceRecord get latest => records.last;
  ResourceRecord? get latestValid {
    for (final record in records.reversed) {
      if (record.includedInTrend) return record;
    }
    return null;
  }
}

class ResourceLedger {
  ResourceLedger([Iterable<ResourceRecord> records = const []])
    : this._(records, const []);

  ResourceLedger._(
    Iterable<ResourceRecord> records,
    Iterable<ResourceRecord> syncedTrend,
  ) : records = List.unmodifiable(records.toList()..sort(_compareRecords)),
      syncedTrend = List.unmodifiable(
        syncedTrend.toList()..sort(_compareRecords),
      ) {
    if (this.records.map((item) => item.id).toSet().length !=
        this.records.length) {
      throw const FormatException('存在重复的记录编号');
    }
  }

  static const schemaVersion = 2;

  static int _compareRecords(ResourceRecord a, ResourceRecord b) {
    final day = a.date.compareTo(b.date);
    if (day != 0) return day;
    final time = a.recordedAt.compareTo(b.recordedAt);
    if (time != 0) return time;
    return a.id.compareTo(b.id);
  }

  final List<ResourceRecord> records;
  final List<ResourceRecord> syncedTrend;
  ResourceRecord? get latest => records.isEmpty ? null : records.last;
  int get includedCount => records.where((r) => r.includedInTrend).length;

  List<RecordDay> get days {
    final grouped = <String, List<ResourceRecord>>{};
    for (final record in records) {
      (grouped[dateKey(record.date)] ??= []).add(record);
    }
    return [
      for (final group in grouped.values) RecordDay(group.first.date, group),
    ];
  }

  List<ResourceRecord> get dailyRecords => [
    for (final day in days)
      if (day.latestValid != null) day.latestValid!,
  ];

  List<ResourceRecord> get trendDailyRecords {
    final excluded = {
      for (final item in records)
        if (!item.includedInTrend) item.id,
    };
    final days = {
      for (final item in syncedTrend)
        if (!excluded.contains(item.id)) dateKey(item.date): item,
    };
    for (final item in dailyRecords) {
      final key = dateKey(item.date);
      final remote = days[key];
      final order = remote == null ? 1 : _compareRecords(item, remote);
      if (order > 0 ||
          (order == 0 && !item.savedAt.isBefore(remote!.savedAt))) {
        days[key] = item;
      }
    }
    return days.values.toList()..sort(_compareRecords);
  }

  ResourceRecord? byId(String id) {
    for (final record in records) {
      if (record.id == id) return record;
    }
    return null;
  }

  ResourceRecord? onDate(DateTime date) {
    final key = dateKey(date);
    for (final record in records.reversed) {
      if (dateKey(record.date) == key) return record;
    }
    return null;
  }

  String nextRecordId(DateTime timestamp) {
    final prefix = 'record-${timestamp.microsecondsSinceEpoch}-';
    var sequence = 0;
    // Replacing a daily record can leave gaps in the sequence.
    for (final record in records) {
      if (!record.id.startsWith(prefix)) continue;
      final suffix = int.tryParse(record.id.substring(prefix.length));
      if (suffix != null && suffix >= sequence) sequence = suffix + 1;
    }
    return '$prefix${sequence.toString().padLeft(6, '0')}';
  }

  ResourceLedger saveCapture(ResourceRecord record) {
    if (record.note.trim().isNotEmpty) return upsert(record);
    return ResourceLedger._([
      for (final item in records)
        if (item.date != record.date || item.note.trim().isNotEmpty) item,
      record,
    ], syncedTrend);
  }

  ResourceLedger upsert(ResourceRecord record) => ResourceLedger._([
    for (final item in records)
      if (item.id != record.id) item,
    record,
  ], syncedTrend);

  ResourceLedger syncLatest(ResourceRecord? peer) {
    if (peer == null) return this;
    final local = latest;
    if (local != null) {
      final order = _compareRecords(peer, local);
      if (order < 0) return this;
      if (order == 0 && !peer.savedAt.isAfter(local.savedAt)) {
        if (peer.savedAt.isAtSameMomentAs(local.savedAt) &&
            (peer.inventory != local.inventory ||
                peer.note != local.note ||
                peer.originiumUse != local.originiumUse)) {
          throw StateError('两端同一笔记录的内容不同，请在要保留的一端重新保存后再同步。');
        }
        return this;
      }
    }
    return remove(peer.id).saveCapture(peer);
  }

  ResourceLedger withSyncedTrend(List<ResourceRecord>? peer) {
    if (peer == null) return this;
    final ordered = peer.toList()..sort(_compareRecords);
    if (ordered.length == syncedTrend.length) {
      var same = true;
      for (var i = 0; i < ordered.length; i++) {
        final previous = syncedTrend[i];
        final next = ordered[i];
        if (_compareRecords(previous, next) != 0 ||
            previous.savedAt != next.savedAt ||
            previous.inventory != next.inventory) {
          same = false;
          break;
        }
      }
      if (same) return this;
    }
    return ResourceLedger._(records, ordered);
  }

  ResourceLedger remove(String id) =>
      ResourceLedger._(records.where((item) => item.id != id), syncedTrend);

  Map<String, dynamic> toJson() => {
    'schemaVersion': schemaVersion,
    'records': records.map((item) => item.toJson()).toList(),
    if (syncedTrend.isNotEmpty)
      'syncedTrend': syncedTrend.map((item) => item.toJson()).toList(),
  };

  factory ResourceLedger.fromJson(dynamic json) {
    if (json is! Map<String, dynamic> ||
        ![1, schemaVersion].contains(json['schemaVersion']) ||
        json['records'] is! List) {
      throw const FormatException('数据版本或格式不受支持');
    }
    final legacy = json['schemaVersion'] == 1;
    final trend = json['syncedTrend'];
    return ResourceLedger._([
      for (final item in json['records'] as List)
        if (item is Map<String, dynamic>)
          ResourceRecord.fromJson(item, legacy: legacy)
        else
          throw const FormatException('记录格式无效'),
    ], trend == null ? const [] : decodeTrendSummaries(trend));
  }
}

List<ResourceRecord> decodeTrendSummaries(dynamic data) {
  if (data is! List) throw const FormatException('日汇总格式无效');
  final records = <ResourceRecord>[];
  final dates = <String>{};
  for (final item in data) {
    if (item is! Map<String, dynamic>) throw const FormatException('日汇总格式无效');
    final record = ResourceRecord.fromJson(item);
    if (!record.includedInTrend ||
        record.note.isNotEmpty ||
        !dates.add(dateKey(record.date))) {
      throw const FormatException('日汇总格式无效');
    }
    records.add(record);
  }
  return records;
}

enum TrendMode { change, balance }

class TrendPoint {
  const TrendPoint({
    required this.date,
    required this.value,
    this.previousDate,
  });
  final DateTime date;
  final DateTime? previousDate;
  final int value;
  int get intervalDays =>
      previousDate == null ? 0 : daysBetween(previousDate!, date);
}

List<TrendPoint> buildTrend(
  ResourceLedger ledger,
  ResourceKind kind,
  TrendMode mode, {
  DateTime? today,
  int rangeDays = 0,
}) {
  final daily = ledger.trendDailyRecords;
  final records = today == null
      ? daily
      : daily.where((record) {
          final age = daysBetween(record.date, today);
          return age >= 0 && (rangeDays == 0 || age < rangeDays);
        }).toList();
  if (mode == TrendMode.balance) {
    return [
      for (final record in records)
        TrendPoint(date: record.date, value: kind.valueOf(record.inventory)),
    ];
  }
  return [
    for (var i = 1; i < records.length; i++)
      TrendPoint(
        date: records[i].date,
        previousDate: records[i - 1].date,
        value:
            kind.valueOf(records[i].inventory) -
            kind.valueOf(records[i - 1].inventory),
      ),
  ];
}
