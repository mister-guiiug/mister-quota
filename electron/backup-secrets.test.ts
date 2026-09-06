// Le livrable de sécurité de cette application : les clés d'API vivent dans le
// trousseau du système (`electron/secrets.ts` → Keychain / DPAPI / libsecret).
//
// Deux propriétés doivent tenir, et elles sont exactement ce que ce fichier
// exécute contre le VRAI code d'export et de restauration :
//
//   1. une sauvegarde ne contient jamais de clé — ni celle du trousseau, ni une
//      clé posée par erreur sur un objet en mémoire ;
//   2. une restauration n'en écrit jamais — même si le fichier restauré en
//      contient, et il peut : c'est du texte que n'importe qui peut éditer.
//
// Le fichier joue aussi l'ordre validation → confirmation → écriture, parce
// qu'un fichier refusé ne doit rien effacer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from './db';
import { SecretsStore } from './secrets';
import { restoreFromBackup } from './restore';
import { buildBackup, buildExportCsv } from '../shared/backup';
import { computeAccountState } from '../shared/calc';
import type { Account, UsageEntry } from '../shared/types';

// Pas de trousseau dans un test Node : `SecretsStore` importe `safeStorage`
// d'Electron, que `vi.mock` intercepte avant tout chargement. Le faux fait le
// minimum utile — il enveloppe la valeur sans la brouiller — pour que le
// sentinelle soit RECHERCHABLE dans les fichiers écrits. Une recherche qui
// échouerait faute de pouvoir trouver ne prouverait rien.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`coffre:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').slice('coffre:'.length),
  },
}));

const SENTINELLE = 'sk-ant-admin-SENTINELLE-ne-doit-jamais-sortir';
const silent = { info: () => {}, error: () => {} };

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    name: 'Claude Pro',
    provider: 'claude',
    periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'Europe/Paris' },
    quota: 100,
    unit: 'credits',
    collection: 'auto',
    skillId: 'claude',
    skillParams: { organizationId: 'org-demo' },
    tolerancePct: 3,
    tags: ['perso'],
    alertThresholdsPct: [80, 100],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'e1',
    accountId: 'a1',
    recordedAt: new Date().toISOString(),
    value: 42,
    mode: 'cumulative',
    source: 'manual',
    ...over,
  };
}

let dir: string;
let storage: Storage;
let secrets: SecretsStore;
const secretsPath = (): string => path.join(dir, 'secrets.json');

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'quota-secrets-'));
  storage = new Storage(silent);
  await storage.open(dir);
  secrets = new SecretsStore();
  await secrets.open(dir);
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

// Construit l'export exactement comme le fait `IPC.exportData` dans main.ts.
function exportBoth(): { json: string; csv: string } {
  const accounts = storage.listAccounts();
  const entries = accounts.flatMap((a) => storage.listEntries(a.id));
  const states = accounts.map((a) => computeAccountState({ account: a, entries: storage.listEntries(a.id) }));
  return {
    json: JSON.stringify(
      buildBackup({ accounts, entries, states, schemaVersion: storage.schemaVersion() }),
      null,
      2,
    ),
    csv: buildExportCsv({ accounts, entries, states }),
  };
}

describe('aucune clé d’API ne sort dans l’export', () => {
  it('ni la clé du trousseau, ni le chiffré qui la porte, ni le nom du secret', async () => {
    storage.upsertAccount(account());
    storage.insertEntry(entry());
    await secrets.set('a1', 'adminApiKey', SENTINELLE);

    // Garde-fou : le trousseau contient bien quelque chose, et on sait le
    // relire. Sans cette ligne, tout ce qui suit passerait sur une base vide.
    expect(secrets.get('a1', 'adminApiKey')).toBe(SENTINELLE);
    const trousseau = JSON.parse(readFileSync(secretsPath(), 'utf8')) as Record<string, string>;
    expect(Object.keys(trousseau)).toEqual(['a1:adminApiKey']);

    const { json, csv } = exportBoth();

    for (const sortie of [json, csv]) {
      // L'export n'est pas vide : il contient bien les données du compte.
      expect(sortie).toContain('Claude Pro');
      expect(sortie).not.toContain(SENTINELLE);
      expect(sortie).not.toContain('adminApiKey');
      // Ni le chiffré tel qu'il est stocké sur le disque.
      for (const chiffre of Object.values(trousseau)) expect(sortie).not.toContain(chiffre);
      // Ni le nom du fichier de secrets, qui n'a rien à faire là.
      expect(sortie).not.toContain('secrets.json');
    }

    // L'export n'a pas non plus « consommé » le secret au passage.
    expect(secrets.get('a1', 'adminApiKey')).toBe(SENTINELLE);
  });

  it('ni une clé posée par erreur sur l’objet compte en mémoire', () => {
    // Le champ n'existe pas dans le type `Account` : c'est bien le scénario
    // d'une pollution accidentelle (un connecteur qui enrichirait l'objet, un
    // `Object.assign` malheureux). L'export reconstruit les champs un par un,
    // donc il ne peut pas la recopier.
    const pollue = { ...account(), apiKey: SENTINELLE, secrets: { adminApiKey: SENTINELLE } } as Account;
    const json = JSON.stringify(buildBackup({ accounts: [pollue], entries: [], schemaVersion: 2 }));

    expect(json).toContain('Claude Pro');
    expect(json).not.toContain(SENTINELLE);
    expect(json).not.toContain('apiKey');
  });
});

describe('aucune clé d’API n’est écrite par une restauration', () => {
  it('le trousseau est intact après la restauration d’un fichier qui prétend en contenir', async () => {
    storage.upsertAccount(account());
    await secrets.set('a1', 'adminApiKey', SENTINELLE);
    const avant = readFileSync(secretsPath(), 'utf8');

    // Fichier hostile : un vrai format de sauvegarde, augmenté de tout ce qu'un
    // éditeur de texte permet d'y glisser.
    const hostile = JSON.stringify({
      app: 'mister-quota',
      formatVersion: 1,
      schemaVersion: storage.schemaVersion(),
      exportedAt: new Date().toISOString(),
      secrets: { 'a1:adminApiKey': 'sk-venu-du-fichier', 'a1:apiKey': 'sk-venu-du-fichier-2' },
      accounts: [{ ...account(), apiKey: 'sk-dans-le-compte', adminApiKey: 'sk-dans-le-compte-2' }],
      entries: [entry()],
    });

    const result = await restoreFromBackup({ storage, secrets }, hostile, { confirmed: true });
    expect(result.ok).toBe(true);

    // 1. Le fichier de secrets n'a pas bougé d'un octet : rien écrit, rien
    //    effacé (le compte `a1` est toujours là après restauration).
    expect(readFileSync(secretsPath(), 'utf8')).toBe(avant);
    // 2. Aucune clé nouvelle n'est lisible.
    expect(secrets.get('a1', 'apiKey')).toBeNull();
    expect(secrets.get('a1', 'adminApiKey')).toBe(SENTINELLE);
    // 3. Et rien de tout cela n'a atterri dans la base.
    const base = JSON.stringify(storage.listAccounts());
    expect(base).not.toContain('sk-venu-du-fichier');
    expect(base).not.toContain('sk-dans-le-compte');
    expect(base).toContain('org-demo'); // le paramètre légitime, lui, est restauré
  });

  it('la clé d’un compte que la restauration fait disparaître ne survit pas', async () => {
    storage.upsertAccount(account({ id: 'ancien' }));
    await secrets.set('ancien', 'adminApiKey', SENTINELLE);
    expect(readFileSync(secretsPath(), 'utf8')).toContain('ancien:adminApiKey');

    const sauvegarde = JSON.stringify(
      buildBackup({
        accounts: [account({ id: 'nouveau', name: 'Compte restauré' })],
        entries: [],
        schemaVersion: storage.schemaVersion(),
      }),
    );
    const result = await restoreFromBackup({ storage, secrets }, sauvegarde, { confirmed: true });
    expect(result).toEqual({ ok: true, accounts: 1, entries: 0 });

    // Une clé d'API ne doit pas rester derrière un compte que l'utilisateur ne
    // voit plus : l'élagage la retire du fichier comme de la lecture.
    expect(secrets.get('ancien', 'adminApiKey')).toBeNull();
    expect(readFileSync(secretsPath(), 'utf8')).not.toContain('ancien');
    // Et le compte restauré n'hérite évidemment de rien.
    expect(secrets.get('nouveau', 'adminApiKey')).toBeNull();
  });
});

describe('valider d’abord, écrire ensuite', () => {
  const peupler = (): void => {
    storage.upsertAccount(account());
    storage.insertEntry(entry());
  };

  it('un fichier d’une autre application est refusé sans rien effacer', async () => {
    peupler();
    const result = await restoreFromBackup(
      { storage, secrets },
      JSON.stringify({ app: 'miss-contraction', contractions: [] }),
      { confirmed: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid');
    expect(storage.counts()).toMatchObject({ accounts: 1, entries: 1 });
  });

  it('un schéma de base inconnu est refusé sans rien effacer', async () => {
    peupler();
    const futur = JSON.stringify({
      app: 'mister-quota',
      formatVersion: 1,
      schemaVersion: storage.schemaVersion() + 1,
      accounts: [],
      entries: [],
    });

    const result = await restoreFromBackup({ storage, secrets }, futur, { confirmed: true });
    if (result.ok || result.reason !== 'invalid') throw new Error('un refus de validation était attendu');
    expect(result.error).toContain('à jour');
    expect(storage.counts()).toMatchObject({ accounts: 1, entries: 1 });
  });

  it('une base non vide réclame une confirmation, et n’a rien perdu tant qu’elle n’est pas donnée', async () => {
    peupler();
    const sauvegarde = JSON.stringify(
      buildBackup({ accounts: [], entries: [], schemaVersion: storage.schemaVersion() }),
    );

    const sansConfirmation = await restoreFromBackup({ storage, secrets }, sauvegarde);
    expect(sansConfirmation).toEqual({
      ok: false,
      reason: 'needs_confirmation',
      existing: { accounts: 1, entries: 1, skillRuns: 0 },
      incoming: { accounts: 0, entries: 0 },
    });
    expect(storage.counts()).toMatchObject({ accounts: 1, entries: 1 });

    const avecConfirmation = await restoreFromBackup({ storage, secrets }, sauvegarde, { confirmed: true });
    expect(avecConfirmation).toEqual({ ok: true, accounts: 0, entries: 0 });
    expect(storage.counts()).toMatchObject({ accounts: 0, entries: 0 });
  });

  it('une base vide ne demande rien', async () => {
    const sauvegarde = JSON.stringify(
      buildBackup({ accounts: [account()], entries: [entry()], schemaVersion: storage.schemaVersion() }),
    );
    const result = await restoreFromBackup({ storage, secrets }, sauvegarde);
    expect(result).toEqual({ ok: true, accounts: 1, entries: 1 });
    expect(storage.listAccounts()[0].name).toBe('Claude Pro');
  });
});
