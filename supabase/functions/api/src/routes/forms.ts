// Booking-form builder (hospital admin): draft, publish, versions, restore. Publishing runs in one transaction under
// an advisory lock; on any failure the live version is untouched.
import type { Hono } from "hono";
import { permission, route } from "../app.ts";
import { audit, Scopes, type Tx } from "../db.ts";
import { blockers, cleanForPublish, diff, type FormQuestion, parseQuestions, questionsFromStored, toStored, validateStructure } from "../forms.ts";
import { body, BadRequest, type Ctx, deps, type Env, int, json, principal, raw } from "../http.ts";
import { Ids } from "../security.ts";

const err = (c: Ctx, code: string, status: number, detail: unknown = null) => json(c, { error: code, detail }, status);

interface VersionRow {
  id: string;
  version: number;
  schema_json: unknown;
  published_at: Date;
  published_by: string | null;
  restored_from_version: number | null;
  change_summary_json: number[];
}

const versionSelect = (tx: Tx) =>
  tx`
  SELECT v.id, v.version, v.schema_json, v.published_at, u.email::text AS published_by,
         v.restored_from_version, v.change_summary_json
  FROM form_versions v LEFT JOIN users u ON u.id = v.published_by`;

async function live(tx: Tx, hospitalId: string): Promise<VersionRow | undefined> {
  const [v] = await tx<VersionRow[]>`${versionSelect(tx)} JOIN hospital_active_form a ON a.form_version_id = v.id WHERE a.hospital_id = ${hospitalId}`;
  return v;
}

/** Inserts a new version and makes it live. The caller holds the transaction. */
export async function publish(tx: Tx, hospitalId: string, questions: FormQuestion[], actorId: string, restoredFrom: number | null): Promise<number> {
  // Serialise publishes per hospital (two admins pressing Publish at once).
  await tx`SELECT pg_advisory_xact_lock(7240100, hashtext(${hospitalId}))`;
  const current = await live(tx, hospitalId);
  const [{ next }] = await tx<{ next: number }[]>`SELECT coalesce(max(version), 0) + 1 AS next FROM form_versions WHERE hospital_id = ${hospitalId}`;
  const id = Ids.form();
  const summary = diff(questions, current ? questionsFromStored(current.schema_json) : null);
  await tx`
    INSERT INTO form_versions (id, hospital_id, version, schema_json, published_by, restored_from_version, change_summary_json)
    VALUES (${id}, ${hospitalId}, ${next}, ${JSON.stringify(toStored(questions))}::jsonb, ${actorId}, ${restoredFrom}, ${JSON.stringify(summary)}::jsonb)`;
  await tx`
    INSERT INTO hospital_active_form (hospital_id, form_version_id) VALUES (${hospitalId}, ${id})
    ON CONFLICT (hospital_id) DO UPDATE SET form_version_id = excluded.form_version_id`;
  await tx`DELETE FROM form_drafts WHERE hospital_id = ${hospitalId}`;
  await audit(tx, actorId, hospitalId, "form_publish", "v" + next, { summary, restoredFrom });
  return next;
}

/** Route parameter {version:int}: anything else is not this route (404). */
function versionParam(c: Ctx): number | null {
  const v = c.req.param("version")! ?? "";
  return /^-?\d{1,9}$/.test(v) ? Number.parseInt(v, 10) : null;
}

export function formRoutes(app: Hono<Env>) {
  route(app, "GET", "/hospital/form", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    return json(c, await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const l = await live(tx, p.hospitalId!);
      const [draft] = await tx<{ schema_json: unknown; base_version: number; updated_at: Date }[]>`
        SELECT schema_json, base_version, updated_at FROM form_drafts WHERE hospital_id = ${p.hospitalId}`;
      return {
        live: l ? { version: l.version, publishedAt: l.published_at, publishedBy: l.published_by, questions: questionsFromStored(l.schema_json) } : null,
        draft: draft ? { questions: questionsFromStored(draft.schema_json), baseVersion: draft.base_version, updatedAt: draft.updated_at } : null,
      };
    }));
  });

  // Saving a draft never touches the live form.
  route(app, "PUT", "/hospital/form/draft", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    const b = await body(c);
    const questions = parseQuestions(raw(b, "questions")) ?? [];
    const baseVersion = int(b, "baseVersion");
    const e = validateStructure(questions);
    if (e !== null) return err(c, e, 422);
    await deps(c).db.run(Scopes.hospital(p.hospitalId), (tx) => tx`
      INSERT INTO form_drafts (hospital_id, schema_json, base_version, updated_by, updated_at)
      VALUES (${p.hospitalId}, ${JSON.stringify(toStored(questions as FormQuestion[]))}::jsonb, ${baseVersion ?? 0}, ${p.userId}, now())
      ON CONFLICT (hospital_id) DO UPDATE SET schema_json = excluded.schema_json, base_version = excluded.base_version,
          updated_by = excluded.updated_by, updated_at = now()`);
    return json(c, { status: "ok" });
  });

  route(app, "DELETE", "/hospital/form/draft", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    await deps(c).db.run(Scopes.hospital(p.hospitalId), (tx) => tx`DELETE FROM form_drafts WHERE hospital_id = ${p.hospitalId}`);
    return json(c, { status: "ok" });
  });

  // Publishes the saved draft. Success is reported only after the commit.
  route(app, "POST", "/hospital/form/publish", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    const r = await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const [draft] = await tx<{ schema_json: unknown }[]>`SELECT schema_json FROM form_drafts WHERE hospital_id = ${p.hospitalId} FOR UPDATE`;
      if (!draft) return { error: "NO_DRAFT", status: 409 };
      const questions = questionsFromStored(draft.schema_json);
      const e = validateStructure(questions);
      if (e !== null) return { error: e, status: 422 };
      const b = blockers(questions);
      if (b.length > 0) return { error: "FORM_BLOCKED", status: 422, detail: b };
      const cleaned = cleanForPublish(questions);
      const l = await live(tx, p.hospitalId!);
      if (l && diff(cleaned, questionsFromStored(l.schema_json)).reduce((a, x) => a + x, 0) === 0) return { error: "NO_CHANGES", status: 409 };
      return { version: await publish(tx, p.hospitalId!, cleaned, p.userId, null) };
    });
    return "error" in r ? err(c, r.error!, r.status!, r.detail ?? null) : json(c, { version: r.version });
  });

  route(app, "GET", "/hospital/form/versions", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    return json(c, await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const l = await live(tx, p.hospitalId!);
      const rows = await tx<VersionRow[]>`${versionSelect(tx)} WHERE v.hospital_id = ${p.hospitalId} ORDER BY v.version DESC`;
      return {
        versions: rows.map((v) => ({
          version: v.version,
          publishedAt: v.published_at,
          publishedBy: v.published_by,
          restoredFrom: v.restored_from_version,
          summary: v.change_summary_json,
          questionCount: questionsFromStored(v.schema_json).length,
          live: v.version === l?.version,
        })),
      };
    }));
  });

  route(app, "GET", "/hospital/form/versions/:version", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    const version = versionParam(c);
    if (version === null) return c.body(null, 404);
    const [v] = await deps(c).db.run(Scopes.hospital(p.hospitalId), (tx) =>
      tx<VersionRow[]>`${versionSelect(tx)} WHERE v.hospital_id = ${p.hospitalId} AND v.version = ${version}`);
    return v ? json(c, { version: v.version, questions: questionsFromStored(v.schema_json) }) : err(c, "NOT_FOUND", 404);
  });

  // Restoring publishes the old content as a NEW version; nothing is deleted. Any unpublished draft is replaced.
  route(app, "POST", "/hospital/form/versions/:version/restore", permission("FormEditPublish"), async (c) => {
    const p = principal(c);
    const version = versionParam(c);
    if (version === null) return c.body(null, 404);
    const r = await deps(c).db.run(Scopes.hospital(p.hospitalId), async (tx) => {
      const [v] = await tx<VersionRow[]>`${versionSelect(tx)} WHERE v.hospital_id = ${p.hospitalId} AND v.version = ${version}`;
      if (!v) return { error: "NOT_FOUND", status: 404 };
      const l = await live(tx, p.hospitalId!);
      if (l?.version === version) return { error: "ALREADY_LIVE", status: 409 };
      return { version: await publish(tx, p.hospitalId!, questionsFromStored(v.schema_json), p.userId, version) };
    });
    return "error" in r ? err(c, r.error!, r.status!) : json(c, { version: r.version, restoredFrom: version });
  });
}

export { BadRequest };
