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

interface SecretsFile { [compositeKey: string]: string } // base64-encoded ciphertext

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

  private async persist(): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }
}
