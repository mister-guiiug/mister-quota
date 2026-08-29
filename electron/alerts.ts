// Alert evaluator. After every state computation we check whether any of the
// account's alertThresholdsPct have been crossed since last notification, fire
// an OS notification for each one, and persist the new highest threshold so
// we don't re-fire on the next tick. Thresholds reset when the period rolls
// over (we track lastAlertPeriodStart).

import { Notification } from 'electron';
import type { Storage } from './db';
import type { AccountState } from '../shared/types';
import type { Logger } from './log';

export interface AlertSink {
  notify: (title: string, body: string) => void;
}

const electronNotificationSink: AlertSink = {
  notify(title, body) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.show();
  },
};

export function evaluateAlerts(
  state: AccountState,
  storage: Storage,
  log: Logger,
  sink: AlertSink = electronNotificationSink,
): void {
  const a = state.account;
  const consumedPct = a.quota > 0 ? (state.consumed / a.quota) * 100 : 0;
  const periodStart = state.period.start;

  // Reset threshold tracking on new period.
  let lastFired = a.lastAlertedThresholdPct;
  if (a.lastAlertPeriodStart !== periodStart) lastFired = undefined;

  const thresholds = (a.alertThresholdsPct ?? []).slice().sort((x, y) => x - y);
  const crossed = thresholds.filter((t) => consumedPct >= t && (lastFired == null || t > lastFired));
  if (crossed.length === 0) {
    // Still record the period roll-over so the next tick can compare against current state.
    if (a.lastAlertPeriodStart !== periodStart) {
      storage.upsertAccount({ ...a, lastAlertedThresholdPct: undefined, lastAlertPeriodStart: periodStart });
    }
    return;
  }

  // Fire one notification per threshold crossed (typically just one per tick).
  for (const t of crossed) {
    const title = `${a.name} : seuil ${t}% atteint`;
    const body = `Consommé ${consumedPct.toFixed(1)}% sur la période courante.`;
    log.info(`alert fired: account=${a.id} threshold=${t}%`);
    sink.notify(title, body);
  }

  const highest = crossed[crossed.length - 1];
  storage.upsertAccount({ ...a, lastAlertedThresholdPct: highest, lastAlertPeriodStart: periodStart });
}
