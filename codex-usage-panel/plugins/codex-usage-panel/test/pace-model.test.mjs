import test from "node:test";
import assert from "node:assert/strict";
import { estimatePaceGuidance, estimateQuotaConversion, forecastQuotaPercent, integrateRhythmShares } from "../pace-model.mjs";
import { HOUR_PROFILES } from "../data/human-rhythm.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-09T10:00:00+08:00");
const WEEK_RESET = NOW + 5 * DAY;

function quotaHistory(now = NOW, { count = 6, ratio = 0.1, movement = 60, weeklyReset = WEEK_RESET } = {}) {
  const snapshots = [];
  for (let index = 0; index < count; index += 1) {
    const reset = now - (count - index - 1) * 6 * HOUR + HOUR;
    const end = Math.min(reset - HOUR / 2, now - 60_000);
    const common = { fiveResetAt: reset / 1000, weekResetAt: weeklyReset / 1000 };
    snapshots.push({ ...common, timestamp: end - 2 * HOUR, fiveUsed: 5, weekUsed: 2 + index * 7 });
    snapshots.push({ ...common, timestamp: end, fiveUsed: 5 + movement, weekUsed: 2 + index * 7 + movement * ratio });
  }
  return { snapshots };
}

function activityHistory(localHour, count = 10) {
  const snapshots = [];
  const firstLocalMidnight = Date.parse("2026-11-08T00:00:00+08:00");
  for (let index = 0; index < count; index += 1) {
    const midpoint = firstLocalMidnight - index * DAY + localHour * HOUR;
    const start = midpoint - 10 * 60_000;
    const end = midpoint + 10 * 60_000;
    const fiveResetAt = (end + HOUR) / 1000;
    const weekResetAt = (end + 4 * DAY) / 1000;
    const common = { fiveResetAt, weekResetAt };
    snapshots.push({ ...common, timestamp: start, fiveUsed: 2, weekUsed: 3 });
    snapshots.push({ ...common, timestamp: end, fiveUsed: 62, weekUsed: 9 });
  }
  return { snapshots };
}

function usageHistory(now = NOW, weeklyReset = WEEK_RESET) {
  const quotas = quotaHistory(now, { weeklyReset });
  return { snapshots: [...quotas.snapshots, ...activityHistory(10, 10).snapshots] };
}

function windows({ spent = 30, weeklyUsed = 50, fiveReset, weeklyReset, now = NOW } = {}) {
  return {
    fiveHour: { usedPercent: spent, resetsAt: fiveReset ?? now + 3 * HOUR, windowDurationMins: 300 },
    weekly: { usedPercent: weeklyUsed, resetsAt: weeklyReset ?? now + 5 * DAY, windowDurationMins: 10080 }
  };
}

function guidance(options = {}, history = usageHistory(), now = NOW) {
  const { fiveHour, weekly } = windows({ ...options, now });
  return estimatePaceGuidance(history, fiveHour, weekly, now, "Asia/Shanghai");
}

test("public hourly data have 24 valid entries and retain a lunch dip", () => {
  for (const profile of HOUR_PROFILES) {
    assert.equal(profile.values.length, 24);
    assert.ok(profile.values.every((value) => value >= 0 && value <= 100));
    assert.ok(profile.values[12] < profile.values[11]);
    assert.ok(profile.values[3] < profile.values[10]);
  }
});

test("linear chart forecast preserves the amount projected above the quota limit", () => {
  assert.equal(forecastQuotaPercent(5, 300, 5), 300);
  assert.equal(forecastQuotaPercent(25, 300, 60), 125);
  assert.equal(forecastQuotaPercent(10, 300, 30), 100);
  assert.equal(forecastQuotaPercent(10, 300, 150), 20);
  assert.equal(forecastQuotaPercent(10, 300, 0), null);
});

test("human hourly prior predicts more daytime than overnight activity", () => {
  const monday = Date.parse("2026-11-09T10:00:00+08:00");
  const night = Date.parse("2026-11-09T00:00:00+08:00");
  const dayShares = integrateRhythmShares(monday, monday + 5 * HOUR, monday + 7 * DAY, "Asia/Shanghai");
  const nightShares = integrateRhythmShares(night, night + 5 * HOUR, night + 7 * DAY, "Asia/Shanghai");
  assert.equal(dayShares.length, 256);
  const average = (values) => values.reduce((total, item) => total + item.share, 0) / values.length;
  assert.ok(average(dayShares) > average(nightShares) * 2);
});

test("same local hours produce identical forecasts on every weekday", () => {
  const monday = Date.parse("2026-11-09T10:00:00+08:00");
  const saturday = Date.parse("2026-11-14T10:00:00+08:00");
  const mondayShares = integrateRhythmShares(monday, monday + 3 * HOUR, monday + 5 * DAY, "Asia/Shanghai");
  const saturdayShares = integrateRhythmShares(saturday, saturday + 3 * HOUR, saturday + 5 * DAY, "Asia/Shanghai");
  assert.equal(mondayShares.length, saturdayShares.length);
  for (let index = 0; index < mondayShares.length; index += 1) {
    assert.ok(Math.abs(mondayShares[index].share - saturdayShares[index].share) < 1e-12);
  }
});

test("local quota history shifts forecasts toward the user's observed active hours", () => {
  const nightNow = Date.parse("2026-11-09T22:00:00+08:00");
  const target = nightNow + 5 * HOUR;
  const weekReset = nightNow + 5 * DAY;
  const daytimeUse = integrateRhythmShares(nightNow, target, weekReset, "Asia/Shanghai", activityHistory(10));
  const nighttimeUse = integrateRhythmShares(nightNow, target, weekReset, "Asia/Shanghai", activityHistory(23));
  const average = (values) => values.reduce((total, item) => total + item.share, 0) / values.length;
  assert.ok(average(nighttimeUse) > average(daytimeUse) + 0.1);
});

test("the full five-hour budget rises in the user's higher-activity time window", () => {
  const dayNow = Date.parse("2026-11-09T10:00:00+08:00");
  const nightNow = Date.parse("2026-11-09T23:00:00+08:00");
  const makeHistory = (now, weeklyReset) => ({
    snapshots: [...quotaHistory(now, { weeklyReset }).snapshots, ...activityHistory(10, 10).snapshots]
  });
  const dayWeekReset = dayNow + 5 * DAY;
  const nightWeekReset = nightNow + 5 * DAY;
  const dayHistory = makeHistory(dayNow, dayWeekReset);
  const nightHistory = makeHistory(nightNow, nightWeekReset);
  const day = guidance({ spent: 30, weeklyUsed: 50, fiveReset: dayNow + 5 * HOUR, weeklyReset: dayWeekReset, now: dayNow }, dayHistory, dayNow).band;
  const night = guidance({ spent: 30, weeklyUsed: 50, fiveReset: nightNow + 5 * HOUR, weeklyReset: nightWeekReset, now: nightNow }, nightHistory, nightNow).band;
  assert.ok(day && night);
  assert.ok(day.targetWindowActivityWeight > night.targetWindowActivityWeight);
  assert.ok(day.targetPercent > night.targetPercent);
});

test("personal activity history is blended with population profiles and kept deterministic", () => {
  const history = activityHistory(23);
  const first = integrateRhythmShares(NOW, NOW + 3 * HOUR, WEEK_RESET, "Asia/Shanghai", history);
  const second = integrateRhythmShares(NOW, NOW + 3 * HOUR, WEEK_RESET, "Asia/Shanghai", history);
  assert.deepEqual(first, second);
  assert.ok(first.every((item) => Number.isFinite(item.share) && item.share > 0 && item.share < 1));
  const band = guidance({}, { snapshots: [...history.snapshots, ...quotaHistory().snapshots] }).band;
  assert.equal(band.personalActivityWeight, 16 / 20);
  assert.equal(band.activitySampleWindows, 16);
});

test("duplicate Codex quota snapshots do not create more personal activity samples", () => {
  const history = activityHistory(23);
  const duplicated = { snapshots: history.snapshots.flatMap((sample) => [{ ...sample }, { ...sample }, { ...sample }]) };
  const regular = integrateRhythmShares(NOW, NOW + 3 * HOUR, WEEK_RESET, "Asia/Shanghai", history);
  const repeated = integrateRhythmShares(NOW, NOW + 3 * HOUR, WEEK_RESET, "Asia/Shanghai", duplicated);
  assert.deepEqual(repeated, regular);
});

test("equal local calendars produce equal budgets in different time zones", () => {
  const utc = Date.parse("2026-11-09T10:00:00Z");
  const shanghai = Date.parse("2026-11-09T10:00:00+08:00");
  const a = integrateRhythmShares(utc, utc + 3 * HOUR, utc + 5 * DAY, "UTC");
  const b = integrateRhythmShares(shanghai, shanghai + 3 * HOUR, shanghai + 5 * DAY, "Asia/Shanghai");
  a.forEach((item, index) => assert.ok(Math.abs(item.share - b[index].share) < 1e-12));
});

test("DST transitions remain finite and ordered", () => {
  const now = Date.parse("2026-11-01T00:30:00-04:00");
  const scenarios = integrateRhythmShares(now, now + 5 * HOUR, now + 6 * DAY, "America/New_York");
  assert.ok(scenarios.every((item) => Number.isFinite(item.share) && item.share > 0 && item.share < 1));
});

test("conversion uses independent reset windows and is deterministic", () => {
  const first = estimateQuotaConversion(quotaHistory(), NOW, WEEK_RESET);
  const second = estimateQuotaConversion(quotaHistory(), NOW, WEEK_RESET);
  assert.deepEqual(first, second);
  assert.equal(first.code, "ready");
  assert.ok(Math.abs(first.calibration.ratio - 0.1) < 1e-12);
  assert.ok(first.calibration.ratioLow < 0.1 && first.calibration.ratioHigh > 0.1);
});

test("duplicate quota events do not overweight a period", () => {
  const history = quotaHistory();
  const duplicated = { snapshots: history.snapshots.flatMap((sample) => Array.from({ length: 30 }, () => ({ ...sample }))) };
  assert.deepEqual(estimateQuotaConversion(history, NOW, WEEK_RESET), estimateQuotaConversion(duplicated, NOW, WEEK_RESET));
});

test("second-level reset drift does not create extra independent windows", () => {
  const history = quotaHistory();
  const drifted = { snapshots: history.snapshots.flatMap((sample) => [0, 5, 15].map((seconds) => ({
    ...sample, fiveResetAt: sample.fiveResetAt + seconds, weekResetAt: sample.weekResetAt + seconds
  }))) };
  const result = estimateQuotaConversion(drifted, NOW, WEEK_RESET);
  assert.ok(result.calibration);
  assert.equal(result.calibration.sampleWindows, 6);
  assert.equal(result.calibration.primaryMovement, 360);
  assert.ok(Math.abs(result.calibration.ratio - 0.1) < 1e-12);
});

test("a five-hour window split by a weekly reset still counts as one independent window", () => {
  const oldReset = NOW - 2 * HOUR;
  const history = quotaHistory(NOW - 7 * HOUR, { count: 2, weeklyReset: oldReset });
  const fiveResetAt = (NOW + HOUR) / 1000;
  history.snapshots.push(
    { timestamp: NOW - 3.5 * HOUR, fiveResetAt, weekResetAt: oldReset / 1000, fiveUsed: 5, weekUsed: 90 },
    { timestamp: NOW - 2.5 * HOUR, fiveResetAt, weekResetAt: oldReset / 1000, fiveUsed: 35, weekUsed: 93 },
    { timestamp: NOW - 1.5 * HOUR, fiveResetAt, weekResetAt: WEEK_RESET / 1000, fiveUsed: 40, weekUsed: 0 },
    { timestamp: NOW - HOUR / 2, fiveResetAt, weekResetAt: WEEK_RESET / 1000, fiveUsed: 70, weekUsed: 3 }
  );
  assert.equal(estimateQuotaConversion(history, NOW, WEEK_RESET).calibration, null);
});

test("a quota correction is split, rather than summed as extra positive usage", () => {
  const history = quotaHistory();
  const common = { fiveResetAt: (NOW + HOUR / 2) / 1000, weekResetAt: WEEK_RESET / 1000 };
  history.snapshots.push(
    { ...common, timestamp: NOW - 4 * HOUR, fiveUsed: 0, weekUsed: 60 },
    { ...common, timestamp: NOW - 3 * HOUR, fiveUsed: 40, weekUsed: 64 },
    { ...common, timestamp: NOW - 2 * HOUR, fiveUsed: 0, weekUsed: 64 },
    { ...common, timestamp: NOW - HOUR, fiveUsed: 40, weekUsed: 64 }
  );
  const { calibration } = estimateQuotaConversion(history, NOW, WEEK_RESET);
  assert.ok(calibration);
  assert.ok(Math.abs(calibration.ratio - 0.1) < 1e-12);
});

test("a large middle-period outlier is rejected", () => {
  const history = quotaHistory();
  const reset = NOW - 7 * HOUR;
  history.snapshots.push(
    { timestamp: reset - 3 * HOUR, fiveResetAt: reset / 1000, weekResetAt: WEEK_RESET / 1000, fiveUsed: 0, weekUsed: 40 },
    { timestamp: reset - HOUR, fiveResetAt: reset / 1000, weekResetAt: WEEK_RESET / 1000, fiveUsed: 60, weekUsed: 70 }
  );
  const { calibration } = estimateQuotaConversion(history, NOW, WEEK_RESET);
  assert.ok(calibration);
  assert.ok(Math.abs(calibration.ratio - 0.1) < 1e-12);
  assert.equal(calibration.rejectedWindows, 1);
});

test("a conflicting latest quota regime suppresses an old conversion", () => {
  const history = quotaHistory();
  const common = { fiveResetAt: (NOW + 2 * HOUR) / 1000, weekResetAt: WEEK_RESET / 1000 };
  history.snapshots.push(
    { ...common, timestamp: NOW - HOUR, fiveUsed: 0, weekUsed: 50 },
    { ...common, timestamp: NOW - 1000, fiveUsed: 60, weekUsed: 80 }
  );
  const result = estimateQuotaConversion(history, NOW, WEEK_RESET);
  assert.equal(result.calibration, null);
  assert.equal(result.code, "changed-calibration");
});

test("current-week calibration takes priority over an older regime", () => {
  const old = quotaHistory(NOW - 7 * DAY, { ratio: 0.05, weeklyReset: NOW - DAY });
  const current = quotaHistory(NOW, { count: 4 });
  const { calibration } = estimateQuotaConversion({ snapshots: [...old.snapshots, ...current.snapshots] }, NOW, WEEK_RESET);
  assert.ok(calibration);
  assert.ok(Math.abs(calibration.ratio - 0.1) < 1e-12);
  assert.equal(calibration.sampleWindows, 4);
});

test("insufficient or poorly resolved quota movement produces no invented range", () => {
  const result = guidance({}, quotaHistory(NOW, { count: 4, movement: 10 }));
  assert.equal(result.band, null);
  assert.equal(result.status.code, "insufficient-calibration");
});

test("the range represents the total budget of one full five-hour window", () => {
  const { band } = guidance({ spent: 30, weeklyUsed: 80 });
  assert.ok(band);
  assert.ok(0 <= band.lowPercent && band.lowPercent <= band.highPercent && band.highPercent <= 100);
  assert.equal(band.includesCurrentWindowUseInWeeklyBudget, true);
  assert.ok(band.expectedActiveWindowsLow >= 1);
  assert.equal(band.targetAt, NOW + 3 * HOUR);
});

test("less weekly budget cannot increase either end of the range", () => {
  const rich = guidance({ weeklyUsed: 30 }).band;
  const low = guidance({ weeklyUsed: 90 }).band;
  assert.ok(rich && low);
  assert.ok(low.lowPercent < rich.lowPercent);
  assert.ok(low.highPercent <= rich.highPercent);
});

test("the full-window budget stays stable near reset and can be below current use", () => {
  const history = usageHistory();
  const fiveReset = NOW + 5 * HOUR;
  const weeklyReset = NOW + 5 * DAY;
  const options = { spent: 49, weeklyUsed: 95, fiveReset, weeklyReset };
  const early = guidance(options, history, NOW).band;
  const lateNow = fiveReset - 20 * 60_000;
  const late = guidance(options, history, lateNow).band;
  assert.ok(early && late);
  assert.equal(early.lowPercent, late.lowPercent);
  assert.equal(early.highPercent, late.highPercent);
  assert.equal(early.targetPercent, late.targetPercent);
  assert.ok(early.highPercent < 49, "a current window can visibly exceed its sustainable budget");
});

test("when the week resets first, only this week's remaining budget is allocated", () => {
  const weeklyReset = NOW + HOUR;
  const history = usageHistory(NOW, weeklyReset);
  const { band } = guidance({ spent: 20, weeklyUsed: 98, weeklyReset }, history);
  assert.ok(band);
  assert.equal(band.targetAt, NOW + 3 * HOUR);
  assert.ok(Math.abs(band.targetPercent - 40) < 1e-10);
  assert.equal(band.expectedActiveWindowsLow, 1);
  assert.equal(band.expectedActiveWindowsHigh, 1);
});

test("exhausted weekly or five-hour quota adds no spending budget", () => {
  const weekly = guidance({ spent: 35, weeklyUsed: 100 }, null);
  assert.equal(weekly.band.lowPercent, 0);
  assert.equal(weekly.band.highPercent, 0);
  assert.equal(weekly.status.code, "weekly-exhausted");
  const five = guidance({ spent: 100 });
  assert.ok(five.band.lowPercent <= 100);
  assert.ok(five.band.highPercent <= 100);
});

test("missing or stale reset information is explicitly unavailable", () => {
  assert.equal(estimatePaceGuidance(null, null, null, NOW).band, null);
  assert.equal(guidance({ fiveReset: NOW - 1000 }).status.code, "stale-limits");
  assert.equal(guidance({ fiveReset: NOW + 8 * HOUR }).status.code, "stale-limits");
  const { fiveHour, weekly } = windows();
  assert.equal(estimatePaceGuidance(quotaHistory(), fiveHour, weekly, NOW, "Invalid/Zone").status.code, "invalid-timezone");
});
