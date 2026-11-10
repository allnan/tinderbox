enum OriginiumUse {
  character('角色'),
  arsenal('武库'),
  reserve('保留');

  const OriginiumUse(this.label);
  final String label;
}

enum ResourceKind {
  permits('特许寻访凭证', '张', '凭证'),
  originium('衍质源石', '枚', '源石'),
  oroberyl('嵌晶玉', '玉', '嵌晶玉'),
  quota('武库配额', '配额', '武库配额');

  const ResourceKind(this.label, this.unit, this.shortLabel);
  final String label;
  final String unit;
  final String shortLabel;

  int valueOf(ResourceInventory inventory) => switch (this) {
    permits => inventory.charteredPermits,
    originium => inventory.protoOriginium,
    oroberyl => inventory.oroberyl,
    quota => inventory.arsenalQuota,
  };
}

class ResourceInventory {
  const ResourceInventory({
    this.oroberyl = 0,
    this.protoOriginium = 0,
    this.charteredPermits = 0,
    this.arsenalQuota = 0,
  });

  static const int maxResource = 999999999;
  static const int oroberylPerPull = 500;
  static const int oroberylPerOriginium = 75;
  static const int quotaPerOriginium = 25;
  static const int arsenalQuotaPerTenPull = 1980;
  static const int characterPullsPerWell = 120;
  static const int arsenalPullsPerWell = 80;

  final int oroberyl;
  final int protoOriginium;
  final int charteredPermits;
  final int arsenalQuota;

  static int? parseAmount(String text) {
    final normalized = text.trim().replaceAll(RegExp(r'[,，\s]'), '');
    if (!RegExp(r'^\d{1,9}$').hasMatch(normalized)) return null;
    return int.tryParse(normalized);
  }

  int get convertedOroberyl => oroberyl + protoOriginium * oroberylPerOriginium;

  int get currencyCharacterPulls => convertedOroberyl ~/ oroberylPerPull;

  int get characterPulls => currencyCharacterPulls + charteredPermits;

  int get characterOroberylRemainder => convertedOroberyl % oroberylPerPull;

  int get weaponTenPulls => arsenalQuota ~/ arsenalQuotaPerTenPull;

  int get weaponPulls => weaponTenPulls * 10;

  int get weaponQuotaRemainder => arsenalQuota % arsenalQuotaPerTenPull;

  PullBudget budget(OriginiumUse use) => PullBudget(this, use);

  Map<String, int> toJson() => {
    'charteredPermits': charteredPermits,
    'protoOriginium': protoOriginium,
    'oroberyl': oroberyl,
    'arsenalQuota': arsenalQuota,
  };

  factory ResourceInventory.fromJson(Map<String, dynamic> json) {
    int amount(String key) {
      final value = json[key];
      if (value is! int || value < 0 || value > maxResource) {
        throw FormatException('资源 $key 必须是 0～$maxResource 的整数');
      }
      return value;
    }

    return ResourceInventory(
      charteredPermits: amount('charteredPermits'),
      protoOriginium: amount('protoOriginium'),
      oroberyl: amount('oroberyl'),
      arsenalQuota: amount('arsenalQuota'),
    );
  }

  @override
  bool operator ==(Object other) =>
      other is ResourceInventory &&
      oroberyl == other.oroberyl &&
      protoOriginium == other.protoOriginium &&
      charteredPermits == other.charteredPermits &&
      arsenalQuota == other.arsenalQuota;

  @override
  int get hashCode =>
      Object.hash(oroberyl, protoOriginium, charteredPermits, arsenalQuota);
}

/// Contributions retain fractions. Round only after combining currencies.
class PullBudget {
  const PullBudget(this.inventory, this.originiumUse);
  final ResourceInventory inventory;
  final OriginiumUse originiumUse;

  int get characterOriginium => originiumUse == OriginiumUse.character
      ? inventory.protoOriginium * ResourceInventory.oroberylPerOriginium
      : 0;
  int get arsenalOriginium => originiumUse == OriginiumUse.arsenal
      ? inventory.protoOriginium * ResourceInventory.quotaPerOriginium
      : 0;
  int get characterCurrency => inventory.oroberyl + characterOriginium;
  int get arsenalCurrency => inventory.arsenalQuota + arsenalOriginium;
  double get characterEquivalent =>
      inventory.charteredPermits +
      characterCurrency / ResourceInventory.oroberylPerPull;
  double get characterWellEquivalent =>
      characterEquivalent / ResourceInventory.characterPullsPerWell;
  double get weaponEquivalent =>
      arsenalCurrency / (ResourceInventory.arsenalQuotaPerTenPull / 10);
  double get weaponWellEquivalent =>
      weaponEquivalent / ResourceInventory.arsenalPullsPerWell;
  int get characterPulls =>
      inventory.charteredPermits +
      characterCurrency ~/ ResourceInventory.oroberylPerPull;
  int get weaponTenPulls =>
      arsenalCurrency ~/ ResourceInventory.arsenalQuotaPerTenPull;
  int get weaponPulls => weaponTenPulls * 10;
  int get characterRemainder =>
      characterCurrency % ResourceInventory.oroberylPerPull;
  int get weaponRemainder =>
      arsenalCurrency % ResourceInventory.arsenalQuotaPerTenPull;
  double get oroberylEquivalent =>
      inventory.oroberyl / ResourceInventory.oroberylPerPull;
  double get characterOriginiumEquivalent =>
      characterOriginium / ResourceInventory.oroberylPerPull;
  double get quotaEquivalent =>
      inventory.arsenalQuota / ResourceInventory.arsenalQuotaPerTenPull * 10;
  double get arsenalOriginiumEquivalent =>
      arsenalOriginium / ResourceInventory.arsenalQuotaPerTenPull * 10;
}
