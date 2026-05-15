// Pure calculation functions — the domain core.
// Every number rendered by the dashboard goes through one of these.
// Kept side-effect free so it can be unit tested in isolation.

import type { Account, AccountState, Status, UsageEntry } from './types';
import { elapsedDays, periodLengthDays, resolvePeriod } from './period';

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

export interface ComputeArgs {
  account: Account;
  entries: UsageEntry[];
  now?: Date;
}

export function computeAccountState({ account, entries, now = new Date() }: ComputeArgs): AccountState {
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
  };
}
