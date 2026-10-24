// The booking form: questions in three languages (Arabic required to publish), structure checks, publish blockers,
// the change summary, and server-side validation of a patient's answers. Same rules as the .NET FormSchema.
import { BadRequest } from "./http.ts";

export interface I18n {
  ar: string | null;
  en: string | null;
  tr: string | null;
}
export interface FormOption {
  id: string | null;
  label: I18n | null;
}
/** One question, in the shape of designs/Form Builder.dc.html (id, type, req, label, opts). */
export interface FormQuestion {
  id: string | null;
  type: string | null;
  req: boolean;
  label: I18n | null;
  opts: (FormOption | null)[] | null;
}

export const Types = ["short", "long", "single", "multi", "yesno", "date"];
export const MaxQuestions = 40, MaxOptions = 20, MaxLabel = 140, MaxOptionLabel = 80, MaxShort = 120, MaxLong = 1000;

// ---------------------------------------------------------------- parsing (the .NET JSON binding: case-insensitive names, wrong types → 400)
function prop(o: Record<string, unknown>, name: string): unknown {
  if (name in o) return o[name];
  for (const k of Object.keys(o)) if (k.toLowerCase() === name) return o[k];
  return undefined;
}

function optStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new BadRequest("string expected");
  return v;
}

function obj(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new BadRequest("object expected");
  return v as Record<string, unknown>;
}

function parseI18n(v: unknown): I18n | null {
  const o = obj(v);
  return o === null ? null : { ar: optStr(prop(o, "ar")), en: optStr(prop(o, "en")), tr: optStr(prop(o, "tr")) };
}

function parseOption(v: unknown): FormOption | null {
  const o = obj(v);
  return o === null ? null : { id: optStr(prop(o, "id")), label: parseI18n(prop(o, "label")) };
}

export function parseQuestion(v: unknown): FormQuestion | null {
  const o = obj(v);
  if (o === null) return null;
  const req = prop(o, "req");
  if (req !== undefined && req !== null && typeof req !== "boolean") throw new BadRequest("req");
  if (req === null) throw new BadRequest("req");
  const opts = prop(o, "opts");
  if (opts !== undefined && opts !== null && !Array.isArray(opts)) throw new BadRequest("opts");
  return {
    id: optStr(prop(o, "id")),
    type: optStr(prop(o, "type")),
    req: req === true,
    label: parseI18n(prop(o, "label")),
    opts: Array.isArray(opts) ? opts.map(parseOption) : null,
  };
}

export function parseQuestions(v: unknown): (FormQuestion | null)[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new BadRequest("questions");
  return v.map(parseQuestion);
}

/** The stored JSON (jsonb reorders keys) back into questions with the canonical key order. */
export function questionsFromStored(schema: unknown): FormQuestion[] {
  return (prop(schema as Record<string, unknown>, "questions") as unknown[]).map((q) => parseQuestion(q)!);
}

/** Canonical JSON of a question: the same key order and nulls as the .NET serializer, used for the change summary. */
export function canonical(q: FormQuestion): string {
  const l = (t: I18n | null) => (t === null ? null : { ar: t.ar, en: t.en, tr: t.tr });
  return JSON.stringify({
    id: q.id,
    type: q.type,
    req: q.req,
    label: l(q.label),
    opts: q.opts === null ? null : q.opts.map((o) => (o === null ? null : { id: o.id, label: l(o.label) })),
  });
}

export const toStored = (questions: FormQuestion[]) => ({ questions: questions.map((q) => JSON.parse(canonical(q))) });

// ---------------------------------------------------------------- rules
const idFormat = /^[a-z0-9]{1,24}$/;
export const hasOptions = (type: string | null) => type === "single" || type === "multi";
const tooLong = (t: I18n, max: number) => (t.ar?.length ?? 0) > max || (t.en?.length ?? 0) > max || (t.tr?.length ?? 0) > max;

/** Shape and size checks for a draft. Returns an error code, or null. */
export function validateStructure(questions: (FormQuestion | null)[] | null): string | null {
  if (questions === null) return "FORM_INVALID";
  if (questions.length > MaxQuestions) return "FORM_TOO_LARGE";
  const ids = new Set<string>();
  for (const q of questions) {
    if (q === null || q.label === null || !idFormat.test(q.id ?? "") || ids.has(q.id!)) return "FORM_INVALID";
    ids.add(q.id!);
    if (!Types.includes(q.type ?? "")) return "FORM_INVALID";
    if (tooLong(q.label, MaxLabel)) return "FORM_INVALID";
    const opts = q.opts ?? [];
    if (!hasOptions(q.type) && opts.length > 0) return "FORM_INVALID";
    if (opts.length > MaxOptions) return "FORM_TOO_LARGE";
    const optIds = new Set<string>();
    for (const o of opts) {
      if (o === null || o.label === null || !idFormat.test(o.id ?? "") || optIds.has(o.id!) || tooLong(o.label, MaxOptionLabel)) return "FORM_INVALID";
      optIds.add(o.id!);
    }
  }
  return null;
}

const blank = (s: string | null | undefined) => s == null || s.trim().length === 0;

/** Publish blockers from the design: every question needs Arabic text; choice questions need ≥ 2 options with Arabic text. */
export function blockers(questions: FormQuestion[]): { question: number; code: string }[] {
  const list: { question: number; code: string }[] = [];
  questions.forEach((q, i) => {
    if (blank(q.label!.ar)) list.push({ question: i + 1, code: "LABEL_AR_REQUIRED" });
    if (hasOptions(q.type) && (q.opts ?? []).filter((o) => !blank(o!.label!.ar)).length < 2) list.push({ question: i + 1, code: "OPTIONS_REQUIRED" });
  });
  return list;
}

const trimI18n = (t: I18n): I18n => ({ ar: t.ar?.trim() ?? null, en: blank(t.en) ? null : t.en!.trim(), tr: blank(t.tr) ? null : t.tr!.trim() });

/** Removes options with no Arabic text before publishing (the design ignores blank option rows). */
export function cleanForPublish(questions: FormQuestion[]): FormQuestion[] {
  return questions.map((q) => ({
    ...q,
    label: trimI18n(q.label!),
    opts: hasOptions(q.type) ? (q.opts ?? []).filter((o) => !blank(o!.label!.ar)).map((o) => ({ ...o!, label: trimI18n(o!.label!) })) : [],
  }));
}

/** [added, edited, removed, reordered] — the same comparison as the prototype. */
export function diff(draft: FormQuestion[], live: FormQuestion[] | null): number[] {
  const base = live ?? [];
  const bm = new Map(base.map((q) => [q.id, canonical(q)]));
  const dm = new Set(draft.map((q) => q.id));
  const added = draft.filter((q) => !bm.has(q.id)).length;
  const edited = draft.filter((q) => bm.has(q.id) && bm.get(q.id) !== canonical(q)).length;
  const removed = base.filter((q) => !dm.has(q.id)).length;
  const common = draft.filter((q) => bm.has(q.id)).map((q) => q.id);
  const bc = base.filter((q) => dm.has(q.id)).map((q) => q.id);
  return [added, edited, removed, common.length === bc.length && common.every((x, i) => x === bc[i]) ? 0 : 1];
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function isDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Validates a patient's answers against one published version. Returns the normalised answers to store, or an error. */
export function validateAnswers(questions: FormQuestion[], given: Record<string, unknown> | null):
  { answers: Record<string, unknown>; error: null } | { answers: null; error: string; questionId: string } {
  given ??= {};
  const known = new Map(questions.map((q) => [q.id!, q]));
  const unknown = Object.keys(given).find((k) => !known.has(k));
  if (unknown !== undefined) return { answers: null, error: "ANSWER_UNKNOWN_QUESTION", questionId: unknown };
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    const v = given[q.id!];
    if (!(q.id! in given) || isEmpty(v)) {
      if (q.req) return { answers: null, error: "ANSWER_REQUIRED", questionId: q.id! };
      continue;
    }
    const opts = new Set((q.opts ?? []).map((o) => o!.id));
    let ok: boolean;
    switch (q.type) {
      case "short":
        ok = typeof v === "string" && v.trim().length <= MaxShort;
        break;
      case "long":
        ok = typeof v === "string" && v.trim().length <= MaxLong;
        break;
      case "single":
        ok = typeof v === "string" && opts.has(v);
        break;
      case "yesno":
        ok = v === "yes" || v === "no";
        break;
      case "date":
        ok = typeof v === "string" && isDate(v);
        break;
      case "multi":
        ok = Array.isArray(v) && v.every((x) => typeof x === "string" && opts.has(x)) && new Set(v).size === v.length;
        break;
      default:
        ok = false;
    }
    if (!ok) return { answers: null, error: "ANSWER_INVALID", questionId: q.id! };
    out[q.id!] = typeof v === "string" ? v.trim() : v;
  }
  return { answers: out, error: null };
}
