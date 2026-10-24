// Request helpers shared by the endpoint modules: JSON bodies, typed fields, errors, the signed-in caller.
import type { Context, MiddlewareHandler } from "hono";
import type { Deps } from "./auth.ts";
import type { EmailSender } from "./email.ts";
import { has, isCompanyPermission, type Permission, type Principal } from "./permissions.ts";

export interface AppDeps extends Deps {
  email: EmailSender;
}

export type Env = { Variables: { principal: Principal | null; deps: AppDeps; ip: string } };
export type Ctx = Context<Env>;

export function json(c: Ctx, body: unknown, status = 200): Response {
  return c.json(body as any, status as any);
}

export const error = (c: Ctx, code: string, status: number, extra: Record<string, unknown> = {}) =>
  json(c, { error: code, ...extra }, status);

/** A request the caller got wrong (bad JSON, a field of the wrong type): 400, like the .NET model binding. */
export class BadRequest extends Error {}

export function isJson(c: Ctx): boolean {
  const t = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return t === "application/json" || (t.startsWith("application/") && t.endsWith("+json"));
}

/** The JSON object body. JSON-only bodies: cross-origin form posts cannot reach the API without a CORS preflight. */
export async function body(c: Ctx): Promise<Record<string, unknown>> {
  if (!isJson(c)) throw new JsonRequired();
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw new BadRequest("invalid JSON");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("a JSON object is expected");
  return v as Record<string, unknown>;
}

export class JsonRequired extends Error {}

/** For JSON-only endpoints that read no body: only the content type is checked. */
export function requireJsonType(c: Ctx) {
  if (!isJson(c)) throw new JsonRequired();
}

/** Field readers: missing or null → null; the wrong type → 400. Property names are matched case-insensitively. */
function field(b: Record<string, unknown>, name: string): unknown {
  if (name in b) return b[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(b)) if (k.toLowerCase() === lower) return b[k];
  return undefined;
}

export function str(b: Record<string, unknown>, name: string): string | null {
  const v = field(b, name);
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new BadRequest(name);
  return v;
}

export function int(b: Record<string, unknown>, name: string): number | null {
  const v = field(b, name);
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 2147483647) throw new BadRequest(name);
  return v;
}

export function bool(b: Record<string, unknown>, name: string): boolean | null {
  const v = field(b, name);
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") throw new BadRequest(name);
  return v;
}

export function strArray(b: Record<string, unknown>, name: string): string[] | null {
  const v = field(b, name);
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new BadRequest(name);
  return v as string[];
}

export function raw(b: Record<string, unknown>, name: string): unknown {
  const v = field(b, name);
  return v === undefined ? null : v;
}

export const deps = (c: Ctx) => c.get("deps");

/** The signed-in caller; the route's guard has already made sure there is one. */
export function principal(c: Ctx): Principal {
  const p = c.get("principal");
  if (!p) throw new Error("endpoint is missing an authorization guard");
  return p;
}

/** Endpoint markers, so a test can check that every endpoint declares who may call it. */
export type Guard =
  | { kind: "anonymous" }
  | { kind: "signedIn" }
  | { kind: "permission"; permission: Permission }
  | { kind: "jobs" };

export const routeGuards: { method: string; path: string; guard: Guard }[] = [];

/** Requires a signed-in caller of the permission's scope who holds the permission. Checked on the server for every request. */
export function require(permission: Permission): MiddlewareHandler<Env> {
  return async (c, next) => {
    const p = c.get("principal");
    if (!p) return error(c, "UNAUTHENTICATED", 401);
    if (isCompanyPermission(permission) !== (p.scope === "company") || !has(p.roles, permission)) return error(c, "FORBIDDEN", 403);
    await next();
  };
}

export const requireSignedIn: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get("principal")) return error(c, "UNAUTHENTICATED", 401);
  await next();
};
