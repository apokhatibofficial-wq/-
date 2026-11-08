// Doctor profile pages (medlink.website/dr/{slug}): a company product, written only by the company (owner's decision,
// 2026-11-08). Validation of what the console sends, and the shapes the console and the public page read.
import type { Tx } from "./db.ts";

export const LinkKinds = ["instagram", "whatsapp", "facebook", "linkedin", "telegram", "tiktok", "x", "youtube", "website", "maps"] as const;
export type LinkKind = typeof LinkKinds[number];
export interface DoctorLink {
  kind: LinkKind;
  url: string;
}

export const MaxLinks = 12;
/** The console resizes photos before upload; this is the stored limit (the same as the table's CHECK). */
export const MaxPhotoBytes = 400 * 1024;
export const PhotoTypes = ["image/jpeg", "image/webp"] as const;

export interface DoctorRow {
  id: string;
  slug: string;
  name: string;
  specialty: string | null;
  about: string | null;
  phone: string | null;
  verified: boolean;
  rating: string | null; // numeric comes back as text
  links: DoctorLink[];
  shamcash: string | null;
  published: boolean;
  photo_rev: number;
  has_photo: boolean;
  created_at: Date;
  updated_at: Date;
}

export const doctorSelect = (tx: Tx) =>
  tx`SELECT id, slug, name, specialty, about, phone, verified, rating::text AS rating, links, shamcash, published, photo_rev,
            photo IS NOT NULL AS has_photo, created_at, updated_at
     FROM doctor_profiles`;

export const adminDoctorDto = (d: DoctorRow) => ({
  id: d.id,
  slug: d.slug,
  name: d.name,
  specialty: d.specialty,
  about: d.about,
  phone: d.phone,
  verified: d.verified,
  rating: d.rating === null ? null : Number(d.rating),
  links: d.links,
  shamcash: d.shamcash,
  published: d.published,
  hasPhoto: d.has_photo,
  photoRev: d.photo_rev,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
});

/** What anyone can read: no ids, dates or publication state. The photo path carries its revision, for caching. */
export const publicDoctorDto = (d: DoctorRow) => ({
  slug: d.slug,
  name: d.name,
  specialty: d.specialty,
  about: d.about,
  phone: d.phone,
  verified: d.verified,
  rating: d.rating === null ? null : Number(d.rating),
  links: d.links,
  shamcash: d.shamcash,
  photo: d.has_photo ? `/public/doctors/${d.slug}/photo?v=${d.photo_rev}` : null,
});

export interface DoctorInput {
  slug: string;
  name: string;
  specialty: string | null;
  about: string | null;
  phone: string | null;
  verified: boolean;
  rating: number | null;
  links: DoctorLink[];
  shamcash: string | null;
  published: boolean;
}

/** A field error: the API answers 422 with this code. */
export class Invalid extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function text(v: unknown, max: number, code: string, required = false): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new Invalid(code);
    return null;
  }
  if (typeof v !== "string") throw new Invalid(code);
  // Line breaks are kept (the "about" text has paragraphs); other control characters are not allowed.
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > max || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(t)) throw new Invalid(code);
  return t;
}

/** Digits with an optional leading +; spaces, dashes and brackets are removed. */
export function normalizePhone(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string") throw new Invalid("PHONE_INVALID");
  const t = v.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?[0-9]{6,15}$/.test(t)) throw new Invalid("PHONE_INVALID");
  return t;
}

/**
 * Links are https only (no javascript:, data: or http:), without a user name or password. A WhatsApp link may be
 * given as a phone number, which becomes https://wa.me/{digits}.
 */
export function normalizeLink(v: unknown): DoctorLink {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Invalid("LINK_INVALID");
  const o = v as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== "string" || !(LinkKinds as readonly string[]).includes(kind)) throw new Invalid("LINK_INVALID");
  if (typeof o.url !== "string" || !o.url.trim() || o.url.length > 500) throw new Invalid("LINK_INVALID");
  let raw = o.url.trim();
  if (kind === "whatsapp" && /^\+?[0-9\s\-()]{6,20}$/.test(raw)) {
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 15) throw new Invalid("LINK_INVALID");
    raw = "https://wa.me/" + digits;
  }
  if (!/^https:\/\//i.test(raw)) raw = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : "https://" + raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Invalid("LINK_INVALID");
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) throw new Invalid("LINK_INVALID");
  return { kind: kind as LinkKind, url: u.toString() };
}

export function parseRating(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 5 || Math.round(v * 2) !== v * 2) throw new Invalid("RATING_INVALID");
  return v;
}

const isSlug = (s: unknown): s is string => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s) && !s.includes("--");

/** The whole profile, as the console's form sends it (every save sends every field). */
export function parseDoctor(b: Record<string, unknown>): DoctorInput {
  const get = (name: string) => {
    if (name in b) return b[name];
    const lower = name.toLowerCase();
    for (const k of Object.keys(b)) if (k.toLowerCase() === lower) return b[k];
    return undefined;
  };
  const slug = get("slug");
  if (!isSlug(slug)) throw new Invalid("SLUG_INVALID");
  const links = get("links") ?? [];
  if (!Array.isArray(links) || links.length > MaxLinks) throw new Invalid("LINK_INVALID");
  const flag = (name: string) => {
    const v = get(name);
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw new Invalid("BAD_FIELD");
    return v;
  };
  return {
    slug,
    name: text(get("name"), 120, "NAME_REQUIRED", true)!,
    specialty: text(get("specialty"), 160, "SPECIALTY_INVALID"),
    about: text(get("about"), 3000, "ABOUT_INVALID"),
    phone: normalizePhone(get("phone")),
    verified: flag("verified"),
    rating: parseRating(get("rating")),
    links: links.map(normalizeLink),
    shamcash: text(get("shamcash"), 100, "SHAMCASH_INVALID"),
    published: flag("published"),
  };
}

/** JPEG (FF D8 FF) or WebP (RIFF....WEBP), checked on the bytes, not on what the caller says. */
export function sniffPhoto(bytes: Uint8Array): (typeof PhotoTypes)[number] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}
