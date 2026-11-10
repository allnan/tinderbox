import 'package:flutter/material.dart';

import '../resource_calculator.dart';
import 'app_theme.dart';

class BudgetCard extends StatelessWidget {
  const BudgetCard({
    super.key,
    required this.budget,
    required this.character,
    required this.valid,
    this.compact = false,
  });
  final PullBudget budget;
  final bool character;
  final bool valid;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final accent = character ? AppColors.accent : AppColors.teal;
    final total = character
        ? budget.characterEquivalent
        : budget.weaponEquivalent;
    final pullsPerWell = character
        ? ResourceInventory.characterPullsPerWell
        : ResourceInventory.arsenalPullsPerWell;
    final wells = character
        ? budget.characterWellEquivalent
        : budget.weaponWellEquivalent;
    final title = character ? '角色寻访' : '武库申领';
    final icon = ResourceIcon(
      kind: character ? ResourceKind.permits : ResourceKind.quota,
      size: compact ? 22 : 24,
    );
    final fixedTotal = total.toStringAsFixed(2);
    final totalParts = fixedTotal.split('.');
    final totalText = Text.rich(
      valid
          ? TextSpan(
              children: [
                TextSpan(
                  text: formatNumber(int.parse(totalParts.first), decimals: 0),
                ),
                TextSpan(
                  text: '.${totalParts.last}',
                  style: TextStyle(
                    fontSize: compact ? 18 : 28,
                    letterSpacing: -.4,
                  ),
                ),
              ],
            )
          : const TextSpan(text: '—'),
      key: ValueKey(character ? 'character-total' : 'weapon-total'),
      semanticsLabel: valid ? '$fixedTotal 抽' : '等待有效输入',
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: numberStyle.copyWith(
        fontSize: compact ? 33 : 52,
        height: 1.1,
        color: accent,
      ),
    );
    final wellLabel = '约 ${formatFixedNumber(wells)} 井';
    final wellHint = '$pullsPerWell 抽折合 1 井';

    if (compact) {
      return SurfacePanel(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        borderColor: accent.withValues(alpha: .22),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                icon,
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 3),
            FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  totalText,
                  const SizedBox(width: 5),
                  const Text(
                    '抽',
                    style: TextStyle(fontSize: 11, color: AppColors.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 2),
            Tooltip(
              message: wellHint,
              child: Text(
                valid ? wellLabel : '等待有效输入',
                style: const TextStyle(fontSize: 11, color: AppColors.muted),
              ),
            ),
          ],
        ),
      );
    }

    final parts = character
        ? [
            (
              ResourceKind.permits,
              '特许凭证',
              budget.inventory.charteredPermits.toDouble(),
            ),
            (ResourceKind.oroberyl, '嵌晶玉', budget.oroberylEquivalent),
            (ResourceKind.originium, '源石', budget.characterOriginiumEquivalent),
          ]
        : [
            (ResourceKind.quota, '武库配额', budget.quotaEquivalent),
            (ResourceKind.originium, '源石', budget.arsenalOriginiumEquivalent),
          ];
    final sum = parts.fold(0.0, (value, part) => value + part.$3);
    return SurfacePanel(
      borderColor: accent.withValues(alpha: .22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              icon,
              const SizedBox(width: 9),
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              const Spacer(),
              Text(
                character ? 'CHARACTER' : 'ARSENAL',
                style: TextStyle(
                  fontFamily: 'Segoe UI',
                  fontSize: 10,
                  letterSpacing: 1.7,
                  color: accent.withValues(alpha: .65),
                ),
              ),
            ],
          ),
          const SizedBox(height: 15),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Flexible(child: totalText),
                    const SizedBox(width: 9),
                    const Padding(
                      padding: EdgeInsets.only(bottom: 5),
                      child: Text(
                        '抽',
                        style: TextStyle(fontSize: 14, color: AppColors.muted),
                      ),
                    ),
                  ],
                ),
              ),
              if (valid) ...[
                const SizedBox(width: 8),
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Tooltip(
                    message: wellHint,
                    child: StatusTag(wellLabel, color: accent),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: SizedBox(
              height: 4,
              child: sum == 0 || !valid
                  ? const ColoredBox(color: AppColors.line)
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final part in parts)
                          if (part.$3 > 0)
                            Expanded(
                              flex: (part.$3 / sum * 10000).round().clamp(
                                1,
                                10000,
                              ),
                              child: ColoredBox(
                                color: AppColors.resource(part.$1),
                              ),
                            ),
                      ],
                    ),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 18,
            runSpacing: 7,
            children: [
              for (final part in parts)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ResourceIcon(kind: part.$1, size: 16),
                    const SizedBox(width: 4),
                    Text(
                      '${part.$2} ',
                      style: TextStyle(
                        color: AppColors.resource(part.$1),
                        fontSize: 11,
                      ),
                    ),
                    Text(
                      valid ? formatNumber(part.$3) : '—',
                      style: numberStyle.copyWith(
                        fontSize: 12,
                        letterSpacing: 0,
                      ),
                    ),
                  ],
                ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            !valid
                ? '填写完整的非负整数后显示结果'
                : character
                ? '合并折算后余 ${formatNumber(budget.characterRemainder)} 玉 · 距下 1 抽还差 ${formatNumber(500 - budget.characterRemainder)} 玉'
                : '余 ${formatNumber(budget.weaponRemainder)} 配额 · 距下次十连还差 ${formatNumber(1980 - budget.weaponRemainder)}',
            style: const TextStyle(
              fontSize: 11,
              color: AppColors.muted,
              height: 1.6,
            ),
          ),
        ],
      ),
    );
  }
}

class ResourceInputCard extends StatelessWidget {
  const ResourceInputCard({
    super.key,
    required this.kind,
    required this.controller,
    required this.use,
    required this.enabled,
    required this.onChanged,
    this.compact = false,
  });
  final ResourceKind kind;
  final TextEditingController controller;
  final OriginiumUse use;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final amount = ResourceInventory.parseAmount(controller.text);
    final accent = AppColors.resource(kind);
    final equivalent = amount == null
        ? null
        : switch (kind) {
            ResourceKind.permits => amount.toDouble(),
            ResourceKind.originium =>
              use == OriginiumUse.arsenal
                  ? amount * 25 / 198
                  : amount * 75 / 500,
            ResourceKind.oroberyl => amount / 500,
            ResourceKind.quota => amount / 198,
          };
    final conversion = switch (kind) {
      ResourceKind.permits => '1 张凭证 = 1 抽角色',
      ResourceKind.originium => '1 枚 = 75 玉 / 25 配额',
      ResourceKind.oroberyl => '500 玉 = 1 抽角色',
      ResourceKind.quota => '1,980 配额 = 10 抽武库',
    };
    final isOriginium = kind == ResourceKind.originium;
    final equivalentLabel = isOriginium && use == OriginiumUse.reserve
        ? '保留源石'
        : isOriginium
        ? '${use.label} · ${equivalent == null ? '—' : '≈ ${formatNumber(equivalent)} 抽'}'
        : equivalent == null
        ? '等待有效输入'
        : '≈ ${formatNumber(equivalent)} 抽';
    return SurfacePanel(
      padding: EdgeInsets.all(compact ? 10 : 17),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              ResourceIcon(kind: kind, size: compact ? 30 : 36, detailed: true),
              SizedBox(width: compact ? 6 : 9),
              Expanded(
                child: Text(
                  kind.label,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          SizedBox(height: compact ? 5 : 14),
          Semantics(
            label: '${kind.label}余额',
            child: TextField(
              key: ValueKey('amount-${kind.name}'),
              controller: controller,
              enabled: enabled,
              keyboardType: TextInputType.number,
              textInputAction: TextInputAction.next,
              maxLength: 18,
              onChanged: onChanged,
              onTap: () {
                if (controller.text == '0') {
                  controller.selection = const TextSelection(
                    baseOffset: 0,
                    extentOffset: 1,
                  );
                }
              },
              style: numberStyle.copyWith(
                fontSize: compact ? 19 : 25,
                letterSpacing: -.5,
              ),
              decoration: InputDecoration(
                semanticCounterText: '',
                counterText: '',
                isDense: true,
                constraints: compact
                    ? const BoxConstraints(minHeight: 48)
                    : null,
                suffixText: kind == ResourceKind.quota ? '' : kind.unit,
                suffixStyle: const TextStyle(
                  color: AppColors.muted,
                  fontSize: 11,
                ),
                errorText: amount == null ? '请输入 0～999999999 的整数' : null,
                errorStyle: const TextStyle(fontSize: 10),
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 11,
                  vertical: compact ? 8 : 12,
                ),
              ),
            ),
          ),
          SizedBox(height: compact ? 4 : 12),
          Text(
            equivalentLabel,
            key: ValueKey('equivalent-${kind.name}'),
            style: TextStyle(
              fontSize: compact ? 11 : 12,
              fontWeight: FontWeight.w600,
              color: accent,
            ),
          ),
          if (!compact) ...[
            const SizedBox(height: 5),
            Text(
              conversion,
              style: const TextStyle(fontSize: 10, color: AppColors.muted),
            ),
          ],
        ],
      ),
    );
  }
}
