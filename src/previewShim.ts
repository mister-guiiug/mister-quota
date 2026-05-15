// Tiny in-memory backend used when the renderer runs in a plain browser
// (vite dev without Electron, e.g. the Launch Preview panel). Lets the UI
// be exercised end-to-end with sample data without spinning up Electron.

import { computeAccountState } from '@shared/calc';
import type { Account, AccountState, UsageEntry } from '@shared/types';

let accounts: Account[] = [];
let entries: UsageEntry[] = [];

function seed(): void {
  if (accounts.length > 0) return;
  accounts = [
    {
      id: 'acc-cursor',
      name: 'Cursor Max — Guillaume',
      provider: 'cursor',
      periodRule: { type: 'monthly', dayOfMonth: 3, timezone: 'Europe/Paris' },
      quota: 500_000_000,
      unit: 'tokens',
      collection: 'manual',
      tolerancePct: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'acc-claude',
      name: 'Claude Pro',
      provider: 'claude',
      periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'Europe/Paris' },
      quota: 100,
      unit: 'credits',
      collection: 'hybrid',
      skillId: 'claude',
      skillParams: { organizationId: 'org-demo' },
      tolerancePct: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'acc-openai',
      name: 'OpenAI Team',
      provider: 'openai',
      periodRule: { type: 'monthly', dayOfMonth: 1, timezone: 'Europe/Paris' },
      quota: 50,
      unit: 'currency',
      currency: 'EUR',
      collection: 'auto',
      skillId: 'openai',
      tolerancePct: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  // Seed one cumulative reading per account.
  entries = [
    { id: 'e1', accountId: 'acc-cursor', recordedAt: new Date().toISOString(), value: 320_000_000, mode: 'cumulative', source: 'manual' },
    { id: 'e2', accountId: 'acc-claude', recordedAt: new Date().toISOString(), value: 45, mode: 'cumulative', source: 'skill' },
    { id: 'e3', accountId: 'acc-openai', recordedAt: new Date().toISOString(), value: 12.4, mode: 'cumulative', source: 'skill' },
  ];
}

export function installPreviewShim(): void {
  if (window.api) return;
  seed();
  const computeAll = (): AccountState[] =>
    accounts.map((a) => computeAccountState({ account: a, entries: entries.filter((e) => e.accountId === a.id) }));

  window.api = {
    listAccounts: async () => accounts,
    getAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
    upsertAccount: async (a) => {
      const i = accounts.findIndex((x) => x.id === a.id);
      if (i >= 0) accounts[i] = a; else accounts.push(a);
    },
    deleteAccount: async (id) => {
      accounts = accounts.filter((a) => a.id !== id);
      entries = entries.filter((e) => e.accountId !== id);
    },
    listEntries: async (accountId) => entries.filter((e) => e.accountId === accountId).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
    insertEntry: async (e) => { entries.push(e); },
    deleteEntry: async (id) => { entries = entries.filter((e) => e.id !== id); },
    computeState: async (id) => {
      const a = accounts.find((x) => x.id === id);
      if (!a) return null;
      return computeAccountState({ account: a, entries: entries.filter((e) => e.accountId === id) });
    },
    computeAllStates: async () => computeAll(),
    listSkills: async () => [
      { id: 'cursor', label: 'Cursor', provider: 'cursor', requiredSecrets: ['apiKey'], requiredParams: [] },
      { id: 'claude', label: 'Claude', provider: 'claude', requiredSecrets: ['adminApiKey'], requiredParams: ['organizationId'] },
      { id: 'openai', label: 'OpenAI', provider: 'openai', requiredSecrets: ['adminApiKey'], requiredParams: [] },
      { id: 'generic', label: 'Generic', provider: 'other', requiredSecrets: [], requiredParams: [] },
    ],
    setSecret: async () => { /* no-op in preview */ },
    syncNow: async () => ({ ok: false, error: 'preview mode — no live sync' }),
    exportData: async () => 'preview://export-not-available',
  };
}
