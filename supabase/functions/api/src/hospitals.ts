// Slug policy, time zones and the effective booking rules of a hospital.
import type { Tx } from "./db.ts";

const DAY = 24 * 60 * 60_000;
/** Approved slug policy: old slugs redirect (301) for 90 days, then show "link changed"; a slug is reserved forever; at most one change per 30 days. */
export const SlugRedirectMs = 90 * DAY;
export const SlugMinChangeMs = 30 * DAY;

export function isValidSlug(slug: string | null | undefined): slug is string {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug);
}

/** "ok", "current", "bad" or "taken". */
export async function checkSlug(tx: Tx, slug: string | null, selfHospitalId: string | null): Promise<string> {
  if (!isValidSlug(slug)) return "bad";
  const [{ reserved }] = await tx<{ reserved: boolean }[]>`SELECT EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = ${slug}) AS reserved`;
  if (reserved) return "taken";
  const [owner] = await tx<{ hospital_id: string; is_primary: boolean }[]>`SELECT hospital_id, is_primary FROM hospital_slugs WHERE slug = ${slug}`;
  if (!owner) return "ok";
  if (owner.hospital_id !== selfHospitalId) return "taken";
  return owner.is_primary ? "current" : "ok";
}

export interface SlugChange {
  error: string | null;
  oldSlug?: string | null;
  nextChangeAt?: Date;
}

export async function changeSlug(tx: Tx, hospitalId: string, newSlug: string, now: Date): Promise<SlugChange> {
  const state = await checkSlug(tx, newSlug, hospitalId);
  if (state === "current") return { error: null, oldSlug: null };
  if (state !== "ok") return { error: state === "bad" ? "SLUG_INVALID" : "SLUG_TAKEN" };

  const [{ last }] = await tx<{ last: Date | null }[]>`SELECT max(retired_at) AS last FROM hospital_slugs WHERE hospital_id = ${hospitalId}`;
  if (last) {
    const next = new Date(last.getTime() + SlugMinChangeMs);
    if (next > now) return { error: "SLUG_CHANGE_TOO_SOON", nextChangeAt: next };
  }
  const [old] = await tx<{ slug: string }[]>`
    UPDATE hospital_slugs SET is_primary = false, retired_at = ${now}, redirect_until = ${new Date(now.getTime() + SlugRedirectMs)}
    WHERE hospital_id = ${hospitalId} AND is_primary
    RETURNING slug`;
  // Reclaiming one of this hospital's own old slugs re-activates that row; otherwise insert a new one.
  const reclaimed = await tx`
    UPDATE hospital_slugs SET is_primary = true, retired_at = NULL, redirect_until = NULL
    WHERE slug = ${newSlug} AND hospital_id = ${hospitalId}`;
  if (reclaimed.count === 0) await tx`INSERT INTO hospital_slugs (slug, hospital_id, is_primary) VALUES (${newSlug}, ${hospitalId}, true)`;
  return { error: null, oldSlug: old?.slug ?? null };
}

/** IANA time zones. "Today" and the no-show grace period are computed in the hospital's zone. */
export function isValidTimezone(id: string | null | undefined): boolean {
  if (typeof id !== "string" || !id.trim() || id.length > 64 || !(id === "UTC" || id.includes("/"))) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: id }).format(0);
    return true;
  } catch {
    return false;
  }
}

export async function defaultTimezone(tx: Tx): Promise<string> {
  const [{ tz }] = await tx<{ tz: string }[]>`SELECT default_timezone AS tz FROM platform_settings WHERE id`;
  return tz;
}

/** The rules that apply to one hospital: its override, otherwise the company-wide value. */
export async function effectiveRules(tx: Tx, hospitalId: string): Promise<{ windowDays: number; minNoticeMin: number; overridden: boolean }> {
  const [r] = await tx<{ w: number; n: number; o: boolean }[]>`
    SELECT coalesce(h.booking_window_days, p.booking_window_days) AS w, coalesce(h.min_notice_min, p.min_notice_min) AS n,
           (h.booking_window_days IS NOT NULL OR h.min_notice_min IS NOT NULL) AS o
    FROM hospitals h CROSS JOIN platform_settings p WHERE h.id = ${hospitalId} AND p.id`;
  return { windowDays: r.w, minNoticeMin: r.n, overridden: r.o };
}

/** Trimmed text, or null when empty or longer than max. */
export function clean(s: string | null, max: number): string | null {
  if (s === null || !s.trim() || s.trim().length > max) return null;
  return s.trim();
}
