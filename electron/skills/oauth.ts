// OAuth helper scaffold. Implements the PKCE-based authorization-code flow
// in a child BrowserWindow, listens for the redirect on a localhost loopback,
// and persists the resulting refresh_token via SecretsStore.
//
// Currently a thin wrapper — provider-specific config (auth URL, scopes,
// client ID) lives in the connector that uses it. To wire a provider:
//
//   const tokens = await runPkceFlow({
//     authorizationUrl: 'https://auth.example.com/authorize',
//     tokenUrl: 'https://auth.example.com/token',
//     clientId: 'xxx',
//     scopes: ['usage:read'],
//     redirectPath: '/callback',
//   });
//
// Then store `tokens.refreshToken` via SecretsStore.set(accountId,
// 'refreshToken', ...). On every fetch, exchange the refresh token for an
// access token (also via fetchWithRetry) before calling the provider API.

import { BrowserWindow } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fetchWithRetry } from '../http';

export interface PkceConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirectPath?: string; // default '/callback'
  redirectPort?: number; // default 0 (random)
  extraAuthParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms epoch
  raw: Record<string, unknown>;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function runPkceFlow(cfg: PkceConfig): Promise<TokenSet> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));
  const redirectPath = cfg.redirectPath ?? '/callback';

  // Spin up a tiny localhost listener for the redirect.
  const { code, port } = await new Promise<{ code: string; port: number }>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        const u = new URL(req.url ?? '/', `http://localhost`);
        if (!u.pathname.startsWith(redirectPath)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const c = u.searchParams.get('code');
        const s = u.searchParams.get('state');
        const err = u.searchParams.get('error');
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (err) {
          res.end(`<h1>Échec d'authentification: ${err}</h1>`);
          server.close();
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        if (!c || s !== state) {
          res.end('<h1>Réponse OAuth invalide</h1>');
          server.close();
          reject(new Error('OAuth: missing code or state mismatch'));
          return;
        }
        res.end('<h1>Authentification OK — vous pouvez fermer cet onglet.</h1>');
        const addr = server.address();
        const realPort = typeof addr === 'object' && addr ? addr.port : 0;
        server.close();
        resolve({ code: c, port: realPort });
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.listen(cfg.redirectPort ?? 0, '127.0.0.1');
  });

  // Open the provider's authorize URL in a new window.
  const url = new URL(cfg.authorizationUrl);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scopes.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', `http://127.0.0.1:${port}${redirectPath}`);
  for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) url.searchParams.set(k, v);

  const win = new BrowserWindow({
    width: 520,
    height: 720,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL(url.toString());

  // Exchange code for tokens.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: `http://127.0.0.1:${port}${redirectPath}`,
    code_verifier: verifier,
  });
  const tokens = await fetchWithRetry<Record<string, unknown>>({
    url: cfg.tokenUrl,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  });
  win.close();

  const expiresIn = Number(tokens.expires_in ?? 3600);
  return {
    accessToken: String(tokens.access_token),
    refreshToken: tokens.refresh_token ? String(tokens.refresh_token) : undefined,
    expiresAt: Date.now() + expiresIn * 1000,
    raw: tokens,
  };
}
