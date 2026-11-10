import 'dart:async';
import 'dart:io' show InternetAddress;

import 'package:flutter/material.dart';

import '../lan_sync.dart';
import 'app_theme.dart';

class LanSyncDialog extends StatefulWidget {
  const LanSyncDialog({
    super.key,
    required this.target,
    required this.snapshot,
    required this.applySnapshot,
    this.hostStatus,
    this.subnetBroadcasts,
  });

  final LanSyncDevice target;
  final LanSyncSnapshot Function() snapshot;
  final Future<LanSyncApplied> Function(LanSyncSnapshot) applySnapshot;
  final Widget? hostStatus;
  final Future<List<InternetAddress>> Function()? subnetBroadcasts;

  @override
  State<LanSyncDialog> createState() => _LanSyncDialogState();
}

class _LanSyncDialogState extends State<LanSyncDialog> {
  List<LanSyncPeer> _peers = [];
  String? _message;
  String? _error;
  bool _busy = false;

  String get _targetLabel => widget.target == LanSyncDevice.phone ? '手机' : '电脑';

  @override
  void initState() {
    super.initState();
    unawaited(_search());
  }

  void _begin(String message) {
    setState(() {
      _busy = true;
      _error = null;
      _message = message;
    });
  }

  String _errorText(Object error) => switch (error) {
    FormatException e => e.message,
    StateError e => e.message.toString(),
    _ => '同步遇到错误，请确认网络连接后重试。',
  };

  Future<void> _search() async {
    if (_busy) return;
    _begin('正在查找$_targetLabel…');
    try {
      final peers = await discoverLanSync(
        device: widget.target,
        subnetBroadcasts: await widget.subnetBroadcasts?.call() ?? const [],
      );
      if (!mounted) return;
      _peers = peers;
      _message = peers.isEmpty ? '暂未找到$_targetLabel。请打开对方的账本后重新搜索。' : null;
    } catch (error) {
      _error = _errorText(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sync(LanSyncPeer peer) async {
    if (_busy) return;
    _begin('正在连接「${peer.name}」…');
    try {
      final current = await discoverLanSync(
        device: widget.target,
        destination: peer.address,
      );
      if (!mounted) return;
      final online = current
          .where(
            (item) => item.address == peer.address && item.name == peer.name,
          )
          .firstOrNull;
      if (online == null) {
        throw FormatException('$_targetLabel已离线，请确认对方的账本已打开后重新搜索。');
      }
      final remote = await exchangeLatest(online, widget.snapshot());
      if (!mounted) return;
      final applied = await widget.applySnapshot(remote.snapshot);
      _message = lanSyncSummary(
        local: applied,
        peerChanges: remote.peerChanges,
        peerLabel: _targetLabel,
      );
    } catch (error) {
      _error = _errorText(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !_busy,
    child: AlertDialog(
      title: const Text('局域网同步'),
      scrollable: true,
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('两端连到同一局域网，打开$_targetLabel上的账本，然后点选设备。'),
            const SizedBox(height: 16),
            for (final peer in _peers)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: SurfacePanel(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    leading: Icon(
                      widget.target == LanSyncDevice.phone
                          ? Icons.smartphone_rounded
                          : Icons.computer_rounded,
                    ),
                    title: Text(peer.name),
                    subtitle: _peers.length > 1
                        ? Text(peer.address.address)
                        : null,
                    trailing: const Icon(Icons.chevron_right_rounded),
                    onTap: _busy ? null : () => _sync(peer),
                  ),
                ),
              ),
            if (_busy) ...[
              const SizedBox(height: 12),
              const LinearProgressIndicator(),
            ],
            if (_error != null || _message != null) ...[
              const SizedBox(height: 12),
              Text(
                _error ?? _message!,
                style: TextStyle(
                  color: _error == null ? AppColors.accent : AppColors.error,
                ),
              ),
            ],
            const SizedBox(height: 12),
            const Text(
              '同步最新记录和各游戏日的图表汇总。',
              style: TextStyle(fontSize: 11, color: AppColors.muted),
            ),
            ?widget.hostStatus,
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('关闭'),
        ),
        FilledButton(
          onPressed: _busy ? null : _search,
          child: const Text('重新搜索'),
        ),
      ],
    ),
  );
}
