// IPC channel contract between renderer and main. Keeping it typed in one place
// so both sides stay in sync.

import type { Account, AccountState, Skill, SkillUsageReport, UsageEntry } from './types';

export interface ApiBridge {
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  upsertAccount(a: Account): Promise<void>;
  deleteAccount(id: string): Promise<void>;

  listEntries(accountId: string): Promise<UsageEntry[]>;
  insertEntry(e: UsageEntry): Promise<void>;
  deleteEntry(id: string): Promise<void>;

  computeState(accountId: string): Promise<AccountState | null>;
  computeAllStates(): Promise<AccountState[]>;

  listSkills(): Promise<Array<Pick<Skill, 'id' | 'label' | 'provider' | 'requiredSecrets' | 'requiredParams'>>>;
  setSecret(accountId: string, key: string, value: string): Promise<void>;
  syncNow(accountId: string): Promise<{ ok: boolean; error?: string; report?: SkillUsageReport }>;

  exportData(format: 'csv' | 'json'): Promise<string>; // returns file path
}

declare global {
  interface Window {
    api: ApiBridge;
  }
}

export const IPC = {
  listAccounts: 'accounts:list',
  getAccount: 'accounts:get',
  upsertAccount: 'accounts:upsert',
  deleteAccount: 'accounts:delete',
  listEntries: 'entries:list',
  insertEntry: 'entries:insert',
  deleteEntry: 'entries:delete',
  computeState: 'state:one',
  computeAllStates: 'state:all',
  listSkills: 'skills:list',
  setSecret: 'secrets:set',
  syncNow: 'skills:syncNow',
  exportData: 'data:export',
} as const;
