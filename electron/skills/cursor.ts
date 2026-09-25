import { TZDate } from '@date-fns/tz';
import type { Period, Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';
import { fetchWithRetry } from '../http';
import {
  DAY_MS,
  USER_AGENT,
  centsToDollars,
  count,
  explainFailure,
  isUsd,
  textParam,
  unsupportedUnit,
  usageReport,
  usdNote,
  utcDays,
  utcDaysNote,
} from './common';

// Cursor — API d'administration d'équipe (https://api.cursor.com).
//
//   secret : apiKey — clé d'API d'ADMINISTRATION d'équipe, qu'un administrateur
//            crée dans le tableau de bord de l'équipe (cursor.com/dashboard ›
//            API Keys), avec la portée `admin:*` que la documentation exige
//            pour cette API — même si le connecteur ne fait que lire.
//            Authentification Basic : la clé en nom d'utilisateur, un mot de
//            passe vide.
//   paramètre facultatif : email — ne compter qu'un membre de l'équipe.
//
// L'API est réservée aux équipes, et la documentation réserve une partie de
// ses données au plan Enterprise : c'est le sens d'un 403 (voir `advice`).
//
// Unités — chacune lue à l'endpoint qui la mesure :
//   currency ← POST /teams/spend, le cycle de facturation EN COURS ;
//   requests ← POST /teams/daily-usage-data, en jours UTC, 30 jours par appel ;
//   tokens   ← POST /teams/filtered-usage-events, événement par événement ;
//   credits  : aucune notion de crédit dans cette API — erreur explicite.
//
// CES POST SONT DES LECTURES. `fetchWithRetry` rejoue la même `init` à chaque
// tentative (429, 5xx, coupure réseau) : sans risque ici, puisque rien n'est
// écrit côté Cursor, et le corps est une CHAÎNE — un flux ne se relirait pas.

const API = 'https://api.cursor.com';

// Limite documentée de /teams/daily-usage-data : 30 jours au plus par appel.
const DAILY_WINDOW_MS = 30 * DAY_MS;

const SPEND_PAGE_SIZE = 100;
// Garde-fou : plus de 5 000 membres, ou une pagination qui ne finit pas.
const SPEND_MAX_PAGES = 50;

// Maximum documenté pour /teams/filtered-usage-events.
const EVENTS_PAGE_SIZE = 1000;
// Plafond des jetons : 30 pages, soit 30 000 événements. Au delà, le total est
// partiel et le rapport `estimated`, plutôt qu'une synchronisation qui
// tournerait des minutes contre la limite de 60 requêtes par minute.
const EVENTS_MAX_PAGES = 30;

interface MemberSpend {
  email?: string;
  spendCents?: number;
  overallSpendCents?: number;
}

interface SpendPage {
  teamMemberSpend?: MemberSpend[];
  subscriptionCycleStart?: number;
  totalPages?: number;
}

interface DailyRow {
  email?: string;
  date?: number | string;
  subscriptionIncludedReqs?: number;
  usageBasedReqs?: number;
  apiKeyReqs?: number;
}

interface UsageEvent {
  userEmail?: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  } | null;
}

interface EventsPage {
  usageEvents?: UsageEvent[];
  pagination?: { numPages?: number; hasNextPage?: boolean };
}

interface Measure {
  consumed: number;
  estimated: boolean;
  notes: string[];
}

export const cursorSkill: Skill = {
  id: 'cursor',
  label: 'Cursor',
  provider: 'cursor',
  requiredSecrets: ['apiKey'],
  requiredParams: [],
  optionalParams: ['email'],
  implemented: true,
  async fetch(ctx): Promise<SkillUsageReport> {
    const { account } = ctx;
    if (account.unit === 'credits') {
      throw unsupportedUnit(
        'API Cursor',
        account.unit,
        'elle compte des dépenses (unité « Devise »), des requêtes et des jetons',
      );
    }
    const apiKey = ctx.secrets.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        "Clé d'API Cursor absente : renseigne « apiKey » dans le formulaire du compte (clé d'administration d'équipe).",
      );
    }
    const email = textParam(account, 'email');
    const period = resolvePeriod(account.periodRule);

    let source: string;
    let measure: Measure;
    switch (account.unit) {
      case 'currency':
        source = 'cursor /teams/spend';
        measure = await spend(apiKey, period, email);
        if (!isUsd(account.currency)) {
          measure.notes.push(usdNote(account));
          measure.estimated = true;
        }
        break;
      case 'requests':
        source = 'cursor /teams/daily-usage-data';
        measure = await billableRequests(apiKey, period, email);
        break;
      case 'tokens':
        source = 'cursor /teams/filtered-usage-events';
        measure = await tokens(apiKey, period, email);
        break;
    }

    return usageReport({
      provider: 'cursor',
      account,
      period,
      consumed: measure.consumed,
      currency: account.unit === 'currency' ? 'USD' : undefined,
      estimated: measure.estimated,
      reference: [source, ...(email ? [`membre ${email}`] : []), ...measure.notes].join(' · '),
    });
  },
};

// ─── currency : dépense du cycle en cours ───────────────────────────────────
//
// `overallSpendCents` compte TOUT l'usage du cycle, inclus dans l'abonnement
// ou facturé en plus ; `spendCents`, qui ne compte que le second, ne sert que
// de repli. Le cycle est celui de Cursor, pas la période du compte : s'il ne
// s'ouvre pas le même jour (dans le fuseau du compte), le total déborde ou
// manque une partie de la période — `estimated`. La référence dit toujours la
// date d'ouverture du cycle.
async function spend(apiKey: string, period: Period, email: string | undefined): Promise<Measure> {
  const members: MemberSpend[] = [];
  let cycleStart: number | undefined;
  let totalPages = 1;
  let truncated = false;
  for (let page = 1; page <= totalPages; page++) {
    if (page > SPEND_MAX_PAGES) {
      truncated = true;
      break;
    }
    const body = await post<SpendPage>(
      '/teams/spend',
      {
        page,
        pageSize: SPEND_PAGE_SIZE,
        // La recherche de Cursor est approchée (noms et adresses) : elle
        // réduit la liste, la correspondance exacte se fait ensuite.
        ...(email ? { searchTerm: email } : {}),
      },
      apiKey,
    );
    if (!Array.isArray(body?.teamMemberSpend)) throw unexpected('/teams/spend');
    members.push(...body.teamMemberSpend);
    if (page === 1) {
      cycleStart = epochMs(body.subscriptionCycleStart);
      totalPages = Math.max(1, count(body.totalPages));
    }
  }

  const counted = email ? members.filter((m) => sameEmail(m?.email, email)) : members;
  // Pour la dépense, la liste des membres est complète : une adresse qui n'y
  // est pas est une faute de frappe, pas une consommation nulle.
  if (email && counted.length === 0) {
    throw new Error(
      `Aucun membre de l'équipe Cursor n'a l'adresse « ${email} » (paramètre email du compte).`,
    );
  }
  let cents = 0;
  for (const m of counted) {
    cents += typeof m?.overallSpendCents === 'number' ? count(m.overallSpendCents) : count(m?.spendCents);
  }

  const notes: string[] = [];
  let estimated = truncated;
  if (cycleStart === undefined) {
    notes.push("date d'ouverture du cycle de facturation Cursor inconnue");
    estimated = true;
  } else {
    notes.push(`cycle de facturation Cursor ouvert le ${new Date(cycleStart).toISOString()}`);
    if (localDay(cycleStart, period.timezone) !== localDay(Date.parse(period.start), period.timezone)) {
      notes.push(`différent de la période du compte, ouverte le ${period.start}`);
      estimated = true;
    }
  }
  if (truncated) notes.push(`plafond de ${SPEND_MAX_PAGES} pages atteint : total partiel`);
  return { consumed: centsToDollars(cents), estimated, notes };
}

// ─── requests : requêtes facturables, jour par jour ─────────────────────────
//
// POURQUOI CES TROIS COMPTEURS. Cursor ventile chaque requête de modèle selon
// QUI la paie : l'abonnement (`subscriptionIncludedReqs`), l'usage facturé en
// plus (`usageBasedReqs`) ou la clé d'API du client (`apiKeyReqs`). Leur
// somme compte chaque requête facturable une fois, et c'est ce que mesure un
// quota de requêtes. Les compteurs par fonctionnalité (`composerRequests`,
// `chatRequests`, `agentRequests`, `cmdkUsages`) décrivent la même activité
// rangée par outil plutôt que par payeur : les y ajouter compterait les mêmes
// requêtes deux fois.
//
// Les lignes sont des jours UTC (`date` = minuit UTC) : la période est ramenée
// aux jours UTC les plus proches (`utcDays`), puis découpée en tranches de 30
// jours, sans rien demander au delà de maintenant.
async function billableRequests(apiKey: string, period: Period, email: string | undefined): Promise<Measure> {
  const days = utcDays(period);
  const to = Math.min(days.end, Date.now());
  let consumed = 0;
  for (let from = days.start; from < to; from += DAILY_WINDOW_MS) {
    const until = Math.min(from + DAILY_WINDOW_MS, to);
    // `endDate` à `until − 1` : la tranche reste sous les 30 jours quelle que
    // soit la façon dont l'API compte ses bornes.
    const body = await post<{ data?: DailyRow[] }>(
      '/teams/daily-usage-data',
      { startDate: from, endDate: until - 1 },
      apiKey,
    );
    if (!Array.isArray(body?.data)) throw unexpected('/teams/daily-usage-data');
    for (const row of body.data) {
      const day = epochMs(row?.date);
      if (day === undefined) throw unexpected('/teams/daily-usage-data');
      // Chaque jour n'est compté que dans SA tranche : si l'API rendait aussi
      // le jour de bord, il ne serait pas compté deux fois.
      if (day < from || day >= until) continue;
      if (email && !sameEmail(row.email, email)) continue;
      consumed += count(row.subscriptionIncludedReqs) + count(row.usageBasedReqs) + count(row.apiKeyReqs);
    }
  }
  return days.aligned
    ? { consumed, estimated: false, notes: [] }
    : { consumed, estimated: true, notes: [utcDaysNote(period, days.start)] };
}

// ─── tokens : somme des événements d'usage ──────────────────────────────────
//
// Les événements sont horodatés à la milliseconde : la période se demande
// telle quelle (bornes incluses côté API, d'où `end − 1`). Un événement sans
// `tokenUsage` (appel qui n'est pas facturé au jeton) a bien consommé des
// jetons, mais Cursor ne les compte pas : le total les omet, et le dit.
async function tokens(apiKey: string, period: Period, email: string | undefined): Promise<Measure> {
  const startDate = Date.parse(period.start);
  const endDate = Math.min(Date.parse(period.end) - 1, Date.now());
  let consumed = 0;
  let uncounted = 0;
  let truncated = false;
  for (let page = 1; ; page++) {
    const body = await post<EventsPage>(
      '/teams/filtered-usage-events',
      { startDate, endDate, page, pageSize: EVENTS_PAGE_SIZE, ...(email ? { email } : {}) },
      apiKey,
    );
    if (!Array.isArray(body?.usageEvents)) throw unexpected('/teams/filtered-usage-events');
    for (const event of body.usageEvents) {
      // Le filtre `email` est fait par l'API ; on le revérifie quand
      // l'événement porte l'adresse, par symétrie avec la dépense.
      if (email && typeof event?.userEmail === 'string' && !sameEmail(event.userEmail, email)) continue;
      const usage = event?.tokenUsage;
      if (!usage) {
        uncounted++;
        continue;
      }
      consumed +=
        count(usage.inputTokens) +
        count(usage.outputTokens) +
        count(usage.cacheWriteTokens) +
        count(usage.cacheReadTokens);
    }
    if (!hasNextPage(body.pagination, page)) break;
    if (page >= EVENTS_MAX_PAGES) {
      truncated = true;
      break;
    }
  }

  const notes: string[] = [];
  if (truncated) notes.push(`plafond de ${EVENTS_MAX_PAGES} pages atteint : total partiel`);
  if (uncounted > 0) notes.push(`${uncounted} événement(s) sans compteur de jetons, non comptés`);
  return { consumed, estimated: notes.length > 0, notes };
}

function hasNextPage(pagination: EventsPage['pagination'], page: number): boolean {
  if (typeof pagination?.hasNextPage === 'boolean') return pagination.hasNextPage;
  if (typeof pagination?.numPages === 'number') return page < pagination.numPages;
  return false;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: Record<string, unknown>, apiKey: string): Promise<T> {
  try {
    return await fetchWithRetry<T>({
      url: `${API}${path}`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      },
      retries: 3,
    });
  } catch (err) {
    throw explainFailure(err, `API Cursor (${path})`, (status) => advice(status, path));
  }
}

function advice(status: number, path: string): string | undefined {
  if (status === 401) {
    return (
      "Clé refusée par l'API Cursor (HTTP 401) : il faut une clé d'API d'administration d'équipe " +
      "(portée admin:*), qu'un administrateur crée dans cursor.com/dashboard › API Keys — " +
      "pas une clé d'API utilisateur."
    );
  }
  if (status === 403) {
    return (
      "Accès refusé par l'API Cursor (HTTP 403) : la clé est reconnue, mais sa portée ou le plan de " +
      "l'équipe ne donne pas accès à cette donnée. L'API d'administration est réservée aux équipes, et " +
      'Cursor réserve une partie de ses données au plan Enterprise.'
    );
  }
  if (status === 404) {
    return (
      `L'API Cursor ne connaît pas ${path} (HTTP 404) : endpoint non disponible pour le plan de ` +
      "l'équipe, ou retiré par Cursor."
    );
  }
  return undefined;
}

function unexpected(path: string): Error {
  return new Error(
    `Réponse inattendue de l'API Cursor (${path}) : son format ne correspond pas à la documentation.`,
  );
}

// Les dates de Cursor sont des millisecondes, en nombre ou en chaîne selon
// l'endpoint (`"timestamp": "1750979225854"`).
function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

// Les adresses se comparent entières, à la casse près : « bob@x.fr » ne doit
// pas compter « jimbob@x.fr », que la recherche de Cursor renverrait aussi.
function sameEmail(candidate: unknown, email: string): boolean {
  return typeof candidate === 'string' && candidate.trim().toLowerCase() === email.toLowerCase();
}

// Le jour calendaire d'un instant, lu dans le fuseau du compte : c'est à ce
// jour-là que l'utilisateur a pu caler sa période sur le cycle de Cursor.
function localDay(ms: number, timezone: string): string {
  const d = new TZDate(ms, timezone);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
