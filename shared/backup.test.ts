import { describe, expect, it } from 'vitest';
import {
  BACKUP_APP_ID,
  BACKUP_FORMAT_VERSION,
  DB_SCHEMA_VERSION,
  buildBackup,
  buildExportCsv,
  parseBackup,
} from './backup';
import type { Account, UsageEntry } from './types';

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    name: 'Cursor Max',
    provider: 'cursor',
    periodRule: { type: 'monthly', dayOfMonth: 3, timezone: 'Europe/Paris' },
    quota: 500,
    unit: 'tokens',
    collection: 'manual',
    tolerancePct: 3,
    tags: ['perso'],
    alertThresholdsPct: [80, 100],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  };
}

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: 'e1',
    accountId: 'a1',
    recordedAt: '2026-01-02T10:00:00.000Z',
    value: 120,
    mode: 'cumulative',
    source: 'manual',
    ...over,
  };
}

function serialize(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...buildBackup({ accounts: [account()], entries: [entry()], schemaVersion: DB_SCHEMA_VERSION }),
    ...over,
  });
}

describe('buildBackup / parseBackup — aller-retour', () => {
  it('relit exactement ce qu’il a écrit', () => {
    const accounts = [
      account({ skillId: 'openai', skillParams: { projectId: 'proj_42' }, syncIntervalMinutes: 60 }),
      account({ id: 'a2', name: 'OpenAI', unit: 'currency', currency: 'EUR', collection: 'auto' }),
    ];
    const entries = [entry(), entry({ id: 'e2', accountId: 'a2', mode: 'delta', comment: 'appoint' })];

    const result = parseBackup(
      JSON.stringify(buildBackup({ accounts, entries, schemaVersion: DB_SCHEMA_VERSION })),
      DB_SCHEMA_VERSION,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup.accounts).toEqual(accounts);
    expect(result.backup.entries).toEqual(entries);
    expect(result.backup.schemaVersion).toBe(DB_SCHEMA_VERSION);
  });

  it('se déclare : app, format et version de schéma', () => {
    const file = buildBackup({ accounts: [], entries: [], schemaVersion: DB_SCHEMA_VERSION });
    expect(file.app).toBe(BACKUP_APP_ID);
    expect(file.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(file.schemaVersion).toBe(DB_SCHEMA_VERSION);
    expect(Date.parse(file.exportedAt)).not.toBeNaN();
  });
});

describe('parseBackup — ce qu’il refuse', () => {
  const refuse = (text: string, extrait: string): void => {
    const result = parseBackup(text, DB_SCHEMA_VERSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(extrait);
  };

  it('refuse ce qui n’est pas du JSON', () => refuse('<html>oups</html>', 'JSON'));

  it('refuse un JSON qui n’est pas un objet', () => refuse('[1, 2, 3]', 'objet JSON'));

  // Le cas qui compte : le fichier d'une AUTRE application. Il est reconnu à
  // son en-tête, avant que quoi que ce soit ne soit écrit.
  it('refuse le fichier d’une autre application', () => {
    refuse(JSON.stringify({ app: 'miss-contraction', formatVersion: 1, accounts: [] }), 'Mister Quota');
    refuse(JSON.stringify({ accounts: [account()], entries: [] }), 'Mister Quota');
  });

  it('refuse un format de fichier venu du futur', () =>
    refuse(serialize({ formatVersion: BACKUP_FORMAT_VERSION + 1 }), 'format'));

  it('refuse un schéma de base venu du futur, en disant quoi faire', () => {
    const result = parseBackup(serialize({ schemaVersion: DB_SCHEMA_VERSION + 1 }), DB_SCHEMA_VERSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(`v${DB_SCHEMA_VERSION + 1}`);
    expect(result.error).toContain('à jour');
  });

  it('refuse une version de schéma absurde', () => {
    refuse(serialize({ schemaVersion: 'deux' }), 'version de schéma inconnue');
    refuse(serialize({ schemaVersion: 0 }), 'version de schéma inconnue');
  });

  it('refuse un compte au type de période inventé', () =>
    refuse(
      serialize({ accounts: [{ ...account(), periodRule: { type: 'lunaire', timezone: 'Europe/Paris' } }] }),
      'hors des valeurs admises',
    ));

  it('refuse un compte sans nom', () =>
    refuse(serialize({ accounts: [{ ...account(), name: '' }] }), 'name'));

  it('refuse un relevé dont la date n’en est pas une', () =>
    refuse(serialize({ entries: [{ ...entry(), recordedAt: 'hier' }] }), 'pas une date'));

  // La base impose la clé étrangère : un relevé orphelin ferait échouer la
  // restauration à mi-chemin, donc il est refusé avant la première écriture.
  it('refuse un relevé rattaché à un compte absent du fichier', () =>
    refuse(serialize({ entries: [entry({ accountId: 'fantome' })] }), 'compte absent'));

  it('refuse deux comptes ou deux relevés de même identifiant', () => {
    refuse(serialize({ accounts: [account(), account()] }), 'même identifiant');
    refuse(serialize({ entries: [entry(), entry()] }), 'même identifiant');
  });

  it('ne renvoie jamais le contenu du fichier fautif dans son message', () => {
    const result = parseBackup(JSON.stringify({ app: 'sk-secret-du-voisin' }), DB_SCHEMA_VERSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('sk-secret-du-voisin');
  });
});

describe('parseBackup — liste blanche', () => {
  // Le fichier est du texte que n'importe qui peut éditer. Les comptes et les
  // relevés sont donc RECONSTRUITS champ par champ : ce qui n'est pas au
  // contrat n'entre pas dans la base.
  it('jette tout champ hors contrat, à commencer par une clé d’API glissée à la main', () => {
    const pollue = {
      ...account({ skillId: 'openai' }),
      apiKey: 'sk-injecte-par-le-fichier',
      adminApiKey: 'sk-admin',
      skillParams: { organizationId: 'org-1', apiKey: 'sk-dans-les-params', nested: { deep: 'non' } },
    };
    // `JSON.parse` crée un « __proto__ » comme propriété propre : un fichier
    // édité à la main peut donc tenter de polluer le prototype. La liste
    // blanche le neutralise puisqu'elle ne recopie que des champs nommés.
    const texte = serialize({ accounts: [pollue], entries: [] }).replace(
      '"id":"a1"',
      '"id":"a1","__proto__":{"polluted":true}',
    );
    expect(texte).toContain('__proto__');

    const result = parseBackup(texte, DB_SCHEMA_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const restored = result.backup.accounts[0] as unknown as Record<string, unknown>;
    expect(restored.apiKey).toBeUndefined();
    expect(restored.adminApiKey).toBeUndefined();
    expect('polluted' in restored).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // `skillParams` est le seul champ libre : il ne garde que des valeurs
    // primitives, et le fichier entier ne peut pas y cacher de structure.
    expect(restored.skillParams).toEqual({ organizationId: 'org-1', apiKey: 'sk-dans-les-params' });
    expect(JSON.stringify(restored)).not.toContain('deep');
  });

  it('complète une sauvegarde de schéma v1 avec les défauts de la migration v2', () => {
    const v1 = account();
    delete (v1 as Partial<Account>).tags;
    delete (v1 as Partial<Account>).alertThresholdsPct;

    const result = parseBackup(serialize({ schemaVersion: 1, accounts: [v1] }), DB_SCHEMA_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup.accounts[0].tags).toEqual([]);
    expect(result.backup.accounts[0].alertThresholdsPct).toEqual([80, 100]);
  });
});

describe('buildExportCsv', () => {
  it('écrit un en-tête, une ligne par relevé et un bloc d’états commenté', () => {
    const csv = buildExportCsv({ accounts: [account()], entries: [entry()], states: [] });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('account_id,account_name,recorded_at,value,mode,source,comment');
    expect(lines[1]).toBe('"a1","Cursor Max","2026-01-02T10:00:00.000Z","120","cumulative","manual",""');
    expect(csv).toContain('#STATE,account_id');
  });

  it('échappe les guillemets de TOUTES les colonnes, pas seulement du commentaire', () => {
    const csv = buildExportCsv({
      accounts: [account({ name: 'Compte "pro"' })],
      entries: [entry({ comment: 'dit "oui"' })],
      states: [],
    });
    expect(csv).toContain('"Compte ""pro"""');
    expect(csv).toContain('"dit ""oui"""');
  });
});
