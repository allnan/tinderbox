import {
  ACTIVITY_BOOTSTRAP_SAMPLES,
  HOUR_PROFILES,
  MAX_ACTIVITY_SAMPLE_GAP_MS,
  MIN_ACTIVITY_WINDOW_MOVEMENT,
  PRIOR_ACTIVITY_WINDOWS,
  RHYTHM_MODEL_VERSION
} from "./data/human-rhythm.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const AVERAGE_FIVE_HOUR_ACTIVITY_MASS = FIVE_HOUR_MS / DAY_MS;
const WEEK_MS = 7 * DAY_MS;
const INTEGRATION_STEP_MS = 15 * 60 * 1000;
const MIN_CALIBRATION_WINDOWS = 4;
const MIN_PRIMARY_MOVEMENT = 100;
const ROUNDING_DELTA_ERROR = 1; // Two rounded percentage endpoints: at most 1 pp.
const BOOTSTRAP_SAMPLES = 256;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const sum = (values) => values.reduce((total, value) => total + value, 0);

export function forecastQuotaPercent(usedPercent, durationMinutes, elapsedMinutes) {
  if (![usedPercent, durationMinutes, elapsedMinutes].every(Number.isFinite) || durationMinutes <= 0 || elapsedMinutes <= 0) return null;
  return Math.max(0, usedPercent * durationMinutes / elapsedMinutes);
}

function weightedMedian(samples) {
  const ordered = samples.slice().sort((a, b) => a.value - b.value);
  const halfway = sum(ordered.map((item) => item.weight)) / 2;
  let accumulated = 0;
  for (const item of ordered) {
    accumulated += item.weight;
    if (accumulated >= halfway) return item.value;
  }
  return ordered.at(-1)?.value ?? NaN;
}

function quantile(values, fraction) {
  const ordered = values.slice().sort((a, b) => a - b);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  return ordered[lower] + (ordered[Math.ceil(index)] - ordered[lower]) * (index - lower);
}

function deterministicRandom(seedText) {
  let state = 2166136261;
  for (const char of seedText) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function standardNormal(random) {
  const first = Math.max(random(), Number.MIN_VALUE);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function triangularSample(low, mode, high, random) {
  if (!(high > low)) return low;
  const peak = clamp(mode, low, high);
  const split = (peak - low) / (high - low);
  const draw = random();
  if (draw < split) return low + Math.sqrt(draw * (high - low) * (peak - low));
  return high - Math.sqrt((1 - draw) * (high - low) * (high - peak));
}

function canonicalResets(values) {
  const canonical = new Map();
  let anchor = null;
  for (const value of Array.from(new Set(values)).sort((a, b) => a - b)) {
    if (anchor == null || value - anchor > 60) anchor = value;
    canonical.set(value, anchor);
  }
  return canonical;
}

function collectQuotaChanges(history, now) {
  const candidates = [];
  for (const sample of history?.snapshots || []) {
    if (![sample.timestamp, sample.fiveUsed, sample.weekUsed, sample.fiveResetAt, sample.weekResetAt].every(Number.isFinite)) continue;
    if (sample.timestamp < now - 14 * DAY_MS || sample.timestamp > now) continue;
    if (sample.fiveUsed < 0 || sample.fiveUsed > 100 || sample.weekUsed < 0 || sample.weekUsed > 100) continue;
    if (sample.timestamp > sample.fiveResetAt * 1000 + 60_000 || sample.timestamp > sample.weekResetAt * 1000 + 60_000) continue;
    if (sample.timestamp < sample.fiveResetAt * 1000 - FIVE_HOUR_MS - 60_000 || sample.timestamp < sample.weekResetAt * 1000 - WEEK_MS - 60_000) continue;
    candidates.push(sample);
  }
  const fiveResets = canonicalResets(candidates.map((sample) => sample.fiveResetAt));
  const weeklyResets = canonicalResets(candidates.map((sample) => sample.weekResetAt));
  const groups = new Map();
  for (const original of candidates) {
    const sample = { ...original, fiveResetAt: fiveResets.get(original.fiveResetAt), weekResetAt: weeklyResets.get(original.weekResetAt) };
    const key = sample.fiveResetAt + "|" + sample.weekResetAt;
    if (!groups.has(key)) groups.set(key, new Map());
    const atTime = groups.get(key);
    const previous = atTime.get(sample.timestamp);
    if (!previous || sample.fiveUsed + sample.weekUsed > previous.fiveUsed + previous.weekUsed) atTime.set(sample.timestamp, sample);
  }

  const changes = [];
  for (const [id, byTime] of groups) {
    const records = Array.from(byTime.values()).sort((a, b) => a.timestamp - b.timestamp);
    let start = records[0];
    let previous = start;
    let best = null;
    function finishRun(end) {
      if (!start || !end) return;
      const primary = end.fiveUsed - start.fiveUsed;
      const weekly = end.weekUsed - start.weekUsed;
      if (primary < 10 || weekly < 1) return;
      if (!best || primary > best.primary) {
        best = { id, primary, weekly, ratio: weekly / primary, timestamp: end.timestamp, fiveResetAt: end.fiveResetAt, weekResetAt: end.weekResetAt };
      }
    }
    for (const current of records.slice(1)) {
      // A reset, a correction, or an out-of-order stale quota must not be turned
      // into extra consumption by summing only the positive steps.
      if (current.fiveUsed < previous.fiveUsed - 0.01 || current.weekUsed < previous.weekUsed - 0.01) {
        finishRun(previous);
        start = current;
      }
      previous = current;
    }
    finishRun(previous);
    if (best) changes.push(best);
  }
  return changes.sort((a, b) => a.timestamp - b.timestamp);
}

function fitQuotaConversion(changes) {
  // A weekly reset can split one five-hour window into two paired groups.
  // Keep only one segment per five-hour reset in the resampling population.
  const independent = new Map();
  for (const item of changes) {
    const previous = independent.get(item.fiveResetAt);
    if (!previous || item.primary > previous.primary || (item.primary === previous.primary && item.timestamp > previous.timestamp)) independent.set(item.fiveResetAt, item);
  }
  changes = Array.from(independent.values());
  if (changes.length < MIN_CALIBRATION_WINDOWS) return null;
  const median = weightedMedian(changes.map((item) => ({ value: item.ratio, weight: Math.min(50, item.primary) })));
  const mad = weightedMedian(changes.map((item) => ({ value: Math.abs(item.ratio - median), weight: Math.min(50, item.primary) })));
  const retained = changes.filter((item) => Math.abs(item.ratio - median) <=
    Math.max(3 * 1.4826 * mad, ROUNDING_DELTA_ERROR * (1 + median) / item.primary));
  if (retained.length < MIN_CALIBRATION_WINDOWS || retained.length < changes.length * 0.6) return null;
  const primary = sum(retained.map((item) => item.primary));
  const weekly = sum(retained.map((item) => item.weekly));
  if (primary < MIN_PRIMARY_MOVEMENT || weekly <= retained.length * ROUNDING_DELTA_ERROR) return null;

  const random = deterministicRandom(retained.map((item) => item.id + ":" + item.primary + ":" + item.weekly).join("|"));
  const bootstrap = [];
  for (let iteration = 0; iteration < BOOTSTRAP_SAMPLES; iteration += 1) {
    let primaryTotal = 0;
    let weeklyTotal = 0;
    for (let index = 0; index < retained.length; index += 1) {
      const item = retained[Math.floor(random() * retained.length)];
      // Each quota movement is a difference between two rounded percentage
      // readings. Model those endpoint errors independently per sampled
      // window instead of aligning every error in the same worst-case direction.
      primaryTotal += Math.max(Number.EPSILON, item.primary + random() - random());
      weeklyTotal += Math.max(Number.EPSILON, item.weekly + random() - random());
    }
    bootstrap.push(weeklyTotal / primaryTotal);
  }
  const ratioLow = quantile(bootstrap, 0.1);
  const ratioHigh = quantile(bootstrap, 0.9);
  if (!(ratioLow > 0) || ratioHigh / ratioLow > 2) return null;
  return {
    ratio: weekly / primary,
    ratioLow,
    ratioHigh,
    sampleWindows: retained.length,
    rejectedWindows: changes.length - retained.length,
    primaryMovement: primary,
    weeklyMovement: weekly
  };
}

export function estimateQuotaConversion(history, now, weeklyResetsAt) {
  const changes = collectQuotaChanges(history, now);
  const sameWeek = changes.filter((item) => Math.abs(item.weekResetAt * 1000 - weeklyResetsAt) <= 60_000);
  // Prefer the current quota regime. Earlier weeks only provide a capacity
  // fallback, and a conflicting latest observation suppresses that fallback.
  const calibration = fitQuotaConversion(sameWeek) || fitQuotaConversion(changes);
  if (!calibration) return { calibration: null, code: "insufficient-calibration" };
  const latest = changes.at(-1);
  if (latest) {
    const latestLow = Math.max(0, (latest.weekly - ROUNDING_DELTA_ERROR) / (latest.primary + ROUNDING_DELTA_ERROR));
    const latestHigh = (latest.weekly + ROUNDING_DELTA_ERROR) / (latest.primary - ROUNDING_DELTA_ERROR);
    if (latestLow > calibration.ratioHigh || latestHigh < calibration.ratioLow) {
      return { calibration: null, code: "changed-calibration" };
    }
  }
  return { calibration, code: "ready" };
}

function localHour(formatter, timestamp) {
  const values = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return Number(values.hour) + Number(values.minute) / 60;
}

function interpolateHour(profile, hour) {
  const wrapped = ((hour % 24) + 24) % 24;
  const lower = Math.floor(wrapped);
  const fraction = wrapped - lower;
  return profile.values[lower] * (1 - fraction) + profile.values[(lower + 1) % 24] * fraction;
}

function addClockWeight(histogram, timestamp, amount, formatter) {
  const hour = localHour(formatter, timestamp);
  const lower = Math.floor(hour);
  const fraction = hour - lower;
  histogram[lower] += amount * (1 - fraction);
  histogram[(lower + 1) % 24] += amount * fraction;
}

function collectActivityWindows(history, now, timeZone) {
  const cutoff = now - 14 * DAY_MS;
  const candidates = [];
  for (const sample of history?.snapshots || []) {
    if (![sample.timestamp, sample.fiveUsed, sample.weekUsed, sample.fiveResetAt, sample.weekResetAt].every(Number.isFinite)) continue;
    if (sample.timestamp < cutoff || sample.timestamp > now) continue;
    if (sample.fiveUsed < 0 || sample.fiveUsed > 100 || sample.weekUsed < 0 || sample.weekUsed > 100) continue;
    if (sample.timestamp > sample.fiveResetAt * 1000 + 60_000 || sample.timestamp > sample.weekResetAt * 1000 + 60_000) continue;
    if (sample.timestamp < sample.fiveResetAt * 1000 - FIVE_HOUR_MS - 60_000 || sample.timestamp < sample.weekResetAt * 1000 - WEEK_MS - 60_000) continue;
    candidates.push(sample);
  }
  const fiveResets = canonicalResets(candidates.map((sample) => sample.fiveResetAt));
  const weeklyResets = canonicalResets(candidates.map((sample) => sample.weekResetAt));
  const groups = new Map();
  for (const original of candidates) {
    const sample = { ...original, fiveResetAt: fiveResets.get(original.fiveResetAt), weekResetAt: weeklyResets.get(original.weekResetAt) };
    const key = sample.fiveResetAt + "|" + sample.weekResetAt;
    if (!groups.has(key)) groups.set(key, new Map());
    const byTime = groups.get(key);
    const previous = byTime.get(sample.timestamp);
    if (!previous || sample.fiveUsed + sample.weekUsed > previous.fiveUsed + previous.weekUsed) byTime.set(sample.timestamp, sample);
  }

  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const byFiveHourWindow = new Map();
  for (const [id, byTime] of groups) {
    const records = Array.from(byTime.values()).sort((a, b) => a.timestamp - b.timestamp);
    let run = records.length ? [records[0]] : [];
    let best = null;
    const finishRun = () => {
      if (run.length < 2) return;
      const histogram = Array(24).fill(0);
      let movement = 0;
      for (let index = 1; index < run.length; index += 1) {
        const previous = run[index - 1];
        const current = run[index];
        const gap = current.timestamp - previous.timestamp;
        const delta = current.fiveUsed - previous.fiveUsed;
        if (gap <= 0 || gap > MAX_ACTIVITY_SAMPLE_GAP_MS || delta <= 0) continue;
        const midpoint = (previous.timestamp + current.timestamp) / 2;
        addClockWeight(histogram, midpoint, delta, formatter);
        movement += delta;
      }
      if (movement >= MIN_ACTIVITY_WINDOW_MOVEMENT && (!best || movement > best.movement)) best = { histogram, movement };
    };
    let previous = run[0];
    for (const current of records.slice(1)) {
      if (current.fiveUsed < previous.fiveUsed - 0.01 || current.weekUsed < previous.weekUsed - 0.01) {
        finishRun();
        run = [current];
      } else {
        run.push(current);
      }
      previous = current;
    }
    finishRun();
    if (!best) continue;
    const fiveResetAt = Number(id.split("|")[0]);
    if (!byFiveHourWindow.has(fiveResetAt)) byFiveHourWindow.set(fiveResetAt, { histogram: Array(24).fill(0), movement: 0 });
    const target = byFiveHourWindow.get(fiveResetAt);
    for (let hour = 0; hour < 24; hour += 1) target.histogram[hour] += best.histogram[hour];
    target.movement += best.movement;
  }
  return Array.from(byFiveHourWindow.entries())
    .filter(([, window]) => window.movement >= MIN_ACTIVITY_WINDOW_MOVEMENT)
    .map(([resetAt, window]) => ({
      resetAt,
      movement: window.movement,
      profile: normalizeProfile(window.histogram)
    }));
}

function normalizeProfile(values) {
  const total = sum(values);
  return total > 0 ? values.map((value) => value / total) : Array(24).fill(1 / 24);
}

function makeActivityScenarios(history, now, timeZone) {
  const personalWindows = collectActivityWindows(history, now, timeZone);
  const count = personalWindows.length;
  const personalWeight = count / (count + PRIOR_ACTIVITY_WINDOWS);
  const seed = personalWindows.map((window) => window.profile.map((value) => value.toFixed(5)).join(",")).join("|");
  const random = deterministicRandom(seed || "population-prior");
  const scenarios = [];
  for (let iteration = 0; iteration < ACTIVITY_BOOTSTRAP_SAMPLES; iteration += 1) {
    const prior = normalizeProfile(HOUR_PROFILES[iteration % HOUR_PROFILES.length].values);
    const observed = Array(24).fill(0);
    if (count > 0) {
      for (let sample = 0; sample < count; sample += 1) {
        const profile = personalWindows[Math.floor(random() * count)].profile;
        for (let hour = 0; hour < 24; hour += 1) observed[hour] += profile[hour] / count;
      }
    }
    const values = prior.map((value, hour) => value * (1 - personalWeight) + observed[hour] * personalWeight);
    const sampledCount = Math.max(0, count + Math.sqrt(count) * standardNormal(random));
    scenarios.push({ id: "hourly-history-" + iteration, values: normalizeProfile(values), windowsPerDay: sampledCount / 14 });
  }
  return { scenarios, sampleWindows: count, personalWeight };
}

function makeActivitySteps(startAt, endAt, formatter) {
  const steps = [];
  if (endAt <= startAt) return steps;
  for (let start = startAt; start < endAt;) {
    const end = Math.min(start + INTEGRATION_STEP_MS, endAt);
    const midpoint = (start + end) / 2;
    steps.push({ hour: localHour(formatter, midpoint), hours: (end - start) / HOUR_MS });
    start = end;
  }
  return steps;
}

function integrateActivitySteps(steps, profile) {
  return sum(steps.map((step) => interpolateHour(profile, step.hour) * step.hours));
}

function integrateProfiles(windowStart, fiveHourResetAt, weeklyResetsAt, timeZone, profiles) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const windowSteps = makeActivitySteps(windowStart, fiveHourResetAt, formatter);
  const futureSteps = makeActivitySteps(fiveHourResetAt, weeklyResetsAt, formatter);
  return profiles.map(({ id, values, windowsPerDay }) => {
    const profile = { values };
    const windowMass = integrateActivitySteps(windowSteps, profile);
    const futureMass = integrateActivitySteps(futureSteps, profile);
    const expectedFutureWindows = windowsPerDay * futureMass;
    const expectedWindows = 1 + expectedFutureWindows;
    const targetWindowActivityWeight = futureMass > 0
      ? windowMass / AVERAGE_FIVE_HOUR_ACTIVITY_MASS
      : 1;
    const budgetShare = targetWindowActivityWeight / (targetWindowActivityWeight + expectedFutureWindows || 1);
    return {
      id,
      windowMass,
      futureMass,
      windowsPerDay,
      expectedWindows,
      expectedFutureWindows,
      targetWindowActivityWeight,
      budgetShare,
      share: windowMass / (windowMass + futureMass || 1)
    };
  });
}

export function integrateRhythmShares(now, targetAt, weeklyResetsAt, timeZone = "UTC", history = null) {
  const activity = makeActivityScenarios(history, now, timeZone);
  return integrateProfiles(now, targetAt, weeklyResetsAt, timeZone, activity.scenarios);
}

function unavailable(code, message) {
  return { band: null, status: { code, message } };
}

export function estimatePaceGuidance(history, fiveHour, weekly, now, timeZone = "UTC") {
  if (!fiveHour || !weekly || ![now, fiveHour.usedPercent, weekly.usedPercent, fiveHour.resetsAt, weekly.resetsAt].every(Number.isFinite)) {
    return unavailable("missing-limits", "当前额度或重置时间不足，暂时无法估算合理消耗区间。");
  }
  const fiveRemaining = fiveHour.resetsAt - now;
  const weekRemaining = weekly.resetsAt - now;
  if (fiveRemaining <= 0 || weekRemaining <= 0 || fiveRemaining > FIVE_HOUR_MS + 60_000 || weekRemaining > WEEK_MS + 60_000) {
    return unavailable("stale-limits", "正在等待新的额度重置时间。");
  }
  const spent = clamp(fiveHour.usedPercent, 0, 100);
  const weeklyBudget = clamp(100 - weekly.usedPercent, 0, 100);
  const targetAt = fiveHour.resetsAt;
  const base = { basis: "weekly-budget-per-active-window", modelVersion: RHYTHM_MODEL_VERSION, targetAt, includesCurrentWindowUseInWeeklyBudget: true };
  if (weeklyBudget === 0) {
    return { band: { ...base, lowPercent: 0, highPercent: 0, targetPercent: 0, scenarioCount: 0 }, status: { code: "weekly-exhausted", message: "周额度已用完，当前可分配预算为 0%。" } };
  }
  const { calibration, code } = estimateQuotaConversion(history, now, weekly.resetsAt);
  if (!calibration) {
    return unavailable(code, code === "changed-calibration" ? "近期额度换算有变化，样本稳定后再显示区间。" : "有效额度样本不足，暂时无法可靠换算周额度和5小时额度。");
  }
  let activitySummary;
  let scenarios;
  try {
    activitySummary = makeActivityScenarios(history, now, timeZone);
    if (activitySummary.sampleWindows < 4) {
      return unavailable("insufficient-activity-history", "最近14天有效活跃窗口不足，暂时无法估算每个5小时窗口的预算。");
    }
    scenarios = integrateProfiles(targetAt - FIVE_HOUR_MS, targetAt, weekly.resetsAt, timeZone, activitySummary.scenarios);
  } catch {
    return unavailable("invalid-timezone", "本地时区不可用，暂时无法估算使用节奏。");
  }
  const ratioRandom = deterministicRandom("budget-ratio:" + calibration.ratio + ":" + calibration.ratioLow + ":" + calibration.ratioHigh);
  const budgetScenarios = scenarios.map((scenario) => {
    const ratio = triangularSample(calibration.ratioLow, calibration.ratio, calibration.ratioHigh, ratioRandom);
    return clamp((spent + weeklyBudget / ratio) * scenario.budgetShare, 0, 100);
  });
  const centralBudgets = scenarios.map((scenario) => clamp((spent + weeklyBudget / calibration.ratio) * scenario.budgetShare, 0, 100));
  const low = quantile(budgetScenarios, 0.1);
  const high = Math.max(low, quantile(budgetScenarios, 0.9));
  const target = clamp(quantile(centralBudgets, 0.5), low, high);
  const expectedWindows = scenarios.map((scenario) => scenario.expectedWindows);
  const targetWindowWeights = scenarios.map((scenario) => scenario.targetWindowActivityWeight);
  return {
    band: {
      ...base,
      lowPercent: low,
      highPercent: high,
      targetPercent: target,
      scenarioCount: scenarios.length,
      activitySampleWindows: activitySummary.sampleWindows,
      personalActivityWeight: activitySummary.personalWeight,
      calibration,
      expectedActiveWindowsLow: quantile(expectedWindows, 0.1),
      expectedActiveWindowsHigh: quantile(expectedWindows, 0.9),
      targetWindowActivityWeightLow: quantile(targetWindowWeights, 0.1),
      targetWindowActivityWeight: quantile(targetWindowWeights, 0.5),
      targetWindowActivityWeightHigh: quantile(targetWindowWeights, 0.9)
    },
    status: { code: "ready", message: "按当前完整窗口的活动强度、周剩余额度与预计后续活跃窗口分配预算。" }
  };
}
