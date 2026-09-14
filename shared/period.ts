// Résolution de période — à partir d'une `PeriodRule` et d'un « maintenant »,
// la fenêtre courante [début, fin). Les bornes sortent en ISO UTC, mais elles
// se CALCULENT dans le fuseau du compte : « tous les lundis en Europe/Paris »
// doit tomber sur le bon minuit local, pas sur celui de la machine.
//
// POURQUOI `@date-fns/tz` ET PLUS `date-fns-tz`. Le second rendait une `Date`
// MENTEUSE : `toZonedTime` décale l'instant pour que les accesseurs locaux
// affichent l'heure du fuseau visé, et `fromZonedTime` défait ce décalage. Tant
// qu'on ne fait que lire des champs, l'astuce tient ; dès qu'on passe cette
// valeur à `date-fns`, elle est traitée comme une date locale ORDINAIRE et
// l'arithmétique repart dans le fuseau de la MACHINE.
//
// C'était un bug réel, et pas un détail de théorie : mesuré sur un balayage de
// 47 844 cas (108 règles × 443 instants), `addDays` retombait dans le fuseau de
// la machine pour **7 087 d'entre eux**, soit 14,8 %. Un compte réglé en `UTC`
// voyait sa semaine finir à 23:00Z au lieu de 00:00Z la nuit du passage à
// l'heure d'été — parce que l'application tournait à Paris. La borne d'un
// compte dépendait du poste, pas du réglage du compte.
//
// `TZDate` est une VRAIE sous-classe de `Date` qui porte son fuseau : ses
// accesseurs lisent et écrivent dans ce fuseau, `getTime()` reste l'instant
// absolu, et `date-fns` propage le fuseau à travers ses opérations. Le bug
// devient inexprimable.
//
// DEUX PIÈGES PAYÉS ICI :
//
//  1. `TZDate.toISOString()` NE REND PAS un `Z` mais la forme décalée
//     (`2026-02-14T00:00:00.000+14:00`). Elle désigne le même instant et se
//     relit sans perte, mais `lastAlertPeriodStart` (electron/alerts.ts) est
//     comparé par ÉGALITÉ DE CHAÎNE : changer la forme aurait fait croire à un
//     changement de période à chaque tour. D'où `versInstantISO()`, qui repasse
//     par une `Date` nue en sortie de module.
//
//  2. L'ORDRE de `setDate` et `setHours` compte. Poser minuit d'abord, reculer
//     ensuite, fait porter à un jour ORDINAIRE l'anomalie d'un jour de bascule
//     — au Chili, le 6 septembre 2026 n'a pas de 00:00 local. On recule
//     d'abord, on pose minuit ensuite.

import { addDays, addMonths, addYears, differenceInCalendarDays } from 'date-fns';
import { TZDate } from '@date-fns/tz';
import type { Period, PeriodRule } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Le même instant, lu et écrit dans le fuseau du compte. */
function enZone(instant: Date, timezone: string): TZDate {
  return new TZDate(instant.getTime(), timezone);
}

/**
 * Sortie du module : toujours un ISO en `Z`.
 *
 * Voir le piège 1 en tête de fichier — `TZDate.toISOString()` rendrait la forme
 * décalée, que `lastAlertPeriodStart` comparerait à l'ancienne et jugerait
 * différente.
 */
function versInstantISO(date: Date): string {
  return new Date(date.getTime()).toISOString();
}

function startOfDayInTz(date: Date, timezone: string): TZDate {
  const z = enZone(date, timezone);
  z.setHours(0, 0, 0, 0);
  return z;
}

function setLocal(year: number, month: number, day: number, timezone: string): TZDate {
  // month is 1..12 here for clarity
  return new TZDate(year, month - 1, day, 0, 0, 0, 0, timezone);
}

function daysInMonth(year: number, month: number): number {
  // month 1..12 — arithmétique de calendrier pure, insensible au fuseau.
  return new Date(year, month, 0).getDate();
}

export function resolvePeriod(rule: PeriodRule, now: Date = new Date()): Period {
  const tz = rule.timezone || 'UTC';
  switch (rule.type) {
    case 'weekly':
      return resolveWeekly(rule, now, tz);
    case 'monthly':
      return resolveMonthly(rule, now, tz);
    case 'yearly':
      return resolveYearly(rule, now, tz);
    case 'custom':
      return resolveCustom(rule, now, tz);
  }
}

function resolveWeekly(rule: PeriodRule, now: Date, tz: string): Period {
  const weekday = rule.weekday ?? 1; // default Monday
  const local = enZone(now, tz);
  // Convert JS day (0=Sun..6=Sat) to ISO (1=Mon..7=Sun)
  const jsDay = local.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  let diff = isoDay - weekday;
  if (diff < 0) diff += 7;
  const start = enZone(now, tz);
  // Reculer PUIS poser minuit — voir le piège 2 en tête de fichier.
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  const end = addDays(start, 7);
  return {
    start: versInstantISO(start),
    end: versInstantISO(end),
    type: 'weekly',
    timezone: tz,
  };
}

function resolveMonthly(rule: PeriodRule, now: Date, tz: string): Period {
  const dom = rule.dayOfMonth ?? 1;
  const local = enZone(now, tz);
  const year = local.getFullYear();
  const month = local.getMonth() + 1; // 1..12
  // Anchor day for this month, clamped to the month's length.
  const thisAnchorDay = Math.min(dom, daysInMonth(year, month));
  const thisAnchor = setLocal(year, month, thisAnchorDay, tz);
  let start: TZDate;
  let end: TZDate;
  if (now.getTime() >= thisAnchor.getTime()) {
    start = thisAnchor;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    const nextAnchorDay = Math.min(dom, daysInMonth(nextYear, nextMonth));
    end = setLocal(nextYear, nextMonth, nextAnchorDay, tz);
  } else {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevAnchorDay = Math.min(dom, daysInMonth(prevYear, prevMonth));
    start = setLocal(prevYear, prevMonth, prevAnchorDay, tz);
    end = thisAnchor;
  }
  return {
    start: versInstantISO(start),
    end: versInstantISO(end),
    type: 'monthly',
    timezone: tz,
  };
}

function resolveYearly(rule: PeriodRule, now: Date, tz: string): Period {
  const month = rule.month ?? 1;
  const day = rule.day ?? 1;
  const local = enZone(now, tz);
  const year = local.getFullYear();
  // Clamp Feb 29 in non-leap years to Feb 28.
  const safeDay = (m: number, d: number, y: number) => Math.min(d, daysInMonth(y, m));
  const thisAnchor = setLocal(year, month, safeDay(month, day, year), tz);
  let start: TZDate;
  let end: TZDate;
  if (now.getTime() >= thisAnchor.getTime()) {
    start = thisAnchor;
    end = setLocal(year + 1, month, safeDay(month, day, year + 1), tz);
  } else {
    start = setLocal(year - 1, month, safeDay(month, day, year - 1), tz);
    end = thisAnchor;
  }
  return {
    start: versInstantISO(start),
    end: versInstantISO(end),
    type: 'yearly',
    timezone: tz,
  };
}

function resolveCustom(rule: PeriodRule, now: Date, tz: string): Period {
  if (!rule.startDate || !rule.periodLengthDays || rule.periodLengthDays <= 0) {
    throw new Error('custom periodRule requires startDate and periodLengthDays > 0');
  }
  const anchor = startOfDayInTz(new Date(rule.startDate), tz);
  // Les DEUX opérandes dans le fuseau du compte : le décompte de jours ne doit
  // pas plus dépendre de la machine que les bornes.
  const cyclesElapsed = Math.floor(differenceInCalendarDays(enZone(now, tz), anchor) / rule.periodLengthDays);
  const start = addDays(anchor, cyclesElapsed * rule.periodLengthDays);
  const end = addDays(start, rule.periodLengthDays);
  return {
    start: versInstantISO(start),
    end: versInstantISO(end),
    type: 'custom',
    timezone: tz,
  };
}

export function periodLengthDays(period: Period): number {
  return (new Date(period.end).getTime() - new Date(period.start).getTime()) / MS_PER_DAY;
}

// Resolve the period that ends just before the given period started — i.e.
// the user's previous billing window. Used for inter-period comparisons.
export function previousPeriod(rule: PeriodRule, current: Period): Period {
  // Pick a "now" that lies one millisecond before the current period starts;
  // resolvePeriod will then compute the cycle that contains that instant.
  const probe = new Date(new Date(current.start).getTime() - 1);
  return resolvePeriod(rule, probe);
}

// Resolve the N periods preceding `current`, oldest first.
export function previousNPeriods(rule: PeriodRule, current: Period, n: number): Period[] {
  const out: Period[] = [];
  let cur = current;
  for (let i = 0; i < n; i++) {
    cur = previousPeriod(rule, cur);
    out.unshift(cur);
  }
  return out;
}

export function elapsedDays(period: Period, now: Date = new Date()): number {
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  const t = Math.min(Math.max(now.getTime(), start), end);
  return (t - start) / MS_PER_DAY;
}

// Re-export for tests/UI
export const _internal = { addDays, addMonths, addYears };
