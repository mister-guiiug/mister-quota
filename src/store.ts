// Zustand store. Centralises the renderer's view of accounts/states/entries
// so mutations don't need a full re-render orchestration. Each mutation calls
// the IPC bridge and then refreshes the slice it touched.

import { create } from 'zustand';
import type { Account, AccountState, UsageEntry } from '@shared/types';
import { toast } from './toast';

interface AppState {
  states: AccountState[] | null;
  entriesByAccount: Record<string, UsageEntry[]>;
  loading: boolean;

  refreshAll: () => Promise<void>;
  refreshOne: (accountId: string) => Promise<void>;
  upsertAccount: (a: Account) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  addEntry: (e: UsageEntry) => Promise<void>;
  deleteEntry: (entryId: string, accountId: string) => Promise<void>;
  syncNow: (accountId: string) => Promise<void>;
}

async function safe<T>(label: string, op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (err) {
    toast.error(`${label} : ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  states: null,
  entriesByAccount: {},
  loading: false,

  async refreshAll() {
    set({ loading: true });
    const states = await safe('Chargement des comptes', () => window.api.computeAllStates());
    set({ states: states ?? [], loading: false });
  },

  async refreshOne(accountId) {
    const state = await safe('Rechargement', () => window.api.computeState(accountId));
    if (state == null) return;
    set((s) => ({
      states: s.states ? s.states.map((x) => (x.account.id === accountId ? state : x)) : [state],
    }));
    const entries = await safe('Chargement des relevés', () => window.api.listEntries(accountId));
    if (entries) set((s) => ({ entriesByAccount: { ...s.entriesByAccount, [accountId]: entries } }));
  },

  async upsertAccount(a) {
    const ok = await safe('Enregistrement du compte', async () => {
      await window.api.upsertAccount(a);
      return true;
    });
    if (ok) {
      toast.success(`Compte « ${a.name} » enregistré`);
      await get().refreshAll();
    }
  },

  async deleteAccount(id) {
    const ok = await safe('Suppression du compte', async () => {
      await window.api.deleteAccount(id);
      return true;
    });
    if (ok) {
      toast.success('Compte supprimé');
      await get().refreshAll();
    }
  },

  async addEntry(e) {
    const ok = await safe('Ajout du relevé', async () => {
      await window.api.insertEntry(e);
      return true;
    });
    if (ok) {
      toast.success('Relevé ajouté');
      await get().refreshOne(e.accountId);
    }
  },

  async deleteEntry(entryId, accountId) {
    const ok = await safe('Suppression du relevé', async () => {
      await window.api.deleteEntry(entryId);
      return true;
    });
    if (ok) await get().refreshOne(accountId);
  },

  async syncNow(accountId) {
    const res = await safe('Synchronisation', () => window.api.syncNow(accountId));
    if (!res) return;
    if (res.ok) {
      toast.success(`Synchronisé (consommé: ${res.report?.usage.consumed ?? '?'})`);
      await get().refreshOne(accountId);
    } else {
      toast.error(`Sync échouée : ${res.error ?? 'erreur inconnue'}`);
    }
  },
}));
