// IPC channel contract between renderer and main. Keeping it typed in one place
// so both sides stay in sync.

import type { Account, AccountState, Skill, SkillUsageReport, UsageEntry } from './types';

export interface SkillRunRow {
  id: string;
  accountId: string;
  skillId: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  reportJson?: string;
}

// Ce que le renderer connaît d'un connecteur. `fetch` ne traverse jamais le
// pont ; `implemented`, si — c'est ce que l'interface lit pour dire qu'un
// connecteur est un squelette (formulaire, carte du tableau de bord, journal).
export type SkillInfo = Pick<
  Skill,
  'id' | 'label' | 'provider' | 'requiredSecrets' | 'requiredParams' | 'implemented'
>;

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

  listSkills(): Promise<SkillInfo[]>;
  setSecret(accountId: string, key: string, value: string): Promise<void>;
  syncNow(accountId: string): Promise<{ ok: boolean; error?: string; report?: SkillUsageReport }>;
  listSkillRuns(opts?: { accountId?: string; limit?: number }): Promise<SkillRunRow[]>;

  importEntriesCsv(accountId: string, csvText: string): Promise<{ inserted: number; errors: string[] }>;
  exportData(format: 'csv' | 'json'): Promise<string>; // returns file path
  importBackup(jsonText: string, opts?: { confirmed?: boolean }): Promise<ImportBackupResult>;
}

// Restauration en deux temps. La VALIDATION passe d'abord : un fichier d'une
// autre application, ou d'un schéma inconnu, est refusé (`invalid`) sans que
// rien n'ait été effacé et sans qu'on ait dérangé l'utilisateur. Ce n'est que
// pour un fichier valide, sur une base non vide, que le processus principal
// réclame une confirmation explicite (`needs_confirmation`) — l'interface la
// demande puis rappelle avec `confirmed: true`. Le renderer ne décide donc
// jamais seul d'écraser la base.
export type ImportBackupResult =
  | { ok: true; accounts: number; entries: number }
  | { ok: false; reason: 'invalid'; error: string }
  | { ok: false; reason: 'failed'; error: string }
  | {
      ok: false;
      reason: 'needs_confirmation';
      existing: { accounts: number; entries: number; skillRuns: number };
      incoming: { accounts: number; entries: number };
    };

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
  listSkillRuns: 'skills:runs',
  importEntriesCsv: 'entries:importCsv',
  exportData: 'data:export',
  importBackup: 'data:importBackup',
} as const;
