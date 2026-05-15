// Pure calculation functions — the domain core.
// Every number rendered by the dashboard goes through one of these.
// Kept side-effect free so it can be unit tested in isolation.

import type { Account, AccountState, Status, UsageEntry } from './types';
import { elapsedDays, periodLengthDays, previousNPeriods, previousPeriod, resolvePeriod } from './period';

// Reduce a list of usage entries (cumulative + delta mix) to a single "consumed"
// number for the period. Entries outside the period are ignored.
export function reduceConsumed(entries: UsageEntry[], periodStart: string, periodEnd: string): number {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const inWindow = entries
    .filter((e) => {
      const t = new Date(e.recordedAt).getTime();
      return t >= start && t < end;
    })
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());

  if (inWindow.length === 0) return 0;

  // Cumulative entries replace the running total. Delta entries add to it.
  // The "current" cumulative baseline is the most recent cumulative value seen.
  let cumulativeBaseline = 0;
  let deltaSinceBaseline = 0;
  let sawCumulative = false;
  for (const e of inWindow) {
    if (e.mode === 'cumulative') {
      cumulativeBaseline = e.value;
      deltaSinceBaseline = 0;
      sawCumulative = true;
    } else {
      deltaSinceBaseline += e.value;
    }
  }
  return sawCumulative ? cumulativeBaseline + deltaSinceBaseline : deltaSinceBaseline;
}

function statusFor(deltaPct: number, tolerancePct: number, consumed: number, quota: number, remainingDays: number): Status {
  if (remainingDays <= 0) return 'period_ended';
  if (consumed > quota) return 'over_quota';
  if (Math.abs(deltaPct) <= tolerancePct) return 'on_track';
  // delta > 0 means we consumed more than ideal → ahead of schedule → "behind" budget-wise.
  return deltaPct > 0 ? 'behind' : 'ahead';
}

// Build a sorted "running cumulative" series (timestampMs, cumulativeValue) from
// raw entries. Used by the regression projection. Mirrors reduceConsumed's
// rules (cumulative resets the baseline, deltas add on top).
export function cumulativeSeries(entries: UsageEntry[], periodStart: string, periodEnd: string): Array<[number, number]> {
  const start = new Date(periodStart).getTime();
  const end = new Date(periodEnd).getTime();
  const sorted = entries
    .filter((e) => {
      const t = new Date(e.recordedAt).getTime();
      return t >= start && t < end;
    })
    .sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());

  const out: Array<[number, number]> = [];
  let baseline = 0;
  let deltaSinceBaseline = 0;
  let sawCumulative = false;
  for (const e of sorted) {
    if (e.mode === 'cumulative') {
      baseline = e.value;
      deltaSinceBaseline = 0;
      sawCumulative = true;
    } else {
      deltaSinceBaseline += e.value;
    }
    const cum = sawCumulative ? baseline + deltaSinceBaseline : deltaSinceBaseline;
    out.push([new Date(e.recordedAt).getTime(), cum]);
  }
  return out;
}

// Linear regression on (timeMs, cumulative). Returns slope (units / ms) and
// intercept. Returns null if fewer than 2 points.
export function linearRegression(series: Array<[number, number]>): { slopePerMs: number; intercept: number } | null {
  if (series.length < 2) return null;
  const n = series.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const [x, y] of series) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slopePerMs: slope, intercept };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ComputeArgs {
  account: Account;
  entries: UsageEntry[];
  now?: Date;
  // Optional: pass entries from prior periods for inter-period comparison and
  // historical average. The calc only uses entries that fall within
  // resolvePeriod's window, so it's safe to pass the full account history.
  historicalEntries?: UsageEntry[];
  historyWindowPeriods?: number; // default 3
}

export function computeAccountState({
  account,
  entries,
  now = new Date(),
  historicalEntries,
  historyWindowPeriods = 3,
}: ComputeArgs): AccountState {
  const period = resolvePeriod(account.periodRule, now);
  const totalDays = periodLengthDays(period);
  const elapsed = elapsedDays(period, now);
  const remaining = Math.max(totalDays - elapsed, 0);

  const consumed = reduceConsumed(entries, period.start, period.end);

  const idealToDate = totalDays > 0 ? (account.quota * elapsed) / totalDays : 0;
  const delta = consumed - idealToDate;
  const deltaPct = account.quota > 0 ? (delta / account.quota) * 100 : 0;

  const theoreticalDailyPct = totalDays > 0 ? 100 / totalDays : 0;
  const theoreticalDailyAmount = totalDays > 0 ? account.quota / totalDays : 0;

  const remainingAmount = account.quota - consumed;
  const requiredDailyAvgRemaining = remaining > 0 ? remainingAmount / remaining : 0;

  const observedDaily = elapsed > 0 ? consumed / elapsed : 0;
  const paceDeltaDaily = observedDaily - theoreticalDailyAmount;
  const paceDeltaDailyPct = theoreticalDailyAmount > 0 ? (paceDeltaDaily / theoreticalDailyAmount) * 100 : 0;

  const projectedEndConsumption = elapsed > 0 ? observedDaily * totalDays : 0;

  // Smarter projection: linear regression on the (cumulative, time) series of
  // the current period. With ≥ 3 points the slope captures recent acceleration
  // or deceleration. Falls back to the simple projection when there's too
  // little signal.
  const series = cumulativeSeries(entries, period.start, period.end);
  let projectedEndConsumptionRecent = projectedEndConsumption;
  let projectedExhaustionDate: string | null = null;
  if (series.length >= 3) {
    const reg = linearRegression(series);
    if (reg) {
      const endMs = new Date(period.end).getTime();
      projectedEndConsumptionRecent = Math.max(0, reg.intercept + reg.slopePerMs * endMs);
      // When does cumulative cross the quota line? consumed = quota → t = (quota - intercept)/slope
      if (reg.slopePerMs > 0) {
        const crossMs = (account.quota - reg.intercept) / reg.slopePerMs;
        if (crossMs > now.getTime() && crossMs < endMs * 5 /* sanity bound */) {
          projectedExhaustionDate = new Date(crossMs).toISOString();
        }
      }
    }
  }

  // Inter-period comparison and historical average — only when the caller
  // provides historicalEntries (i.e. main process passing the full account log).
  let previous: AccountState['previous'] | undefined;
  let history: AccountState['history'] | undefined;
  if (historicalEntries && historicalEntries.length > 0) {
    const prevPeriod = previousPeriod(account.periodRule, period);
    const prevConsumed = reduceConsumed(historicalEntries, prevPeriod.start, prevPeriod.end);
    previous = {
      consumed: prevConsumed,
      quota: account.quota,
      deltaVsCurrentPct: prevConsumed > 0 ? ((consumed - prevConsumed) / prevConsumed) * 100 : 0,
    };

    const prevPeriods = previousNPeriods(account.periodRule, period, historyWindowPeriods);
    const consumedPerPeriod = prevPeriods.map((p) => reduceConsumed(historicalEntries, p.start, p.end));
    const sampleCount = consumedPerPeriod.length;
    const averageConsumed = sampleCount > 0 ? consumedPerPeriod.reduce((s, x) => s + x, 0) / sampleCount : 0;
    history = { averageConsumed, sampleCount };
  }

  const status = statusFor(deltaPct, account.tolerancePct, consumed, account.quota, remaining);

  return {
    account,
    period,
    totalDays,
    elapsedDays: elapsed,
    remainingDays: remaining,
    consumed,
    idealToDate,
    delta,
    deltaPct,
    status,
    theoreticalDailyPct,
    theoreticalDailyAmount,
    requiredDailyAvgRemaining,
    paceDeltaDaily,
    paceDeltaDailyPct,
    projectedEndConsumption,
    projectedEndConsumptionRecent,
    projectedExhaustionDate,
    previous,
    history,
  };
}

// Re-export so MS_PER_DAY isn't shadowed
export { MS_PER_DAY as _MS_PER_DAY };
