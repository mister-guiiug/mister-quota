// Outils communs aux connecteurs qui lisent une API d'administration (Claude,
// Cursor). Aucun appel réseau ici : seulement ce que les deux connecteurs
// doivent faire de la même façon — se nommer auprès de l'API, lire des
// centimes, ramener une période du compte aux jours UTC des API, traduire un
// échec HTTP en phrase utile, et fabriquer le rapport au format unique.
//
// Aucun message produit ici ne recopie la clé : les phrases partent dans le
// journal des synchronisations (`skill_runs`) et dans les notifications.

import type { Account, Period, Provider, SkillUsageReport, Unit } from '../../shared/types';
import { HttpError } from '../http';

// Anthropic demande aux intégrations de se nommer par leur `User-Agent`, et
// rien n'empêche de le faire aussi chez Cursor. Pas de numéro de version :
// il faudrait lire `package.json`, que ce module ne peut pas importer sans que
// `tsc` le recopie dans `dist-electron`.
export const USER_AGENT = 'mister-quota (+https://github.com/mister-guiiug/mister-quota)';

export const DAY_MS = 24 * 60 * 60 * 1000;

// Libellés du formulaire de compte : un message d'erreur doit nommer l'unité
// comme l'utilisateur l'a choisie.
const UNIT_LABELS: Record<Unit, string> = {
  tokens: 'Tokens',
  credits: 'Crédits',
  requests: 'Requêtes',
  currency: 'Devise',
};

/** « Cette API ne fournit pas l'unité du compte » — jamais un chiffre de remplacement. */
export function unsupportedUnit(api: string, unit: Unit, provides: string): Error {
  return new Error(`Unité « ${UNIT_LABELS[unit]} » non fournie par l'${api} : ${provides}.`);
}

/** Paramètre texte facultatif du compte ; absent, vide ou blanc = non renseigné. */
export function textParam(account: Account, key: string): string | undefined {
  const value = account.skillParams?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Un compteur de l'API, ou 0 s'il manque : ces API omettent les compteurs nuls. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Somme de centimes → dollars.
 *
 * Arrondie au millionième de dollar : additionner des centimes décimaux en
 * virgule flottante laisse un bruit binaire (0,1 + 0,2 = 0,30000000000000004)
 * qui finirait tel quel dans la notification de synchronisation.
 */
export function centsToDollars(cents: number): number {
  return Math.round(cents * 1e4) / 1e6;
}

export function isUsd(currency: string | undefined): boolean {
  return (currency ?? '').trim().toUpperCase() === 'USD';
}

/** La mention qui accompagne un montant en dollars posé sur un compte tenu dans une autre devise. */
export function usdNote(account: Account): string {
  const devise = account.currency?.trim() || 'non renseignée';
  return `montant en USD, non converti dans la devise du compte (${devise})`;
}

/**
 * La période du compte, ramenée aux jours UTC dans lesquels les API rangent
 * leurs chiffres (seaux quotidiens d'Anthropic, lignes quotidiennes de Cursor).
 *
 * Chaque borne va au minuit UTC le PLUS PROCHE : c'est le jour UTC qui
 * recouvre le plus le jour local. À Paris, une période ouverte le 15 à minuit
 * (le 14 à 22:00Z) se compte à partir du 15 à 00:00Z — deux heures d'écart,
 * pas vingt-deux. La règle vaut pour tous les fuseaux, y compris ceux qui ont
 * une date d'avance sur UTC.
 *
 * `aligned` n'est vrai que si la période s'ouvre à minuit UTC. Sinon le total
 * est décalé de l'écart de fuseau, et le rapport le dit (`estimated`). Seule la
 * borne de DÉBUT compte : la fin de la période en cours est dans le futur.
 */
export function utcDays(period: Period): { start: number; end: number; aligned: boolean } {
  const start = Date.parse(period.start);
  return {
    start: nearestUtcMidnight(start),
    end: nearestUtcMidnight(Date.parse(period.end)),
    aligned: start % DAY_MS === 0,
  };
}

function nearestUtcMidnight(ms: number): number {
  return Math.round(ms / DAY_MS) * DAY_MS;
}

/** La mention qui accompagne un total compté en jours UTC sur une période qui n'y tombe pas. */
export function utcDaysNote(period: Period, countedFrom: number): string {
  return `jours UTC : compté depuis ${new Date(countedFrom).toISOString()}, la période s'ouvre le ${period.start}`;
}

/**
 * Traduit l'échec d'un appel en phrase pour le journal et la notification.
 *
 * `advice` donne l'explication propre au fournisseur pour les statuts qui
 * appellent une action de l'utilisateur (mauvaise clé, plan insuffisant) ; les
 * autres reçoivent une phrase générique. La réponse du serveur est citée,
 * tronquée : c'est souvent elle qui dit précisément ce qui cloche.
 */
export function explainFailure(
  err: unknown,
  api: string,
  advice: (status: number) => string | undefined,
): Error {
  if (!(err instanceof HttpError)) {
    return new Error(`Impossible de joindre l'${api} : ${networkReason(err)}.`);
  }
  const Api = `L'${api}`;
  const message =
    advice(err.status) ??
    (err.status === 429
      ? `${Api} limite le débit (HTTP 429), même après plusieurs tentatives : réessaie plus tard.`
      : err.status >= 500
        ? `${Api} est indisponible (HTTP ${err.status}), même après plusieurs tentatives.`
        : `${Api} a refusé la requête (HTTP ${err.status}).`);
  const detail = serverMessage(err.body);
  return new Error(detail ? `${message} Réponse de l'API : « ${detail} ».` : message);
}

// `fetch` échoue en « fetch failed » et range la vraie raison (DNS, proxy,
// certificat…) dans `cause` : c'est elle qu'il faut montrer.
function networkReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'AbortError') return 'délai de réponse dépassé';
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

// Anthropic répond `{ error: { message } }`, Cursor `{ message }` ou
// `{ error: "…" }`. Une page HTML (proxy, pare-feu) n'apprend rien : on ne la
// recopie pas.
function serverMessage(body: string): string | undefined {
  const raw = body.trim();
  if (!raw) return undefined;
  let text = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    text = messageIn(parsed) ?? raw;
  } catch {
    if (raw.startsWith('<')) return undefined;
  }
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

function messageIn(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { message, error } = value as { message?: unknown; error?: unknown };
  if (typeof message === 'string') return message;
  if (typeof error === 'string') return error;
  return messageIn(error);
}

/** Le rapport au format unique (§ 6), commun aux connecteurs d'API d'administration. */
export function usageReport(args: {
  provider: Provider;
  account: Account;
  period: Period;
  consumed: number;
  // Devise du NOMBRE rendu (les deux API comptent en dollars), pas celle du compte.
  currency?: string;
  estimated: boolean;
  reference: string;
}): SkillUsageReport {
  const { account, period } = args;
  return {
    schemaVersion: 1,
    provider: args.provider,
    accountId: account.id,
    retrievedAt: new Date().toISOString(),
    period: { start: period.start, end: period.end, type: period.type, timezone: period.timezone },
    usage: {
      unit: account.unit,
      currency: args.currency,
      quota: account.quota,
      consumed: args.consumed,
      mode: 'cumulative',
      confidence: args.estimated ? 'estimated' : 'exact',
    },
    raw: { source: 'api', reference: args.reference },
  };
}
