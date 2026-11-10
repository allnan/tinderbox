import 'dart:convert';
import 'dart:io';

import 'resource_history.dart';

abstract class ResourceStore {
  String get location;
  String? get recoveryNotice => null;
  Future<ResourceLedger> load();
  Future<void> save(ResourceLedger ledger);
}

/// Stores the ledger and its backups together in the supplied directory.
class PortableResourceStore extends ResourceStore {
  PortableResourceStore(Directory directory)
    : file = File(
        '${directory.absolute.path}${Platform.pathSeparator}endfield_resources.json',
      );

  factory PortableResourceStore.besideExecutable() =>
      PortableResourceStore(File(Platform.resolvedExecutable).parent);

  final File file;
  String? _lastRaw;
  bool _loaded = false;
  bool _recovered = false;
  String? _legacyRaw;

  ResourceLedger _decode(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is Map<String, dynamic> &&
        decoded['schemaVersion'] is int &&
        decoded['schemaVersion'] > ResourceLedger.schemaVersion) {
      throw UnsupportedError('数据来自较新版本，请使用相应版本打开。原文件已保留。');
    }
    final ledger = ResourceLedger.fromJson(decoded);
    if (decoded['schemaVersion'] == 1) _legacyRaw = raw;
    return ledger;
  }

  @override
  String get location => file.path;
  @override
  String? get recoveryNotice =>
      _recovered ? '主数据文件无法读取，已载入同目录的上一次备份。保存时会保留损坏文件。' : null;

  @override
  Future<ResourceLedger> load() async {
    _loaded = false;
    _legacyRaw = null;
    _lastRaw = await file.exists() ? await file.readAsString() : null;
    _recovered = false;
    try {
      if (_lastRaw != null) {
        final ledger = _decode(_lastRaw!);
        _loaded = true;
        return ledger;
      }
      if (!await File('${file.path}.bak').exists()) {
        _loaded = true;
        return ResourceLedger();
      }
    } on FormatException {
      // Try the last known-good save without changing either file.
    }
    final backup = File('${file.path}.bak');
    if (await backup.exists()) {
      try {
        final ledger = _decode(await backup.readAsString());
        _recovered = true;
        _loaded = true;
        return ledger;
      } on FormatException {
        throw const FormatException('数据与备份均无法读取，请保留文件并检查内容。');
      }
    }
    throw const FormatException('数据文件无法读取。原文件已保留，请检查后重试。');
  }

  @override
  Future<void> save(ResourceLedger ledger) async {
    if (!_loaded) throw StateError('必须先读取数据再保存');
    final lock = await File('${file.path}.lock').open(mode: FileMode.append);
    try {
      await lock.lock(FileLock.exclusive);
      final current = await file.exists() ? await file.readAsString() : null;
      if (current != _lastRaw) {
        throw StateError('另一个窗口已更改数据，请重新打开应用后再保存。');
      }
      final raw =
          '${const JsonEncoder.withIndent('  ').convert(ledger.toJson())}\n';
      final temporary = File('${file.path}.tmp');
      await temporary.writeAsString(raw, flush: true);
      if (_legacyRaw != null) {
        final original = File('${file.path}.pre-v2.bak');
        if (!await original.exists()) {
          await original.writeAsString(_legacyRaw!, flush: true);
        }
      }
      if (current != null) {
        if (_recovered) {
          await file.copy(
            '${file.path}.corrupt-${DateTime.now().microsecondsSinceEpoch}',
          );
        } else {
          await file.copy('${file.path}.bak');
        }
      }
      await temporary.rename(file.path);
      _lastRaw = raw;
      _recovered = false;
      _legacyRaw = null;
    } finally {
      await lock.close();
    }
  }
}

class MemoryResourceStore extends ResourceStore {
  MemoryResourceStore([ResourceLedger? ledger])
    : ledger = ledger ?? ResourceLedger();
  ResourceLedger ledger;
  int saveCount = 0;
  @override
  String get location => '内存测试数据';
  @override
  Future<ResourceLedger> load() async => ledger;
  @override
  Future<void> save(ResourceLedger ledger) async {
    this.ledger = ledger;
    saveCount++;
  }
}
