// Per-account sync scheduler. Each account with syncIntervalMinutes > 0 gets
// its own setInterval. Reload schedule whenever an account is upserted or
// removed so changes take effect without restart.

import type { Storage } from './db';
import type { Logger } from './log';
import type { Account } from '../shared/types';

export type SyncRunner = (accountId: string) => Promise<unknown>;

export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private storage: Storage;
  private log: Logger;
  private runner: SyncRunner;

  constructor(storage: Storage, log: Logger, runner: SyncRunner) {
    this.storage = storage;
    this.log = log;
    this.runner = runner;
  }

  reload(): void {
    const accounts = this.storage.listAccounts();
    const wanted = new Map<string, Account>();
    for (const a of accounts) {
      if ((a.syncIntervalMinutes ?? 0) > 0 && a.skillId) {
        wanted.set(a.id, a);
      }
    }

    // Cancel timers no longer needed.
    for (const [id, t] of this.timers) {
      if (!wanted.has(id)) {
        clearInterval(t);
        this.timers.delete(id);
        this.log.info(`scheduler: stopped account=${id}`);
      }
    }

    // Add / restart timers for current accounts.
    for (const a of wanted.values()) {
      const existing = this.timers.get(a.id);
      if (existing) clearInterval(existing);
      const ms = (a.syncIntervalMinutes ?? 0) * 60_000;
      const t = setInterval(() => {
        this.log.info(`scheduler: tick account=${a.id}`);
        this.runner(a.id).catch((err) => this.log.error(`scheduled sync failed account=${a.id}`, err));
      }, ms);
      this.timers.set(a.id, t);
      this.log.info(`scheduler: armed account=${a.id} interval=${a.syncIntervalMinutes}min`);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }
}
