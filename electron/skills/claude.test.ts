import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SkillContext } from '../../shared/types';
import { claudeSkill } from './claude';

// Aucun appel ne part vers Anthropic : `fetch` est remplacé à chaque test, et
// l'horloge est figée au 25/09/2026 10:00Z — le milieu d'une période mensuelle
// ouverte le 15.
const NOW = new Date('2026-09-25T10:00:00Z');
const ADMIN_KEY = 'sk-ant-admin01-cle-de-test';

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function account(over: Partial<Account> = {}): Account {
  return {
    id: 'acc-anthropic',
    name: 'Anthropic — organisation',
    provider: 'claude',
    periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'UTC' },
    quota: 10_000_000,
    unit: 'tokens',
    collection: 'auto',
    skillId: 'claude',
    tolerancePct: 3,
    tags: [],
    alertThresholdsPct: [80, 100],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function ctx(
  over: Partial<Account> = {},
  secrets: Record<string, string> = { adminApiKey: ADMIN_KEY },
): SkillContext {
  return { account: account(over), secrets };
}

interface Call {
  url: URL;
  init: RequestInit;
}

// Rend les réponses dans l'ordre (la dernière se répète) et garde chaque appel.
// Des fabriques, pas des `Response` : un corps ne se lit qu'une fois, et une
// nouvelle tentative doit recevoir une réponse neuve.
function mockFetch(...responses: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    return responses[Math.min(calls.length, responses.length) - 1]();
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

// Une page de rapport : un tableau de résultats par seau.
function page(buckets: unknown[][], nextPage?: string): () => Response {
  return json({
    data: buckets.map((results) => ({ starting_at: 'x', ending_at: 'y', results })),
    has_more: nextPage !== undefined,
    next_page: nextPage ?? null,
  });
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

describe('connecteur Claude — déclaration', () => {
  it('est opérationnel et ne réclame plus d’identifiant d’organisation', () => {
    expect(claudeSkill.implemented).toBe(true);
    expect(claudeSkill.requiredParams).toEqual([]);
    expect(claudeSkill.requiredSecrets).toEqual(['adminApiKey']);
  });
});

describe('connecteur Claude — jetons (usage_report/messages)', () => {
  it('additionne toutes les catégories de jetons, et elles seules, sur tous les seaux', async () => {
    const calls = mockFetch(
      page([
        [
          {
            uncached_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
            cache_read_input_tokens: 30,
            output_tokens: 40,
            server_tool_use: { web_search_requests: 7 },
            model: null,
            workspace_id: null,
          },
        ],
        [{ uncached_input_tokens: 1, output_tokens: 2 }],
        [],
      ]),
    );

    const report = await claudeSkill.fetch(ctx());

    // 100 + 10 + 20 + 30 + 40, puis 1 + 2 ; les recherches web ne sont pas des jetons.
    expect(report.usage.consumed).toBe(203);
    expect(report.usage).toMatchObject({ unit: 'tokens', mode: 'cumulative', confidence: 'exact' });
    expect(report.usage.currency).toBeUndefined();
    expect(report).toMatchObject({ schemaVersion: 1, provider: 'claude', accountId: 'acc-anthropic' });
    expect(report.raw).toEqual({ source: 'api', reference: 'anthropic usage_report/messages' });

    expect(calls).toHaveLength(1);
    const { url } = calls[0];
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://api.anthropic.com/v1/organizations/usage_report/messages',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      starting_at: '2026-09-15T00:00:00Z',
      // La fin du jour UTC en cours : le seau d'aujourd'hui se termine là.
      ending_at: '2026-09-26T00:00:00Z',
      bucket_width: '1d',
      limit: '31',
    });
    expect(calls[0].init.method).toBeUndefined();
    expect(header(calls[0], 'x-api-key')).toBe(ADMIN_KEY);
    expect(header(calls[0], 'anthropic-version')).toBe('2023-06-01');
    expect(header(calls[0], 'user-agent')).toMatch(/^mister-quota\b/);
  });

  it('suit la pagination avec `page` = `next_page` tant que `has_more`', async () => {
    const calls = mockFetch(
      page([[{ output_tokens: 5 }]], 'page_MjAyNi0wOS0xNg=='),
      page([[{ output_tokens: 7 }]]),
    );

    const report = await claudeSkill.fetch(ctx());

    expect(report.usage.consumed).toBe(12);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.has('page')).toBe(false);
    expect(calls[1].url.searchParams.get('page')).toBe('page_MjAyNi0wOS0xNg==');
    // Les autres paramètres ne bougent pas d'une page à l'autre.
    expect(calls[1].url.searchParams.get('starting_at')).toBe('2026-09-15T00:00:00Z');
    expect(calls[1].url.searchParams.get('ending_at')).toBe('2026-09-26T00:00:00Z');
  });

  it('compte une période ouverte à minuit à Paris sur les jours UTC les plus proches, en `estimated`', async () => {
    const calls = mockFetch(page([[{ output_tokens: 1 }]]));

    const report = await claudeSkill.fetch(
      ctx({ periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'Europe/Paris' } }),
    );

    // Minuit à Paris le 15 = le 14 à 22:00Z ; le jour UTC le plus proche est le 15.
    expect(report.period.start).toBe('2026-09-14T22:00:00.000Z');
    expect(calls[0].url.searchParams.get('starting_at')).toBe('2026-09-15T00:00:00Z');
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('jours UTC');
  });

  it('ne demande rien tant qu’aucun jour UTC de la période n’a commencé', async () => {
    // 23:00Z le 14 = 01:00 à Paris le 15 : la période locale est ouverte, mais
    // le premier jour UTC qu'on lui attribue ne commence qu'à minuit UTC.
    vi.setSystemTime(new Date('2026-09-14T23:00:00Z'));
    const calls = mockFetch(page([]));

    const report = await claudeSkill.fetch(
      ctx({ periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'Europe/Paris' } }),
    );

    expect(calls).toHaveLength(0);
    expect(report.usage.consumed).toBe(0);
    expect(report.usage.confidence).toBe('estimated');
  });

  it('ignore l’`organizationId` d’un compte enregistré avant : la collecte fonctionne, l’URL ne le porte pas', async () => {
    const calls = mockFetch(page([[{ output_tokens: 3 }]]));

    const report = await claudeSkill.fetch(ctx({ skillParams: { organizationId: 'org-ancien-compte' } }));

    expect(report.usage.consumed).toBe(3);
    expect(calls[0].url.toString()).not.toContain('org-ancien-compte');
    expect(calls[0].url.pathname).toBe('/v1/organizations/usage_report/messages');
  });

  it('refuse une pagination qui annonce une suite sans curseur, plutôt que de rendre un total amputé', async () => {
    mockFetch(json({ data: [{ results: [{ output_tokens: 1 }] }], has_more: true, next_page: null }));
    await expect(claudeSkill.fetch(ctx())).rejects.toThrow(/Réponse inattendue de l'API Anthropic/);
  });

  it('refuse une réponse qui n’a pas la forme documentée', async () => {
    mockFetch(json({ rows: [] }));
    await expect(claudeSkill.fetch(ctx())).rejects.toThrow(/Réponse inattendue/);
  });
});

describe('connecteur Claude — coûts (cost_report)', () => {
  it('convertit les centimes en dollars : "123.45" vaut 1,2345 $ (compte en USD : exact)', async () => {
    const calls = mockFetch(
      page([
        [
          { amount: '123.45', currency: 'USD' },
          { amount: '0.55', currency: 'USD' },
        ],
        [{ amount: '76', currency: 'USD' }],
        [],
      ]),
    );

    const report = await claudeSkill.fetch(ctx({ unit: 'currency', currency: 'USD' }));

    // 123,45 + 0,55 + 76 = 200 centimes.
    expect(report.usage.consumed).toBe(2);
    expect(report.usage).toMatchObject({ unit: 'currency', currency: 'USD', confidence: 'exact' });
    expect(report.raw.reference).toBe('anthropic cost_report');

    const { url } = calls[0];
    expect(url.pathname).toBe('/v1/organizations/cost_report');
    // Seaux quotidiens seulement : pas de `bucket_width` à choisir.
    expect(Object.fromEntries(url.searchParams)).toEqual({
      starting_at: '2026-09-15T00:00:00Z',
      ending_at: '2026-09-26T00:00:00Z',
      limit: '31',
    });
  });

  it('garde les décimales des centimes sans bruit binaire', async () => {
    mockFetch(page([[{ amount: '123.78912', currency: 'USD' }, { amount: '0.1' }, { amount: '0.2' }]]));
    const report = await claudeSkill.fetch(ctx({ unit: 'currency', currency: 'USD' }));
    // 124,08912 centimes, arrondis au millionième de dollar — et pas
    // 1.2408912000000001.
    expect(report.usage.consumed).toBe(1.240891);
  });

  it('ne convertit pas un compte tenu en euros : même montant en dollars, `estimated`, et la référence le dit', async () => {
    mockFetch(page([[{ amount: '250', currency: 'USD' }]]));

    const report = await claudeSkill.fetch(ctx({ unit: 'currency', currency: 'EUR' }));

    expect(report.usage.consumed).toBe(2.5);
    expect(report.usage.currency).toBe('USD');
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('USD');
    expect(report.raw.reference).toContain('EUR');
  });

  it('refuse un montant illisible plutôt que de le compter pour zéro', async () => {
    mockFetch(page([[{ amount: 'douze', currency: 'USD' }]]));
    await expect(claudeSkill.fetch(ctx({ unit: 'currency', currency: 'USD' }))).rejects.toThrow(
      /montant illisible/,
    );
  });

  it('refuse un montant dans une autre devise que l’USD plutôt que de mélanger les devises', async () => {
    mockFetch(page([[{ amount: '100', currency: 'EUR' }]]));
    await expect(claudeSkill.fetch(ctx({ unit: 'currency', currency: 'USD' }))).rejects.toThrow(/« EUR »/);
  });
});

describe('connecteur Claude — unités sans équivalent', () => {
  it.each(['requests', 'credits'] as const)('%s : erreur explicite, et aucun appel', async (unit) => {
    const calls = mockFetch(page([]));
    await expect(claudeSkill.fetch(ctx({ unit }))).rejects.toThrow(/non fournie par l'API Anthropic/);
    expect(calls).toHaveLength(0);
  });
});

describe('connecteur Claude — erreurs', () => {
  it('sans clé : erreur explicite, et aucun appel', async () => {
    const calls = mockFetch(page([]));
    await expect(claudeSkill.fetch(ctx({}, {}))).rejects.toThrow(/Clé Admin Anthropic absente/);
    expect(calls).toHaveLength(0);
  });

  it.each([401, 403])('%i : dit qu’il faut une clé Admin d’organisation, et cite l’API', async (status) => {
    mockFetch(
      json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, status),
    );

    const error = await claudeSkill.fetch(ctx()).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`HTTP ${status}`);
    expect((error as Error).message).toContain("clé Admin d'organisation (sk-ant-admin01-…)");
    expect((error as Error).message).toContain('« invalid x-api-key »');
  });

  it('reconnaît une clé d’API ordinaire, sans jamais la recopier dans le message', async () => {
    mockFetch(json({ type: 'error', error: { message: 'invalid x-api-key' } }, 401));
    const error = await claudeSkill
      .fetch(ctx({}, { adminApiKey: 'sk-ant-api03-secret-ordinaire' }))
      .catch((e: Error) => e);
    expect((error as Error).message).toContain("clé d'API ordinaire");
    expect((error as Error).message).not.toContain('secret-ordinaire');
  });

  it('404 : l’API n’est ouverte qu’aux organisations, pas aux comptes individuels', async () => {
    mockFetch(json({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }, 404));
    await expect(claudeSkill.fetch(ctx())).rejects.toThrow(/HTTP 404.*comptes individuels/);
  });

  it('429 persistant : rejoue la requête, puis dit que le débit est limité', async () => {
    // `retry-after: 0` : les nouvelles tentatives se font sans attendre.
    const calls = mockFetch(json({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' }));
    await expect(claudeSkill.fetch(ctx())).rejects.toThrow(/limite le débit \(HTTP 429\)/);
    expect(calls).toHaveLength(4);
  });

  it('coupure réseau : dit que l’API est injoignable, et pourquoi', async () => {
    // Les attentes entre tentatives sont réelles dans `fetchWithRetry` : on
    // fait avancer une horloge simulée au lieu de les subir.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.anthropic.com') });
    }) as typeof fetch;

    const outcome = claudeSkill.fetch(ctx()).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await outcome;

    expect((error as Error).message).toBe(
      "Impossible de joindre l'API Anthropic : fetch failed (getaddrinfo ENOTFOUND api.anthropic.com).",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
  });
});
