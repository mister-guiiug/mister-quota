// Restauration d'une sauvegarde — l'ORDRE des opérations, isolé de toute
// dépendance Electron pour être exécutable en test.
//
// Cet ordre est la fonctionnalité :
//
//  1. valider, puis
//  2. demander confirmation si la base n'est pas vide, puis
//  3. écrire, en une transaction.
//
// Un fichier venu d'une autre application, ou d'un schéma inconnu, s'arrête à
// l'étape 1 : rien n'a été effacé, et l'utilisateur n'a même pas été dérangé
// par une demande de confirmation. C'est la raison d'être de ce module : tant
// que la logique vivait dans un `ipcMain.handle`, personne ne pouvait le
// prouver.

import { parseBackup } from '../shared/backup';
import type { ImportBackupResult } from '../shared/ipc';
import type { Account, UsageEntry } from '../shared/types';

export interface RestoreStorage {
  schemaVersion(): number;
  counts(): { accounts: number; entries: number; skillRuns: number };
  replaceAll(data: { accounts: Account[]; entries: UsageEntry[] }): { accounts: number; entries: number };
}

export interface RestoreSecrets {
  // Les secrets ne sont ni lus ni écrits par une restauration. Le seul geste
  // est un ÉLAGAGE : une clé d'API ne doit pas survivre au compte qu'elle
  // servait, effacé par le remplacement.
  pruneOrphans(keptAccountIds: string[]): Promise<number>;
}

export async function restoreFromBackup(
  deps: { storage: RestoreStorage; secrets: RestoreSecrets; log?: (msg: string) => void },
  jsonText: string,
  opts: { confirmed?: boolean } = {},
): Promise<ImportBackupResult> {
  const parsed = parseBackup(jsonText, deps.storage.schemaVersion());
  if (!parsed.ok) {
    deps.log?.(`restauration refusée : ${parsed.error}`);
    return { ok: false, reason: 'invalid', error: parsed.error };
  }

  const existing = deps.storage.counts();
  if (!opts.confirmed && (existing.accounts > 0 || existing.entries > 0)) {
    return {
      ok: false,
      reason: 'needs_confirmation',
      existing,
      incoming: { accounts: parsed.backup.accounts.length, entries: parsed.backup.entries.length },
    };
  }

  try {
    const written = deps.storage.replaceAll(parsed.backup);
    await deps.secrets.pruneOrphans(parsed.backup.accounts.map((a) => a.id));
    deps.log?.(`restauration : ${written.accounts} comptes, ${written.entries} relevés`);
    return { ok: true, ...written };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.log?.(`restauration échouée : ${error}`);
    return { ok: false, reason: 'failed', error };
  }
}
