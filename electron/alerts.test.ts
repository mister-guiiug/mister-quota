// We can't import alerts.ts directly because it imports `electron`'s
// Notification. The pure threshold logic is small enough to re-implement
// here as a unit test, mirroring the rules in alerts.ts. This test
// guards the policy: "fire once per crossing per period, reset on roll-over".

import { describe, expect, it } from 'vitest';
import type { Account } from '../shared/types';

interface Crossings {
  fired: number[];
  newLastFired: number | undefined;
}

// Mirror of evaluateAlerts' core decision (which thresholds to fire).
function decideCrossings(
  account: Pick<Account, 'alertThresholdsPct' | 'lastAlertedThresholdPct' | 'lastAlertPeriodStart'>,
  consumedPct: number,
  periodStart: string,
): Crossings {
  let lastFired = account.lastAlertedThresholdPct;
  if (account.lastAlertPeriodStart !== periodStart) lastFired = undefined;
  const sorted = (account.alertThresholdsPct ?? []).slice().sort((x, y) => x - y);
  const fired = sorted.filter((t) => consumedPct >= t && (lastFired == null || t > lastFired));
  return { fired, newLastFired: fired.length ? fired[fired.length - 1] : lastFired };
}

describe('alert threshold policy', () => {
  it('fires only thresholds that are newly crossed', () => {
    const r = decideCrossings({ alertThresholdsPct: [50, 80, 100] }, 85, '2026-05-01T00:00:00Z');
    expect(r.fired).toEqual([50, 80]);
    expect(r.newLastFired).toBe(80);
  });

  it('does not re-fire thresholds already notified in the same period', () => {
    const r = decideCrossings({
      alertThresholdsPct: [50, 80, 100],
      lastAlertedThresholdPct: 80,
      lastAlertPeriodStart: '2026-05-01T00:00:00Z',
    }, 90, '2026-05-01T00:00:00Z');
    expect(r.fired).toEqual([]);
    expect(r.newLastFired).toBe(80);
  });

  it('fires the next-higher threshold when consumption keeps growing', () => {
    const r = decideCrossings({
      alertThresholdsPct: [50, 80, 100],
      lastAlertedThresholdPct: 80,
      lastAlertPeriodStart: '2026-05-01T00:00:00Z',
    }, 100, '2026-05-01T00:00:00Z');
    expect(r.fired).toEqual([100]);
    expect(r.newLastFired).toBe(100);
  });

  it('resets when the period rolls over', () => {
    const r = decideCrossings({
      alertThresholdsPct: [50, 80, 100],
      lastAlertedThresholdPct: 100,
      lastAlertPeriodStart: '2026-04-01T00:00:00Z',
    }, 60, '2026-05-01T00:00:00Z');
    expect(r.fired).toEqual([50]);
    expect(r.newLastFired).toBe(50);
  });
});
