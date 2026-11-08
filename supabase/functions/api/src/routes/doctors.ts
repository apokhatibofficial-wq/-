// Doctor profile pages: the company console writes them (owner only), anyone reads a published one at
// medlink.website/dr/{slug}. Doctors have no account (owner's decision, 2026-11-08).
import type { Hono } from "hono";
import { anonymous, permission, route } from "../app.ts";
import { audit, isUniqueViolation, Scopes } from "../db.ts";
import {
  adminDoctorDto,
  type DoctorRow,
  doctorSelect,
  Invalid,
  MaxPhotoBytes,
  parseDoctor,
  publicDoctorDto,
  sniffPhoto,
} from "../doctors.ts";
import { body, type Ctx, deps, type Env, json, principal, requireJsonType, str } from "../http.ts";
import { Ids } from "../security.ts";

const err = (c: Ctx, code: string, status: number) => json(c, { error: code }, status);
const isSlug = (s: string) => /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s);

export function doctorRoutes(app: Hono<Env>) {
  // ---------------------------------------------------------------- company console
  route(app, "GET", "/admin/doctors", permission("ViewReports"), async (c) => {
    const rows = await deps(c).db.run(Scopes.company, (tx) => tx<DoctorRow[]>`${doctorSelect(tx)} ORDER BY created_at DESC`);
    return json(c, { doctors: rows.map(adminDoctorDto) });
  });

  route(app, "POST", "/admin/doctors", permission("DoctorProfilesManage"), async (c) => {
    const p = principal(c);
    let input;
    try {
      input = parseDoctor(await body(c));
    } catch (e) {
      if (e instanceof Invalid) return err(c, e.code, 422);
      throw e;
    }
    const id = Ids.doctor();
    try {
      const row = await deps(c).db.run(Scopes.company, async (tx) => {
        await tx`
          INSERT INTO doctor_profiles (id, slug, name, specialty, about, phone, verified, rating, links, shamcash, published, created_by)
          VALUES (${id}, ${input.slug}, ${input.name}, ${input.specialty}, ${input.about}, ${input.phone}, ${input.verified},
                  ${input.rating}, ${tx.json(input.links as any)}, ${input.shamcash}, ${input.published}, ${p.userId})`;
        await audit(tx, p.userId, null, "doctor_create", id, { slug: input.slug, published: input.published });
        const [r] = await tx<DoctorRow[]>`${doctorSelect(tx)} WHERE id = ${id}`;
        return r;
      });
      return json(c, { doctor: adminDoctorDto(row) }, 201);
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "SLUG_TAKEN", 409);
      throw e;
    }
  });

  route(app, "PATCH", "/admin/doctors/:id", permission("DoctorProfilesManage"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    let input;
    try {
      input = parseDoctor(await body(c));
    } catch (e) {
      if (e instanceof Invalid) return err(c, e.code, 422);
      throw e;
    }
    try {
      const row = await deps(c).db.run(Scopes.company, async (tx) => {
        const [cur] = await tx<{ slug: string; published: boolean }[]>`SELECT slug, published FROM doctor_profiles WHERE id = ${id} FOR UPDATE`;
        if (!cur) return null;
        await tx`
          UPDATE doctor_profiles SET slug = ${input.slug}, name = ${input.name}, specialty = ${input.specialty}, about = ${input.about},
                 phone = ${input.phone}, verified = ${input.verified}, rating = ${input.rating}, links = ${tx.json(input.links as any)},
                 shamcash = ${input.shamcash}, published = ${input.published}, updated_at = now()
          WHERE id = ${id}`;
        await audit(tx, p.userId, null, "doctor_edit", id, {
          oldSlug: cur.slug !== input.slug ? cur.slug : null,
          newSlug: cur.slug !== input.slug ? input.slug : null,
          published: cur.published !== input.published ? input.published : null,
        });
        const [r] = await tx<DoctorRow[]>`${doctorSelect(tx)} WHERE id = ${id}`;
        return r;
      });
      return row === null ? err(c, "NOT_FOUND", 404) : json(c, { doctor: adminDoctorDto(row) });
    } catch (e) {
      if (isUniqueViolation(e)) return err(c, "SLUG_TAKEN", 409);
      throw e;
    }
  });

  route(app, "DELETE", "/admin/doctors/:id", permission("DoctorProfilesManage"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const n = await deps(c).db.run(Scopes.company, async (tx) => {
      const r = await tx<{ slug: string }[]>`DELETE FROM doctor_profiles WHERE id = ${id} RETURNING slug`;
      if (r.length > 0) await audit(tx, p.userId, null, "doctor_delete", id, { slug: r[0].slug });
      return r.length;
    });
    return n === 0 ? err(c, "NOT_FOUND", 404) : json(c, { status: "ok" });
  });

  // The console shows the photo of an unpublished profile too.
  route(app, "GET", "/admin/doctors/:id/photo", permission("ViewReports"), async (c) => {
    const id = c.req.param("id")!;
    const [r] = await deps(c).db.run(Scopes.company, (tx) =>
      tx<{ photo: Uint8Array | null; photo_type: string | null }[]>`SELECT photo, photo_type FROM doctor_profiles WHERE id = ${id}`);
    if (!r?.photo) return err(c, "NOT_FOUND", 404);
    return photoResponse(c, r.photo, r.photo_type!, "no-store");
  });

  // JSON body {"data": base64}. The console resizes the photo first; the type is read from the bytes.
  route(app, "PUT", "/admin/doctors/:id/photo", permission("DoctorProfilesManage"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    const data = str(await body(c), "data") ?? "";
    if (data.length === 0 || data.length > Math.ceil(MaxPhotoBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return err(c, "PHOTO_INVALID", 422);
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    } catch {
      return err(c, "PHOTO_INVALID", 422);
    }
    const type = sniffPhoto(bytes);
    if (type === null || bytes.length > MaxPhotoBytes) return err(c, "PHOTO_INVALID", 422);
    const rev = await deps(c).db.run(Scopes.company, async (tx) => {
      const r = await tx<{ photo_rev: number }[]>`
        UPDATE doctor_profiles SET photo = ${bytes}, photo_type = ${type}, photo_rev = photo_rev + 1, updated_at = now()
        WHERE id = ${id} RETURNING photo_rev`;
      if (r.length > 0) await audit(tx, p.userId, null, "doctor_photo", id, { bytes: bytes.length });
      return r[0]?.photo_rev ?? null;
    });
    return rev === null ? err(c, "NOT_FOUND", 404) : json(c, { photoRev: rev });
  });

  route(app, "DELETE", "/admin/doctors/:id/photo", permission("DoctorProfilesManage"), async (c) => {
    const p = principal(c);
    const id = c.req.param("id")!;
    requireJsonType(c);
    const rev = await deps(c).db.run(Scopes.company, async (tx) => {
      const r = await tx<{ photo_rev: number }[]>`
        UPDATE doctor_profiles SET photo = NULL, photo_type = NULL, photo_rev = photo_rev + 1, updated_at = now()
        WHERE id = ${id} RETURNING photo_rev`;
      if (r.length > 0) await audit(tx, p.userId, null, "doctor_photo", id, { bytes: 0 });
      return r[0]?.photo_rev ?? null;
    });
    return rev === null ? err(c, "NOT_FOUND", 404) : json(c, { photoRev: rev });
  });

  // ---------------------------------------------------------------- public page
  route(app, "GET", "/public/doctors/:slug", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    if (!isSlug(slug)) return err(c, "NOT_FOUND", 404);
    const [r] = await deps(c).db.run(Scopes.system, (tx) => tx<DoctorRow[]>`${doctorSelect(tx)} WHERE slug = ${slug} AND published`);
    return r ? json(c, publicDoctorDto(r)) : err(c, "NOT_FOUND", 404);
  });

  route(app, "GET", "/public/doctors/:slug/photo", anonymous, async (c) => {
    const slug = c.req.param("slug")!;
    if (!isSlug(slug)) return err(c, "NOT_FOUND", 404);
    const [r] = await deps(c).db.run(Scopes.system, (tx) =>
      tx<{ photo: Uint8Array | null; photo_type: string | null; photo_rev: number }[]>`
        SELECT photo, photo_type, photo_rev FROM doctor_profiles WHERE slug = ${slug} AND published`);
    if (!r?.photo) return err(c, "NOT_FOUND", 404);
    // The page asks for ?v={revision}: that exact photo never changes, so browsers may keep it. Any other URL is
    // cached briefly only.
    const fixed = c.req.query("v") === String(r.photo_rev);
    return photoResponse(c, r.photo, r.photo_type!, fixed ? "public, max-age=31536000, immutable" : "public, max-age=300");
  });
}

function photoResponse(c: Ctx, photo: Uint8Array, type: string, cache: string): Response {
  return c.body(photo as any, 200, {
    "Content-Type": type,
    "Cache-Control": cache,
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}
