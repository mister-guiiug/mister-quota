// Secrets storage. Per the spec: API keys must be encrypted at rest using the
// OS keychain (Keychain / Windows Credential Manager / libsecret). Electron's
// safeStorage uses the right OS facility on each platform when available, and
// falls back to a transient AES key on Linux when libsecret is missing.
//
// Layout: encrypted blobs are stored in a single JSON file under userData.
// Keys look like `${accountId}:${secretKey}` (e.g. "abc123:apiKey").

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

interface SecretsFile {
  [compositeKey: string]: string;
} // base64-encoded ciphertext

export class SecretsStore {
  private filePath!: string;
  private cache: SecretsFile = {};

  async open(userDataDir: string): Promise<void> {
    this.filePath = path.join(userDataDir, 'secrets.json');
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = {};
    }
  }

  async set(accountId: string, key: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-level encryption is unavailable; refusing to store secret in plaintext.');
    }
    const cipher = safeStorage.encryptString(value);
    this.cache[`${accountId}:${key}`] = cipher.toString('base64');
    await this.persist();
  }

  get(accountId: string, key: string): string | null {
    const blob = this.cache[`${accountId}:${key}`];
    if (!blob) return null;
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  }

  resolveAll(accountId: string, keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = this.get(accountId, k);
      if (v != null) out[k] = v;
    }
    return out;
  }

  async deleteForAccount(accountId: string): Promise<void> {
    const prefix = `${accountId}:`;
    for (const k of Object.keys(this.cache)) {
      if (k.startsWith(prefix)) delete this.cache[k];
    }
    await this.persist();
  }

  // Après une restauration de sauvegarde, les comptes de la base ont été
  // intégralement remplacés sans passer par `deleteForAccount`. Une clé d'API
  // ne doit pas survivre au compte qu'elle servait : on efface celles dont
  // l'identifiant n'existe plus.
  //
  // L'opération est volontairement DESTRUCTIVE d'un seul côté : elle ne crée
  // jamais de secret. Une sauvegarde n'en contient pas et n'en écrit pas —
  // restaurer sur une machine neuve laisse les champs à ressaisir.
  async pruneOrphans(keptAccountIds: string[]): Promise<number> {
    const kept = new Set(keptAccountIds);
    let removed = 0;
    for (const k of Object.keys(this.cache)) {
      const accountId = k.slice(0, k.indexOf(':'));
      if (!kept.has(accountId)) {
        delete this.cache[k];
        removed++;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }
}
