// Tiny in-memory backend used when the renderer runs in a plain browser
// (vite dev without Electron, e.g. the Launch Preview panel). Lets the UI
// be exercised end-to-end with sample data without spinning up Electron.

import { computeAccountState } from '@shared/calc';
import { stubSkillRunError } from '@shared/collection';
import { DB_SCHEMA_VERSION, buildBackup, parseBackup } from '@shared/backup';
import type { ImportBackupResult, SkillRunRow } from '@shared/ipc';
import type { Account, AccountState, UsageEntry } from '@shared/types';

// Le registre côté aperçu doit refléter `electron/skills/index.ts` — mêmes
// identifiants, mêmes libellés, MÊME drapeau `implemented`. Un aperçu qui
// annoncerait des connecteurs opérationnels alors que l'app n'en a qu'un
// referait exactement le mensonge qu'on est en train de corriger.
const PREVIEW_SKILLS = [
  {
    id: 'cursor',
    label: 'Cursor',
    provider: 'cursor',
    requiredSecrets: ['apiKey'],
    requiredParams: [],
    implemented: false,
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    provider: 'claude',
    requiredSecrets: ['adminApiKey'],
    requiredParams: ['organizationId'],
    implemented: false,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    requiredSecrets: ['adminApiKey'],
    requiredParams: [],
    implemented: true,
  },
  {
    id: 'generic',
    label: 'Generic (modèle — ne collecte rien)',
    provider: 'other',
    requiredSecrets: [],
    requiredParams: [],
    implemented: false,
  },
] as const;

let accounts: Account[] = [];
let entries: UsageEntry[] = [];
let skillRuns: SkillRunRow[] = [];

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
      tags: ['perso'],
      alertThresholdsPct: [80, 100],
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
      tags: ['perso'],
      alertThresholdsPct: [80, 100],
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
      tags: ['pro'],
      alertThresholdsPct: [80, 100],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  // Seed one cumulative reading per account.
  entries = [
    {
      id: 'e1',
      accountId: 'acc-cursor',
      recordedAt: new Date().toISOString(),
      value: 320_000_000,
      mode: 'cumulative',
      source: 'manual',
    },
    {
      id: 'e2',
      accountId: 'acc-claude',
      recordedAt: new Date().toISOString(),
      value: 45,
      mode: 'cumulative',
      source: 'skill',
    },
    {
      id: 'e3',
      accountId: 'acc-openai',
      recordedAt: new Date().toISOString(),
      value: 12.4,
      mode: 'cumulative',
      source: 'skill',
    },
  ];
}

export function installPreviewShim(): void {
  if (window.api) return;
  seed();
  const computeAll = (): AccountState[] =>
    accounts.map((a) => {
      const own = entries.filter((e) => e.accountId === a.id);
      return computeAccountState({ account: a, entries: own, historicalEntries: own });
    });

  window.api = {
    listAccounts: async () => accounts,
    getAccount: async (id) => accounts.find((a) => a.id === id) ?? null,
    upsertAccount: async (a) => {
      const i = accounts.findIndex((x) => x.id === a.id);
      if (i >= 0) accounts[i] = a;
      else accounts.push(a);
    },
    deleteAccount: async (id) => {
      accounts = accounts.filter((a) => a.id !== id);
      entries = entries.filter((e) => e.accountId !== id);
    },
    listEntries: async (accountId) =>
      entries
        .filter((e) => e.accountId === accountId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
    insertEntry: async (e) => {
      entries.push(e);
    },
    deleteEntry: async (id) => {
      entries = entries.filter((e) => e.id !== id);
    },
    computeState: async (id) => {
      const a = accounts.find((x) => x.id === id);
      if (!a) return null;
      const own = entries.filter((e) => e.accountId === id);
      return computeAccountState({ account: a, entries: own, historicalEntries: own });
    },
    computeAllStates: async () => computeAll(),
    listSkills: async () =>
      PREVIEW_SKILLS.map((s) => ({
        ...s,
        requiredSecrets: [...s.requiredSecrets],
        requiredParams: [...s.requiredParams],
      })),
    setSecret: async () => {
      /* no-op in preview */
    },
    // Même refus qu'en vrai : un connecteur squelette n'est pas « appelé sans
    // réseau », il n'est pas appelé du tout, et le journal le dit.
    syncNow: async (accountId) => {
      const account = accounts.find((a) => a.id === accountId);
      const skill = PREVIEW_SKILLS.find((s) => s.id === account?.skillId);
      const error = skill
        ? skill.implemented
          ? 'mode aperçu — aucune synchronisation réelle'
          : stubSkillRunError(skill)
        : 'aucun connecteur configuré';
      skillRuns = [
        {
          id: crypto.randomUUID(),
          accountId,
          skillId: account?.skillId ?? '—',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          ok: false,
          error,
        },
        ...skillRuns,
      ];
      return { ok: false, error };
    },
    listSkillRuns: async (opts) =>
      skillRuns
        .filter((r) => !opts?.accountId || r.accountId === opts.accountId)
        .slice(0, opts?.limit ?? 200),
    importEntriesCsv: async () => ({ inserted: 0, errors: ['preview mode — import disabled'] }),

    // Sauvegarde et restauration fonctionnent VRAIMENT en mode aperçu : elles
    // n'ont besoin d'aucun accès disque privilégié, seulement du même format et
    // du même validateur que le processus principal. Un aperçu qui refuserait
    // l'aller-retour n'aurait rien prouvé de la symétrie.
    exportData: async (format) => {
      if (format !== 'json') return 'preview://csv-non-disponible';
      const backup = buildBackup({ accounts, entries, schemaVersion: DB_SCHEMA_VERSION });
      const name = `mister-quota-sauvegarde-${Date.now()}.json`;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      return name;
    },

    importBackup: async (jsonText, opts): Promise<ImportBackupResult> => {
      const parsed = parseBackup(jsonText, DB_SCHEMA_VERSION);
      if (!parsed.ok) return { ok: false, reason: 'invalid', error: parsed.error };
      if (!opts?.confirmed && (accounts.length > 0 || entries.length > 0)) {
        return {
          ok: false,
          reason: 'needs_confirmation',
          existing: { accounts: accounts.length, entries: entries.length, skillRuns: skillRuns.length },
          incoming: { accounts: parsed.backup.accounts.length, entries: parsed.backup.entries.length },
        };
      }
      accounts = parsed.backup.accounts;
      entries = parsed.backup.entries;
      skillRuns = [];
      return { ok: true, accounts: accounts.length, entries: entries.length };
    },
  };
}
