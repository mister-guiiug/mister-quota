import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, SkillContext } from '../../shared/types';
import { cursorSkill } from './cursor';

// Aucun appel ne part vers Cursor : `fetch` est remplacé à chaque test, et
// l'horloge est figée au 25/09/2026 10:00Z.
const NOW = new Date('2026-09-25T10:00:00Z');
const API_KEY = 'cle-admin-equipe-de-test';
const DAY = 24 * 60 * 60 * 1000;

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
    id: 'acc-cursor',
    name: 'Cursor — équipe',
    provider: 'cursor',
    periodRule: { type: 'monthly', dayOfMonth: 3, timezone: 'UTC' },
    quota: 400,
    unit: 'currency',
    currency: 'USD',
    collection: 'auto',
    skillId: 'cursor',
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
  secrets: Record<string, string> = { apiKey: API_KEY },
): SkillContext {
  return { account: account(over), secrets };
}

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

// Rend les réponses dans l'ordre (la dernière se répète) et garde chaque appel
// avec son corps décodé.
function mockFetch(...responses: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
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

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

const ms = (iso: string): number => Date.parse(iso);

describe('connecteur Cursor — déclaration', () => {
  it('est opérationnel, et `email` est un paramètre facultatif', () => {
    expect(cursorSkill.implemented).toBe(true);
    expect(cursorSkill.requiredSecrets).toEqual(['apiKey']);
    expect(cursorSkill.requiredParams).toEqual([]);
    expect(cursorSkill.optionalParams).toEqual(['email']);
  });
});

describe('connecteur Cursor — dépense (POST /teams/spend)', () => {
  it('additionne overallSpendCents (repli sur spendCents) de toutes les pages, en dollars', async () => {
    const calls = mockFetch(
      json({
        teamMemberSpend: [
          { email: 'a@equipe.fr', spendCents: 10, overallSpendCents: 1000.5 },
          { email: 'b@equipe.fr', spendCents: 250 },
        ],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalMembers: 3,
        totalPages: 2,
      }),
      json({
        teamMemberSpend: [{ email: 'c@equipe.fr', overallSpendCents: 49.5 }],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalMembers: 3,
        totalPages: 2,
      }),
    );

    const report = await cursorSkill.fetch(ctx());

    // 1000,5 + 250 + 49,5 = 1 300 centimes.
    expect(report.usage.consumed).toBe(13);
    expect(report.usage).toMatchObject({ unit: 'currency', currency: 'USD', confidence: 'exact' });
    expect(report).toMatchObject({ schemaVersion: 1, provider: 'cursor', accountId: 'acc-cursor' });
    expect(report.raw.reference).toBe(
      'cursor /teams/spend · cycle de facturation Cursor ouvert le 2026-09-03T00:00:00.000Z',
    );

    expect(calls.map((c) => c.body)).toEqual([
      { page: 1, pageSize: 100 },
      { page: 2, pageSize: 100 },
    ]);
    expect(calls[0].url).toBe('https://api.cursor.com/teams/spend');
    expect(calls[0].init.method).toBe('POST');
    // Basic : la clé en nom d'utilisateur, un mot de passe vide.
    expect(header(calls[0], 'authorization')).toBe(`Basic ${Buffer.from(`${API_KEY}:`).toString('base64')}`);
    expect(header(calls[0], 'content-type')).toBe('application/json');
    expect(header(calls[0], 'user-agent')).toMatch(/^mister-quota\b/);
  });

  it('cycle de Cursor ouvert un autre jour que la période : `estimated`, et la référence date le cycle', async () => {
    mockFetch(
      json({
        teamMemberSpend: [{ email: 'a@equipe.fr', overallSpendCents: 500 }],
        subscriptionCycleStart: ms('2026-09-10T00:00:00Z'),
        totalPages: 1,
      }),
    );

    const report = await cursorSkill.fetch(ctx());

    expect(report.usage.consumed).toBe(5);
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('cycle de facturation Cursor ouvert le 2026-09-10T00:00:00.000Z');
    expect(report.raw.reference).toContain('différent de la période du compte');
  });

  it('cycle ouvert le même jour DANS LE FUSEAU DU COMPTE : exact, même décalé de quelques heures', async () => {
    mockFetch(
      json({
        teamMemberSpend: [{ email: 'a@equipe.fr', overallSpendCents: 500 }],
        // Le 3 à 00:00Z, soit le 3 à 02:00 à Paris ; la période s'ouvre le 3 à minuit à Paris.
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );

    const report = await cursorSkill.fetch(
      ctx({ periodRule: { type: 'monthly', dayOfMonth: 3, timezone: 'Europe/Paris' } }),
    );

    expect(report.period.start).toBe('2026-09-02T22:00:00.000Z');
    expect(report.usage.confidence).toBe('exact');
  });

  it('`email` : recherche approchée côté Cursor, puis correspondance exacte à la casse près', async () => {
    const calls = mockFetch(
      json({
        teamMemberSpend: [
          { email: 'bob@exemple.fr', overallSpendCents: 500 },
          // Renvoyé par la recherche, mais ce n'est pas le même membre.
          { email: 'jimbob@exemple.fr', overallSpendCents: 99_999 },
        ],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );

    const report = await cursorSkill.fetch(ctx({ skillParams: { email: '  Bob@Exemple.fr ' } }));

    expect(calls[0].body).toEqual({ page: 1, pageSize: 100, searchTerm: 'Bob@Exemple.fr' });
    expect(report.usage.consumed).toBe(5);
    expect(report.raw.reference).toContain('membre Bob@Exemple.fr');
  });

  it('`email` vide : toute l’équipe, sans recherche', async () => {
    const calls = mockFetch(
      json({
        teamMemberSpend: [{ email: 'a@equipe.fr', overallSpendCents: 100 }],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );
    await cursorSkill.fetch(ctx({ skillParams: { email: '   ' } }));
    expect(calls[0].body).toEqual({ page: 1, pageSize: 100 });
  });

  it('`email` inconnu de l’équipe : erreur explicite, pas une dépense nulle', async () => {
    mockFetch(
      json({
        teamMemberSpend: [{ email: 'jimbob@exemple.fr', overallSpendCents: 700 }],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );
    await expect(cursorSkill.fetch(ctx({ skillParams: { email: 'bob@exemple.fr' } }))).rejects.toThrow(
      /Aucun membre de l'équipe Cursor n'a l'adresse « bob@exemple\.fr »/,
    );
  });

  it('compte tenu en euros : dollars non convertis, `estimated`, et la référence le dit', async () => {
    mockFetch(
      json({
        teamMemberSpend: [{ email: 'a@equipe.fr', overallSpendCents: 1234 }],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );

    const report = await cursorSkill.fetch(ctx({ currency: 'EUR' }));

    expect(report.usage.consumed).toBe(12.34);
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('montant en USD, non converti dans la devise du compte (EUR)');
  });

  it('rejoue un POST après un 503, avec le même corps', async () => {
    const calls = mockFetch(
      json({ message: 'indisponible' }, 503, { 'retry-after': '0' }),
      json({
        teamMemberSpend: [{ email: 'a@equipe.fr', overallSpendCents: 100 }],
        subscriptionCycleStart: ms('2026-09-03T00:00:00Z'),
        totalPages: 1,
      }),
    );

    const report = await cursorSkill.fetch(ctx());

    expect(report.usage.consumed).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe(calls[0].init.body);
  });
});

describe('connecteur Cursor — requêtes (POST /teams/daily-usage-data)', () => {
  // Période personnalisée de 60 jours ouverte le 16/08 : au 25/09, 40 jours se
  // sont écoulés — plus que les 30 qu'un appel peut couvrir.
  const LONG = {
    type: 'custom',
    startDate: '2026-08-16T00:00:00.000Z',
    periodLengthDays: 60,
    timezone: 'UTC',
  } as const;

  it('découpe la période en tranches de 30 jours au plus, sans rien demander au delà de maintenant', async () => {
    const calls = mockFetch(json({ data: [] }));

    await cursorSkill.fetch(ctx({ unit: 'requests', periodRule: LONG }));

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.cursor.com/teams/daily-usage-data',
      'https://api.cursor.com/teams/daily-usage-data',
    ]);
    expect(calls.map((c) => c.body)).toEqual([
      { startDate: ms('2026-08-16T00:00:00Z'), endDate: ms('2026-09-15T00:00:00Z') - 1 },
      { startDate: ms('2026-09-15T00:00:00Z'), endDate: NOW.getTime() - 1 },
    ]);
    for (const { body } of calls) {
      expect((body.endDate as number) - (body.startDate as number)).toBeLessThan(30 * DAY);
    }
  });

  it('additionne les trois compteurs facturables, et eux seuls, chaque jour dans sa seule tranche', async () => {
    mockFetch(
      json({
        data: [
          {
            email: 'a@equipe.fr',
            date: ms('2026-08-20T00:00:00Z'),
            subscriptionIncludedReqs: 10,
            usageBasedReqs: 2,
            apiKeyReqs: 1,
            composerRequests: 99,
            chatRequests: 99,
            agentRequests: 99,
            cmdkUsages: 99,
          },
          { email: 'b@equipe.fr', date: ms('2026-08-21T00:00:00Z'), subscriptionIncludedReqs: 5 },
          // Jour de bord rendu en trop par la première tranche : il appartient à la seconde.
          { email: 'a@equipe.fr', date: ms('2026-09-15T00:00:00Z'), subscriptionIncludedReqs: 1000 },
        ],
      }),
      json({
        data: [
          { email: 'a@equipe.fr', date: String(ms('2026-09-15T00:00:00Z')), subscriptionIncludedReqs: 7 },
        ],
      }),
    );

    const report = await cursorSkill.fetch(ctx({ unit: 'requests', periodRule: LONG }));

    // (10 + 2 + 1) + 5 + 7 ; les compteurs par fonctionnalité ne comptent pas.
    expect(report.usage.consumed).toBe(25);
    expect(report.usage).toMatchObject({ unit: 'requests', confidence: 'exact' });
    expect(report.usage.currency).toBeUndefined();
    expect(report.raw.reference).toBe('cursor /teams/daily-usage-data');
  });

  it('`email` : ne compte que les lignes de ce membre', async () => {
    mockFetch(
      json({
        data: [
          {
            email: 'Bob@Exemple.fr',
            date: ms('2026-09-04T00:00:00Z'),
            subscriptionIncludedReqs: 3,
            usageBasedReqs: 1,
          },
          { email: 'jimbob@exemple.fr', date: ms('2026-09-04T00:00:00Z'), subscriptionIncludedReqs: 50 },
        ],
      }),
    );

    const report = await cursorSkill.fetch(
      ctx({ unit: 'requests', skillParams: { email: 'bob@exemple.fr' } }),
    );

    expect(report.usage.consumed).toBe(4);
  });

  it('période ouverte à minuit à Paris : jours UTC les plus proches, `estimated`', async () => {
    const calls = mockFetch(json({ data: [] }));

    const report = await cursorSkill.fetch(
      ctx({ unit: 'requests', periodRule: { type: 'monthly', dayOfMonth: 15, timezone: 'Europe/Paris' } }),
    );

    expect(calls[0].body.startDate).toBe(ms('2026-09-15T00:00:00Z'));
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('jours UTC');
  });

  it('ligne sans date lisible : erreur plutôt qu’un total douteux', async () => {
    mockFetch(json({ data: [{ email: 'a@equipe.fr', date: 'hier', subscriptionIncludedReqs: 3 }] }));
    await expect(cursorSkill.fetch(ctx({ unit: 'requests' }))).rejects.toThrow(
      /Réponse inattendue de l'API Cursor \(\/teams\/daily-usage-data\)/,
    );
  });
});

describe('connecteur Cursor — jetons (POST /teams/filtered-usage-events)', () => {
  it('pagine tant que `hasNextPage` et additionne les quatre compteurs de jetons', async () => {
    const calls = mockFetch(
      json({
        usageEvents: [
          {
            userEmail: 'a@equipe.fr',
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 2,
              cacheWriteTokens: 3,
              cacheReadTokens: 4,
              totalCents: 99,
            },
          },
        ],
        pagination: { numPages: 2, currentPage: 1, pageSize: 1000, hasNextPage: true },
      }),
      json({
        usageEvents: [{ userEmail: 'b@equipe.fr', tokenUsage: { inputTokens: 10 } }],
        pagination: { numPages: 2, currentPage: 2, pageSize: 1000, hasNextPage: false },
      }),
    );

    const report = await cursorSkill.fetch(ctx({ unit: 'tokens' }));

    expect(report.usage.consumed).toBe(20);
    expect(report.usage).toMatchObject({ unit: 'tokens', confidence: 'exact' });
    expect(report.raw.reference).toBe('cursor /teams/filtered-usage-events');
    expect(calls.map((c) => c.body)).toEqual([
      { startDate: ms('2026-09-03T00:00:00Z'), endDate: NOW.getTime(), page: 1, pageSize: 1000 },
      { startDate: ms('2026-09-03T00:00:00Z'), endDate: NOW.getTime(), page: 2, pageSize: 1000 },
    ]);
  });

  it('s’arrête au plafond de pages : total partiel, `estimated`, et la référence le dit', async () => {
    const calls = mockFetch(
      json({
        usageEvents: [{ tokenUsage: { inputTokens: 1 } }],
        pagination: { hasNextPage: true },
      }),
    );

    const report = await cursorSkill.fetch(ctx({ unit: 'tokens' }));

    expect(calls).toHaveLength(30);
    expect(report.usage.consumed).toBe(30);
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('plafond de 30 pages atteint');
  });

  it('un événement sans compteur de jetons n’est pas compté, et le rapport devient `estimated`', async () => {
    mockFetch(
      json({
        usageEvents: [
          { tokenUsage: { outputTokens: 8 } },
          { kind: 'Included in Business', isTokenBasedCall: false },
        ],
        pagination: { hasNextPage: false },
      }),
    );

    const report = await cursorSkill.fetch(ctx({ unit: 'tokens' }));

    expect(report.usage.consumed).toBe(8);
    expect(report.usage.confidence).toBe('estimated');
    expect(report.raw.reference).toContain('1 événement(s) sans compteur de jetons');
  });

  it('`email` : transmis à l’API, et revérifié sur chaque événement', async () => {
    const calls = mockFetch(
      json({
        usageEvents: [
          { userEmail: 'bob@exemple.fr', tokenUsage: { inputTokens: 5 } },
          { userEmail: 'autre@exemple.fr', tokenUsage: { inputTokens: 500 } },
        ],
        pagination: { hasNextPage: false },
      }),
    );

    const report = await cursorSkill.fetch(ctx({ unit: 'tokens', skillParams: { email: 'bob@exemple.fr' } }));

    expect(calls[0].body.email).toBe('bob@exemple.fr');
    expect(report.usage.consumed).toBe(5);
  });
});

describe('connecteur Cursor — unités sans équivalent et erreurs', () => {
  it('crédits : erreur explicite, et aucun appel', async () => {
    const calls = mockFetch(json({}));
    await expect(cursorSkill.fetch(ctx({ unit: 'credits' }))).rejects.toThrow(
      /Unité « Crédits » non fournie par l'API Cursor/,
    );
    expect(calls).toHaveLength(0);
  });

  it('sans clé : erreur explicite, et aucun appel', async () => {
    const calls = mockFetch(json({}));
    await expect(cursorSkill.fetch(ctx({}, {}))).rejects.toThrow(/Clé d'API Cursor absente/);
    expect(calls).toHaveLength(0);
  });

  it('401 : il faut une clé d’administration d’équipe — sans jamais recopier la clé', async () => {
    mockFetch(json({ code: 'error', message: 'Invalid API key' }, 401));
    const error = await cursorSkill.fetch(ctx()).catch((e: Error) => e);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).toContain("clé d'API d'administration d'équipe");
    expect((error as Error).message).toContain('« Invalid API key »');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('403 : clé reconnue, mais plan ou portée insuffisants', async () => {
    mockFetch(json({ error: 'Enterprise access required' }, 403));
    await expect(cursorSkill.fetch(ctx())).rejects.toThrow(/HTTP 403.*Enterprise/);
  });

  it('404 : endpoint non disponible, nommé dans le message', async () => {
    mockFetch(json({ code: 'error', message: 'Not found' }, 404));
    await expect(cursorSkill.fetch(ctx({ unit: 'tokens' }))).rejects.toThrow(
      /ne connaît pas \/teams\/filtered-usage-events \(HTTP 404\)/,
    );
  });

  it('réponse qui n’a pas la forme documentée : erreur explicite', async () => {
    mockFetch(json({ members: [] }));
    await expect(cursorSkill.fetch(ctx())).rejects.toThrow(
      /Réponse inattendue de l'API Cursor \(\/teams\/spend\)/,
    );
  });
});
