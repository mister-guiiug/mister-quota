// Period resolution: given a PeriodRule and a "now", compute the current period
// [start, end). Dates are normalized to UTC ISO strings, but boundary computation
// happens in the account's timezone so e.g. "every Monday in Europe/Paris" lands
// at the right local midnight.

import { addDays, addMonths, addYears, differenceInCalendarDays } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import type { Period, PeriodRule } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfDayInTz(date: Date, timezone: string): Date {
  const z = toZonedTime(date, timezone);
  z.setHours(0, 0, 0, 0);
  return fromZonedTime(z, timezone);
}

function setLocal(year: number, month: number, day: number, timezone: string): Date {
  // month is 1..12 here for clarity
  const ymd = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T00:00:00`;
  return fromZonedTime(ymd, timezone);
}

function daysInMonth(year: number, month: number): number {
  // month 1..12
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
  const local = toZonedTime(now, tz);
  // Convert JS day (0=Sun..6=Sat) to ISO (1=Mon..7=Sun)
  const jsDay = local.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  let diff = isoDay - weekday;
  if (diff < 0) diff += 7;
  const startLocal = new Date(local);
  startLocal.setHours(0, 0, 0, 0);
  startLocal.setDate(startLocal.getDate() - diff);
  const start = fromZonedTime(startLocal, tz);
  const end = addDays(start, 7);
  return { start: start.toISOString(), end: end.toISOString(), type: 'weekly', timezone: tz };
}

function resolveMonthly(rule: PeriodRule, now: Date, tz: string): Period {
  const dom = rule.dayOfMonth ?? 1;
  const local = toZonedTime(now, tz);
  const year = local.getFullYear();
  const month = local.getMonth() + 1; // 1..12
  // Anchor day for this month, clamped to the month's length.
  const thisAnchorDay = Math.min(dom, daysInMonth(year, month));
  const thisAnchor = setLocal(year, month, thisAnchorDay, tz);
  let start: Date;
  let end: Date;
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
  return { start: start.toISOString(), end: end.toISOString(), type: 'monthly', timezone: tz };
}

function resolveYearly(rule: PeriodRule, now: Date, tz: string): Period {
  const month = rule.month ?? 1;
  const day = rule.day ?? 1;
  const local = toZonedTime(now, tz);
  const year = local.getFullYear();
  // Clamp Feb 29 in non-leap years to Feb 28.
  const safeDay = (m: number, d: number, y: number) => Math.min(d, daysInMonth(y, m));
  const thisAnchor = setLocal(year, month, safeDay(month, day, year), tz);
  let start: Date;
  let end: Date;
  if (now.getTime() >= thisAnchor.getTime()) {
    start = thisAnchor;
    end = setLocal(year + 1, month, safeDay(month, day, year + 1), tz);
  } else {
    start = setLocal(year - 1, month, safeDay(month, day, year - 1), tz);
    end = thisAnchor;
  }
  return { start: start.toISOString(), end: end.toISOString(), type: 'yearly', timezone: tz };
}

function resolveCustom(rule: PeriodRule, now: Date, tz: string): Period {
  if (!rule.startDate || !rule.periodLengthDays || rule.periodLengthDays <= 0) {
    throw new Error('custom periodRule requires startDate and periodLengthDays > 0');
  }
  const anchor = startOfDayInTz(new Date(rule.startDate), tz);
  const cyclesElapsed = Math.floor(differenceInCalendarDays(now, anchor) / rule.periodLengthDays);
  const start = addDays(anchor, cyclesElapsed * rule.periodLengthDays);
  const end = addDays(start, rule.periodLengthDays);
  return { start: start.toISOString(), end: end.toISOString(), type: 'custom', timezone: tz };
}

export function periodLengthDays(period: Period): number {
  return (new Date(period.end).getTime() - new Date(period.start).getTime()) / MS_PER_DAY;
}

export function elapsedDays(period: Period, now: Date = new Date()): number {
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  const t = Math.min(Math.max(now.getTime(), start), end);
  return (t - start) / MS_PER_DAY;
}

// Re-export for tests/UI
export const _internal = { addDays, addMonths, addYears };
