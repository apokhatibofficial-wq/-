// Wall-clock time in a hospital's IANA time zone. Dates are "yyyy-MM-dd" strings, times minutes after midnight.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function parts(instant: Date, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(instant)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The hospital's calendar date at an instant. */
export function localDate(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

/** The hospital's clock time (HH:mm) at an instant. */
export function localTime(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** UTC offset in minutes at an instant. */
function offsetMin(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/**
 * The instant of a wall-clock time in the zone, or null when that time does not exist (skipped by a daylight-saving
 * change). A time that happens twice is taken as standard time, as .NET's TimeZoneInfo.ConvertTimeToUtc does.
 */
export function toUtc(date: string, minutes: number, tz: string): Date | null {
  const [y, m, d] = ymd(date);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  const candidates = new Set<number>();
  for (const probe of [wall - 12 * 3600_000, wall, wall + 12 * 3600_000]) {
    const utc = wall - offsetMin(new Date(probe), tz) * 60000;
    const p = parts(new Date(utc), tz);
    if (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) === wall) candidates.add(utc);
  }
  if (candidates.size === 0) return null;
  // Two valid instants: the later one is in standard time (the clock was turned back).
  return new Date(Math.max(...candidates));
}

/** Midnight at the start of a local date, in UTC (the first valid minute if midnight was skipped). */
export function dayStartUtc(date: string, tz: string): Date {
  for (let m = 0; m < 24 * 60; m += 15) {
    const t = toUtc(date, m, tz);
    if (t) return t;
  }
  throw new Error("no valid time on " + date);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = ymd(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function hhmm(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
