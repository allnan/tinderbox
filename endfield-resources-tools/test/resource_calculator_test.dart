import 'package:endfield_resources_tools/resource_calculator.dart';
import 'package:endfield_resources_tools/ui/app_theme.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('5000 oroberyl equals ten character pulls', () {
    final budget = const ResourceInventory(
      oroberyl: 5000,
    ).budget(OriginiumUse.character);
    expect(budget.characterPulls, 10);
    expect(budget.oroberylEquivalent, 10);
    expect(budget.characterEquivalent, 10);
  });

  test('combines fractional currencies before rounding', () {
    final budget = const ResourceInventory(
      oroberyl: 925,
      protoOriginium: 1,
      charteredPermits: 3,
    ).budget(OriginiumUse.character);
    expect(budget.characterPulls, 5);
    expect(budget.oroberylEquivalent, 1.85);
    expect(budget.characterOriginiumEquivalent, .15);
    expect(budget.characterRemainder, 0);
    expect(budget.arsenalOriginiumEquivalent, 0);
  });

  test('arsenal accepts complete ten-pulls only', () {
    for (final entry in {0: 0, 1979: 0, 1980: 10, 3960: 20, 4000: 20}.entries) {
      final budget = ResourceInventory(
        arsenalQuota: entry.key,
      ).budget(OriginiumUse.reserve);
      expect(budget.weaponPulls, entry.value);
    }
    expect(
      const ResourceInventory(
        arsenalQuota: 4000,
      ).budget(OriginiumUse.reserve).weaponRemainder,
      40,
    );
  });

  test('allocates the same originium to only one destination', () {
    const inventory = ResourceInventory(
      protoOriginium: 80,
      oroberyl: 500,
      arsenalQuota: 1980,
    );
    final character = inventory.budget(OriginiumUse.character);
    final arsenal = inventory.budget(OriginiumUse.arsenal);
    final reserve = inventory.budget(OriginiumUse.reserve);
    expect([character.characterPulls, character.weaponPulls], [13, 10]);
    expect([arsenal.characterPulls, arsenal.weaponPulls], [1, 20]);
    expect(arsenal.arsenalOriginiumEquivalent, closeTo(10.1010101, .00001));
    expect([reserve.characterPulls, reserve.weaponPulls], [1, 10]);
  });

  test('parsing accepts grouped integers and rejects wrong entries', () {
    expect(ResourceInventory.parseAmount('5,000'), 5000);
    expect(ResourceInventory.parseAmount(' 5，000 '), 5000);
    expect(ResourceInventory.parseAmount('0'), 0);
    for (final value in ['', '-50', '1.5', 'abc', '1000000000', '1e3']) {
      expect(ResourceInventory.parseAmount(value), isNull, reason: value);
    }
  });

  test('formatting keeps trailing integer zeros', () {
    expect(formatNumber(5000), '5,000');
    expect(formatNumber(1000, decimals: 0), '1,000');
    expect(formatNumber(0), '0');
    expect(formatNumber(.15), '0.15');
    expect(formatNumber(-1000), '-1,000');
    expect(formatFixedNumber(5000), '5,000.00');
    expect(formatFixedNumber(0), '0.00');
  });

  test(
    'headline totals retain the fractional resources from the user example',
    () {
      final budget = const ResourceInventory(
        charteredPermits: 9,
        protoOriginium: 676,
        oroberyl: 119565,
        arsenalQuota: 43040,
      ).budget(OriginiumUse.character);
      expect(budget.characterEquivalent, closeTo(349.53, .000001));
      expect(formatFixedNumber(budget.characterEquivalent), '349.53');
      expect(formatFixedNumber(budget.weaponEquivalent), '217.37');
      expect(budget.weaponTenPulls, 21);
    },
  );
}
