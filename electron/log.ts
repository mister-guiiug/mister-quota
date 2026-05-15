// Tiny rotating file logger — keeps the last 5 files of ~1MB each in
// userData/logs. Avoids pulling a logging dep just for this.

import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1_000_000;
const KEEP = 5;

export class Logger {
  private file!: string;
  private dir!: string;

  async open(userDataDir: string): Promise<void> {
    this.dir = path.join(userDataDir, 'logs');
    await fs.mkdir(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'app.log');
  }

  info(msg: string): void { this.write('INFO ', msg); }
  error(msg: string, err?: unknown): void {
    const trail = err instanceof Error ? `\n${err.stack ?? err.message}` : err ? ` ${JSON.stringify(err)}` : '';
    this.write('ERROR', msg + trail);
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] ${level} ${msg}\n`;
    try {
      this.rotateIfNeeded();
      require('node:fs').appendFileSync(this.file, line);
    } catch {
      // logger must never throw
    }
    // Also mirror to stdout so dev mode shows logs in the terminal.
    process.stdout.write(line);
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file)) return;
    const size = statSync(this.file).size;
    if (size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const src = path.join(this.dir, `app.log.${i}`);
      const dst = path.join(this.dir, `app.log.${i + 1}`);
      if (existsSync(src)) require('node:fs').renameSync(src, dst);
    }
    require('node:fs').renameSync(this.file, path.join(this.dir, 'app.log.1'));
  }
}
