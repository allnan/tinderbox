import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'lan_sync.dart';
import 'resource_calculator.dart';
import 'resource_history.dart';
import 'resource_store.dart';
import 'ui/app_theme.dart';
import 'ui/lan_sync_dialog.dart';
import 'ui/resource_cards.dart';
import 'ui/trend_panel.dart';

const _platform = MethodChannel('com.endfield.tools/platform');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = Platform.isAndroid
      ? PortableResourceStore(
          Directory((await _platform.invokeMethod<String>('dataDirectory'))!),
        )
      : PortableResourceStore.besideExecutable();
  runApp(
    EndfieldResourceApp(
      store: store,
      hostLanSync: Platform.isWindows || Platform.isAndroid,
    ),
  );
}

class EndfieldResourceApp extends StatelessWidget {
  const EndfieldResourceApp({
    super.key,
    required this.store,
    this.now,
    this.hostLanSync = false,
  });
  final ResourceStore store;
  final DateTime Function()? now;
  final bool hostLanSync;

  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    title: '终末地资源账本',
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    theme: appTheme(),
    home: ResourceDashboard(
      store: store,
      now: now ?? DateTime.now,
      hostLanSync: hostLanSync,
    ),
  );
}

class ResourceDashboard extends StatefulWidget {
  const ResourceDashboard({
    super.key,
    required this.store,
    required this.now,
    this.hostLanSync = false,
  });
  final ResourceStore store;
  final DateTime Function() now;
  final bool hostLanSync;

  @override
  State<ResourceDashboard> createState() => _ResourceDashboardState();
}

class _ResourceDashboardState extends State<ResourceDashboard>
    with WidgetsBindingObserver {
  final _controllers = {
    for (final kind in ResourceKind.values)
      kind: TextEditingController(text: '0'),
  };
  final _note = TextEditingController();
  final _noteFocus = FocusNode();
  final _scroll = ScrollController();
  ResourceLedger _ledger = ResourceLedger();
  OriginiumUse _use = OriginiumUse.character;
  DateTime get _date => gameDay(widget.now());
  ResourceRecord? _draftBaseline;
  Timer? _clockRefresh;
  Timer? _lanPoll;
  LanSyncHost? _lanHost;
  List<InternetAddress> _lanAddresses = [];
  String? _lanError;
  bool _lanStarting = false;
  bool _loaded = false;
  bool _saving = false;
  bool _syncOpen = false;
  String? _error;

  LanSyncDevice get _lanDevice =>
      Platform.isAndroid ? LanSyncDevice.phone : LanSyncDevice.computer;

  bool get _valid => _controllers.values.every(
    (c) => ResourceInventory.parseAmount(c.text) != null,
  );
  ResourceInventory get _inventory => ResourceInventory(
    charteredPermits:
        ResourceInventory.parseAmount(
          _controllers[ResourceKind.permits]!.text,
        ) ??
        0,
    protoOriginium:
        ResourceInventory.parseAmount(
          _controllers[ResourceKind.originium]!.text,
        ) ??
        0,
    oroberyl:
        ResourceInventory.parseAmount(
          _controllers[ResourceKind.oroberyl]!.text,
        ) ??
        0,
    arsenalQuota:
        ResourceInventory.parseAmount(_controllers[ResourceKind.quota]!.text) ??
        0,
  );
  bool get _dirty {
    final saved = _draftBaseline;
    return saved == null ||
        !_valid ||
        dateKey(saved.date) != dateKey(_date) ||
        saved.inventory != _inventory ||
        saved.originiumUse != _use ||
        _note.text.trim().isNotEmpty;
  }

  bool get _hasUnsavedInput {
    final baseline = _draftBaseline;
    return !_valid ||
        _inventory != (baseline?.inventory ?? const ResourceInventory()) ||
        _use != (baseline?.originiumUse ?? OriginiumUse.character) ||
        _note.text.trim().isNotEmpty;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _clockRefresh = Timer.periodic(const Duration(minutes: 1), (_) {
      if (mounted) setState(() {});
    });
    _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      setState(() {});
      if (widget.hostLanSync) unawaited(_refreshLanHost());
    }
  }

  Future<void> _load() async {
    setState(() {
      _loaded = false;
      _error = null;
    });
    try {
      final ledger = await widget.store.load();
      if (!mounted) return;
      setState(() {
        _ledger = ledger;
        final latest = ledger.latest;
        if (latest != null) {
          _fill(latest);
          _draftBaseline = latest;
        }
        _loaded = true;
      });
      if (widget.hostLanSync) {
        unawaited(_refreshLanHost());
        _lanPoll ??= Timer.periodic(
          const Duration(seconds: 10),
          (_) => unawaited(_refreshLanHost()),
        );
      }
    } catch (error) {
      if (mounted) setState(() => _error = '读取失败：${_errorText(error)}');
    }
  }

  void _fill(ResourceRecord record) {
    for (final kind in ResourceKind.values) {
      _controllers[kind]!.text = kind.valueOf(record.inventory).toString();
    }
    _use = record.originiumUse;
    _note.clear();
  }

  String _errorText(Object error) => switch (error) {
    FileSystemException e =>
      Platform.isAndroid
          ? '无法访问应用存储，请检查手机剩余空间。${e.osError?.message ?? ''}'
          : '无法访问应用目录，请将整个应用文件夹放到可读写的位置。${e.osError?.message ?? ''}',
    FormatException e => e.message,
    StateError e => e.message.toString(),
    _ => error.toString(),
  };

  void _message(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(content: Text(text), duration: const Duration(seconds: 4)),
      );
  }

  Future<bool> _persist(ResourceLedger next) async {
    if (!_loaded || _saving) return false;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.store.save(next);
      if (!mounted) return false;
      setState(() => _ledger = next);
      return true;
    } catch (error) {
      if (mounted) {
        setState(() => _error = '保存失败：${_errorText(error)}');
        _message('保存失败，输入已保留。${_errorText(error)}');
      }
      return false;
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _save() async {
    if (!_loaded || _saving || _syncOpen || !_valid) return;
    final now = widget.now();
    final record = ResourceRecord(
      id: _ledger.nextRecordId(now),
      date: gameDay(now),
      savedAt: now,
      inventory: _inventory,
      originiumUse: _use,
      note: _note.text.trim(),
    );
    if (!await _persist(_ledger.saveCapture(record)) || !mounted) return;
    setState(() {
      _draftBaseline = record;
      _note.clear();
    });
    final action = record.note.isEmpty ? '已保存当天默认记录' : '已保存备注记录';
    _message(
      '$action · ${displayDate(record.date)} 游戏日 · ${clockTime(record.recordedAt)}',
    );
  }

  void _restoreDraft() {
    final record = _draftBaseline ?? _ledger.latest;
    setState(() {
      if (record != null) {
        _fill(record);
      } else {
        for (final controller in _controllers.values) {
          controller.text = '0';
        }
        _note.clear();
        _use = OriginiumUse.character;
      }
    });
  }

  Future<void> _showStorage() async {
    final openSync = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(Platform.isAndroid ? '本机存储' : '便携存储'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                Platform.isAndroid
                    ? '记录保存在手机上该应用的私有目录中。'
                    : '记录保存在应用程序旁的 JSON 文件中。移动或备份时，保留整个应用文件夹即可。',
              ),
              const SizedBox(height: 16),
              SelectableText(
                widget.store.location,
                style: const TextStyle(fontSize: 12, color: AppColors.accent),
              ),
              const SizedBox(height: 16),
              const Text(
                '保存和局域网同步时会写入本机账本。写入时保留上一版本的 .bak 备份。',
                style: TextStyle(
                  fontSize: 12,
                  color: AppColors.muted,
                  height: 1.7,
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton.icon(
            onPressed: _loaded && !_saving
                ? () => Navigator.pop(context, true)
                : null,
            icon: const Icon(Icons.sync_rounded, size: 18),
            label: const Text('局域网同步'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('知道了'),
          ),
        ],
      ),
    );
    if (openSync == true && mounted) await _showLanSync();
  }

  Future<void> _refreshLanHost([InternetAddress? selected]) async {
    if (!mounted || !_loaded || _lanStarting || _saving) return;
    _lanStarting = true;
    try {
      final addresses = await lanSyncAddresses();
      if (!mounted) return;
      _lanAddresses = addresses;
      final previous = _lanHost;
      final address = addresses.contains(selected)
          ? selected
          : addresses.contains(previous?.address)
          ? previous?.address
          : addresses.firstOrNull;
      if (previous != null && previous.address != address) {
        _lanHost = null;
        await previous.close();
      }
      if (!mounted) return;
      if (address == null) {
        _lanError = '未找到局域网地址，连上 Wi-Fi 后会自动重试。';
        return;
      }
      if (_lanHost == null) {
        final host = await LanSyncHost.start(
          address,
          _applySyncedRecord,
          device: _lanDevice,
          deviceName: Platform.isAndroid
              ? await _platform.invokeMethod<String>('deviceName')
              : null,
        );
        if (!mounted) {
          await host.close();
          return;
        }
        _lanHost = host;
      }
      _lanError = null;
    } on SocketException catch (error) {
      _lanError = error.osError?.errorCode == 10048
          ? '同步端口被占用，请关闭其他账本窗口。'
          : '暂时无法开启局域网同步，请检查本机网络。';
    } finally {
      _lanStarting = false;
    }
  }

  Widget _lanHostStatus() => StatefulBuilder(
    builder: (context, refresh) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Divider(height: 24),
        Text(
          _lanHost == null
              ? _lanError ?? '正在开启局域网同步…'
              : '本机「${_lanHost!.name}」可被发现',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        if (_lanAddresses.length > 1)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('切换电脑网络'),
            children: [
              DropdownButtonFormField<InternetAddress>(
                initialValue: _lanHost?.address,
                isExpanded: true,
                items: [
                  for (final address in _lanAddresses)
                    DropdownMenuItem(
                      value: address,
                      child: Text(address.address),
                    ),
                ],
                onChanged: (address) async {
                  await _refreshLanHost(address);
                  if (context.mounted) refresh(() {});
                },
              ),
            ],
          ),
        if (_lanHost == null)
          TextButton(
            onPressed: () async {
              await _refreshLanHost();
              if (context.mounted) refresh(() {});
            },
            child: const Text('重新检查本机'),
          ),
      ],
    ),
  );

  LanSyncSnapshot get _syncSnapshot =>
      (latest: _ledger.latest, daily: _ledger.dailyRecords);

  Future<List<InternetAddress>> _windowsSubnetBroadcasts() async {
    final addresses = await _platform.invokeListMethod<String>(
      'subnetBroadcasts',
    );
    return (addresses ?? const []).map(InternetAddress.new).toList();
  }

  Future<void> _showLanSync() async {
    if (!_loaded || _saving || _syncOpen) return;
    if (_hasUnsavedInput) {
      _message('请先保存或还原当前输入，再打开局域网同步。');
      return;
    }
    _syncOpen = true;
    try {
      if (widget.hostLanSync) await _refreshLanHost();
      if (!mounted) return;
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (_) => LanSyncDialog(
          target: _lanDevice == LanSyncDevice.phone
              ? LanSyncDevice.computer
              : LanSyncDevice.phone,
          hostStatus: widget.hostLanSync && _lanDevice == LanSyncDevice.computer
              ? _lanHostStatus()
              : null,
          subnetBroadcasts: widget.hostLanSync && Platform.isWindows
              ? _windowsSubnetBroadcasts
              : null,
          snapshot: () => _syncSnapshot,
          applySnapshot: _applySyncedRecord,
        ),
      );
    } finally {
      _syncOpen = false;
    }
  }

  Future<LanSyncApplied> _applySyncedRecord(LanSyncSnapshot peer) async {
    if (!mounted || !_loaded || _saving) {
      throw StateError('设备正在读取或保存记录，请稍后再同步。');
    }
    if (_hasUnsavedInput) {
      throw StateError('请先保存或还原未保存的输入，再同步。');
    }
    final previous = _ledger.latest;
    final next = _ledger.syncLatest(peer.latest).withSyncedTrend(peer.daily);
    final result = (
      snapshot: (latest: next.latest, daily: next.dailyRecords),
      changes: LanSyncChanges.between(_ledger, next),
    );
    if (identical(next, _ledger)) return result;
    if (!await _persist(next)) throw StateError('本机保存失败，请检查存储后重试。');
    if (mounted && !identical(previous, next.latest)) {
      setState(() {
        _draftBaseline = next.latest;
        if (_draftBaseline != null) _fill(_draftBaseline!);
      });
    }
    return result;
  }

  void _showRules() => showDialog<void>(
    context: context,
    builder: (context) => const RulesDialog(),
  );

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _clockRefresh?.cancel();
    _lanPoll?.cancel();
    final host = _lanHost;
    if (host != null) unawaited(host.close());
    for (final controller in _controllers.values) {
      controller.dispose();
    }
    _note.dispose();
    _noteFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.keyS, control: true): _save,
    },
    child: Focus(
      autofocus: true,
      child: Scaffold(
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final desktop = constraints.maxWidth >= 1050;
              final compact = constraints.maxWidth < 680;
              final horizontalPadding = desktop
                  ? 32.0
                  : (compact ? 14.0 : 20.0);
              return Row(
                children: [
                  if (desktop)
                    _NavigationRail(
                      onHome: () => _scroll.animateTo(
                        0,
                        duration: const Duration(milliseconds: 250),
                        curve: Curves.easeOut,
                      ),
                      onRules: _showRules,
                      onStorage: _showStorage,
                    ),
                  Expanded(
                    child: Scrollbar(
                      controller: _scroll,
                      child: SingleChildScrollView(
                        controller: _scroll,
                        padding: EdgeInsets.fromLTRB(
                          horizontalPadding,
                          compact ? 8 : 28,
                          horizontalPadding,
                          24,
                        ),
                        child: Center(
                          child: ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 1320),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                _header(desktop: desktop, compact: compact),
                                if (_error != null) ...[
                                  const SizedBox(height: 18),
                                  SurfacePanel(
                                    padding: const EdgeInsets.all(14),
                                    borderColor: AppColors.error.withValues(
                                      alpha: .4,
                                    ),
                                    child: Row(
                                      children: [
                                        const Icon(
                                          Icons.error_outline,
                                          color: AppColors.error,
                                          size: 20,
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Text(
                                            _error!,
                                            style: const TextStyle(
                                              color: AppColors.error,
                                              fontSize: 12,
                                            ),
                                          ),
                                        ),
                                        if (!_loaded)
                                          TextButton(
                                            onPressed: _load,
                                            child: const Text('重试'),
                                          ),
                                      ],
                                    ),
                                  ),
                                ],
                                if (widget.store.recoveryNotice != null) ...[
                                  const SizedBox(height: 14),
                                  Text(
                                    widget.store.recoveryNotice!,
                                    style: const TextStyle(
                                      color: AppColors.orange,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                                SizedBox(height: compact ? 8 : 24),
                                _budgetSection(compact: compact),
                                SizedBox(height: compact ? 14 : 25),
                                _inputHeading(compact: compact),
                                SizedBox(height: compact ? 6 : 14),
                                _inputCards(compact: compact),
                                SizedBox(height: compact ? 8 : 14),
                                _saveBar(compact: compact),
                                SizedBox(height: compact ? 14 : 24),
                                TrendPanel(
                                  ledger: _ledger,
                                  today: gameDay(widget.now()),
                                ),
                                const SizedBox(height: 22),
                                Wrap(
                                  alignment: WrapAlignment.spaceBetween,
                                  spacing: 16,
                                  runSpacing: 8,
                                  children: [
                                    Text(
                                      'ENDFIELD  /  RESOURCE JOURNAL',
                                      style: TextStyle(
                                        fontFamily: 'Segoe UI',
                                        fontSize: 10,
                                        color: AppColors.muted.withValues(
                                          alpha: .7,
                                        ),
                                        letterSpacing: 1.7,
                                      ),
                                    ),
                                    const Text(
                                      '本地记录 · 手动确认 · 非官方玩家工具',
                                      style: TextStyle(
                                        fontSize: 10,
                                        color: AppColors.muted,
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    ),
  );

  Widget _header({required bool desktop, required bool compact}) => Row(
    crossAxisAlignment: compact
        ? CrossAxisAlignment.center
        : CrossAxisAlignment.start,
    children: [
      Expanded(
        child: compact
            ? const Text(
                '终末地资源账本',
                style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'TALOS-II  /  PERSONAL TERMINAL',
                    style: TextStyle(
                      fontFamily: 'Segoe UI',
                      fontSize: 10,
                      letterSpacing: 2,
                      color: AppColors.accent,
                    ),
                  ),
                  const SizedBox(height: 7),
                  Text(
                    '终末地资源账本',
                    style: Theme.of(context).textTheme.headlineLarge,
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    '明日方舟：终末地 · 让每一份积累清晰可见',
                    style: TextStyle(fontSize: 12, color: AppColors.muted),
                  ),
                ],
              ),
      ),
      const SizedBox(width: 10),
      if (desktop)
        OutlinedButton.icon(
          onPressed: _showStorage,
          icon: const Icon(Icons.folder_outlined, size: 16),
          label: Text(
            Platform.isAndroid ? '本机存储' : '便携存储',
            style: const TextStyle(fontSize: 12),
          ),
        )
      else
        Wrap(
          children: [
            IconButton(
              tooltip: '换算规则',
              onPressed: _showRules,
              icon: Icon(Icons.info_outline, size: compact ? 20 : 24),
            ),
            IconButton(
              tooltip: '数据位置',
              onPressed: _showStorage,
              icon: Icon(Icons.folder_outlined, size: compact ? 20 : 24),
            ),
          ],
        ),
    ],
  );

  Widget _budgetSection({required bool compact}) {
    final budget = _inventory.budget(_use);
    final character = BudgetCard(
      budget: budget,
      character: true,
      valid: _loaded && _valid,
      compact: compact,
    );
    final arsenal = BudgetCard(
      budget: budget,
      character: false,
      valid: _loaded && _valid,
      compact: compact,
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 256) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [character, const SizedBox(height: 14), arsenal],
          );
        }
        return IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: character),
              SizedBox(width: compact ? 8 : 18),
              Expanded(child: arsenal),
            ],
          ),
        );
      },
    );
  }

  Widget _inputHeading({required bool compact}) {
    final heading = Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: compact ? 8 : 12,
      runSpacing: 4,
      children: [
        Text(
          '当前资源',
          style: Theme.of(
            context,
          ).textTheme.titleLarge?.copyWith(fontSize: compact ? 16 : null),
        ),
        if (!_loaded)
          const StatusTag('读取中')
        else if (!_dirty)
          const StatusTag('已记录'),
      ],
    );
    return Wrap(
      alignment: WrapAlignment.spaceBetween,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 8,
      children: [
        heading,
        Wrap(
          key: const ValueKey('originium-use'),
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 2,
          children: [
            const Padding(
              padding: EdgeInsets.only(right: 4),
              child: Text(
                '源石计入',
                style: TextStyle(fontSize: 11, color: AppColors.muted),
              ),
            ),
            for (final use in OriginiumUse.values)
              ChoiceChip(
                label: Text(use.label),
                tooltip: use == OriginiumUse.reserve
                    ? '保留源石'
                    : '源石计入${use.label}',
                selected: _use == use,
                showCheckmark: false,
                side: BorderSide.none,
                shape: const StadiumBorder(),
                backgroundColor: AppColors.background,
                disabledColor: AppColors.background,
                selectedColor: Color.alphaBlend(
                  AppColors.orange.withValues(alpha: .12),
                  AppColors.background,
                ),
                padding: EdgeInsets.zero,
                labelPadding: const EdgeInsets.symmetric(horizontal: 10),
                materialTapTargetSize: MaterialTapTargetSize.padded,
                labelStyle: TextStyle(
                  fontFamily: 'Microsoft YaHei UI',
                  fontSize: 12,
                  fontWeight: _use == use ? FontWeight.w600 : FontWeight.w400,
                  color: _use == use ? AppColors.orange : AppColors.muted,
                ),
                onSelected: _loaded && !_saving
                    ? (selected) {
                        if (selected) setState(() => _use = use);
                      }
                    : null,
              ),
          ],
        ),
      ],
    );
  }

  Widget _inputCards({required bool compact}) => LayoutBuilder(
    builder: (context, constraints) {
      final count = constraints.maxWidth >= 970
          ? 4
          : constraints.maxWidth >= 256
          ? 2
          : 1;
      final gap = compact ? 8.0 : 12.0;
      final width = (constraints.maxWidth - gap * (count - 1)) / count;
      return Wrap(
        spacing: gap,
        runSpacing: gap,
        children: [
          for (final kind in ResourceKind.values)
            SizedBox(
              width: width,
              child: ResourceInputCard(
                kind: kind,
                controller: _controllers[kind]!,
                use: _use,
                enabled: _loaded && !_saving,
                onChanged: (_) => setState(() {}),
                compact: compact,
              ),
            ),
        ],
      );
    },
  );

  Widget _saveBar({required bool compact}) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Row(
        children: [
          const Icon(
            Icons.calendar_today_outlined,
            size: 14,
            color: AppColors.muted,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              '${displayDate(_date)} 游戏日',
              key: const ValueKey('record-date'),
              style: const TextStyle(color: AppColors.muted, fontSize: 12),
            ),
          ),
          IconButton(
            key: const ValueKey('restore-input'),
            tooltip: '还原到已保存的资源',
            onPressed: _loaded && !_saving && _dirty ? _restoreDraft : null,
            icon: const Icon(Icons.undo_rounded, size: 19),
          ),
        ],
      ),
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const ValueKey('record-note'),
                  controller: _note,
                  focusNode: _noteFocus,
                  enabled: _loaded && !_saving,
                  maxLength: 120,
                  onChanged: (_) => setState(() {}),
                  onTapOutside: (_) => _noteFocus.unfocus(),
                  style: const TextStyle(fontSize: 13),
                  decoration: const InputDecoration(
                    hintText: '备注（可选）',
                    constraints: BoxConstraints(minHeight: 48),
                    counterText: '',
                    contentPadding: EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 12,
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Text(
                    compact
                        ? '无备注更新当天 · 有备注单独保留 · 04:00 换日'
                        : '无备注更新当天默认记录 · 有备注单独保留 · 每天 04:00 切换游戏日${Platform.isAndroid ? '' : ' · Ctrl + S 保存'}',
                    key: const ValueKey('record-hint'),
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.6,
                      color: AppColors.muted,
                    ),
                  ),
                ),
              ],
            ),
          ),
          SizedBox(width: compact ? 8 : 12),
          FilledButton(
            key: const ValueKey('save-record'),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xFF243528),
              foregroundColor: AppColors.accent,
              minimumSize: const Size(76, 48),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              tapTargetSize: MaterialTapTargetSize.padded,
            ),
            onPressed: _loaded && !_saving && _valid ? _save : null,
            child: Text(_saving ? '保存中' : '保存记录'),
          ),
        ],
      ),
    ],
  );
}

class _NavigationRail extends StatelessWidget {
  const _NavigationRail({
    required this.onHome,
    required this.onRules,
    required this.onStorage,
  });
  final VoidCallback onHome;
  final VoidCallback onRules;
  final VoidCallback onStorage;

  Widget item(
    IconData icon,
    String label,
    VoidCallback action, {
    bool selected = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 14),
    child: Tooltip(
      message: label,
      child: InkWell(
        onTap: action,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          width: 56,
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            color: selected
                ? AppColors.accent.withValues(alpha: .1)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 21,
                color: selected ? AppColors.accent : AppColors.muted,
              ),
              const SizedBox(height: 6),
              Text(
                label,
                style: TextStyle(
                  fontSize: 10,
                  color: selected ? AppColors.accent : AppColors.muted,
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => Container(
    width: 88,
    decoration: const BoxDecoration(
      color: Color(0xFF101713),
      border: Border(right: BorderSide(color: AppColors.line)),
    ),
    child: Column(
      children: [
        const SizedBox(height: 32),
        Container(
          width: 42,
          height: 42,
          decoration: BoxDecoration(
            color: AppColors.accent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(
            Icons.auto_awesome_mosaic_rounded,
            color: AppColors.background,
            size: 25,
          ),
        ),
        const SizedBox(height: 35),
        item(Icons.grid_view_rounded, '总览', onHome, selected: true),
        item(Icons.rule_rounded, '规则', onRules),
        const Spacer(),
        item(Icons.folder_outlined, '本地', onStorage),
        const SizedBox(height: 12),
      ],
    ),
  );
}

class RulesDialog extends StatelessWidget {
  const RulesDialog({super.key});

  Future<void> _open(BuildContext context, String url) async {
    try {
      if (Platform.isAndroid) {
        await _platform.invokeMethod<void>('openUrl', {'url': url});
      } else {
        await Process.start('explorer.exe', [url]);
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('无法打开浏览器，可复制下方链接查看。')));
      }
    }
  }

  @override
  Widget build(BuildContext context) => Dialog(
    insetPadding: const EdgeInsets.all(24),
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 650, maxHeight: 760),
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    '换算规则',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                ),
                IconButton(
                  tooltip: '关闭规则',
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '资源换算',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 14),
                    for (final row in const [
                      ('特许寻访凭证', '1 张 = 1 抽角色'),
                      ('嵌晶玉', '500 玉 = 1 抽角色'),
                      ('衍质源石', '1 枚 = 75 玉，或 25 武库配额'),
                      ('武库配额', '1,980 配额 = 1 次十连（10 抽）'),
                    ])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 13),
                        child: Wrap(
                          spacing: 16,
                          runSpacing: 5,
                          children: [
                            SizedBox(
                              width: 120,
                              child: Text(
                                row.$1,
                                style: const TextStyle(
                                  color: AppColors.muted,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                            Text(
                              row.$2,
                              style: const TextStyle(
                                fontSize: 12,
                                color: AppColors.accent,
                              ),
                            ),
                          ],
                        ),
                      ),
                    const SizedBox(height: 10),
                    const Divider(),
                    const SizedBox(height: 20),
                    const Text(
                      '抽数与图表口径',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      '• 顶部显示等值总抽数，固定两位小数，小数部分缩小。角色按 120 抽一井、武库按 80 抽一井显示约数。\n• 源石默认计入角色，也可手动切换用途，同一份源石只计算一次。\n• 每天 04:00 切换游戏日。无备注更新当天默认记录，有备注则单独保留。\n• 日趋势采用每个游戏日最后一条有效记录，排除后回退到当天上一条有效记录。\n• 区间净变化包含获取和消耗，漏记日期不补值。日均净变化取所选范围内首尾余额之差，再除以实际间隔天数。',
                      style: TextStyle(
                        fontSize: 12,
                        height: 2,
                        color: AppColors.muted,
                      ),
                    ),
                    const SizedBox(height: 22),
                    const Text(
                      '资料来源 · 核验于 2026.10.30',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 8),
                    const Text(
                      '兑换数值依据公测攻略正文及游戏截图；官方公告用于核对资源用途与寻访类型。游戏内规则更新后必须重新核验换算常量。',
                      style: TextStyle(
                        fontSize: 11,
                        height: 1.8,
                        color: AppColors.muted,
                      ),
                    ),
                    const SizedBox(height: 8),
                    for (final source in const [
                      (
                        '4Gamers · 公测抽卡机制与资源兑换',
                        'https://www.4gamers.com.tw/news/detail/76627/arknights-endfield-beginner-guide',
                      ),
                      (
                        '游民星空 · 抽卡资源名词解析',
                        'https://www.gamersky.com/handbook/202601/2078216.shtml',
                      ),
                      (
                        '终末地官方 · 雪凇幽梦研发通讯',
                        'https://endfield.hypergryph.com/news/4776',
                      ),
                    ])
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            TextButton(
                              onPressed: () => _open(context, source.$2),
                              style: TextButton.styleFrom(
                                padding: EdgeInsets.zero,
                                alignment: Alignment.centerLeft,
                              ),
                              child: Text(
                                source.$1,
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                            SelectableText(
                              source.$2,
                              style: const TextStyle(
                                fontFamily: 'Segoe UI',
                                fontSize: 10,
                                color: AppColors.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
