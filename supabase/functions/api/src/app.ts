// The MEDLINK API as one Hono application: security headers, CORS, the session/CSRF check, rate limits, endpoints.
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { validateSession } from "./auth.ts";
import { Scopes } from "./db.ts";
import { type AppDeps, BadRequest, type Ctx, type Env, error, type Guard, json, JsonRequired, require, requireSignedIn, routeGuards } from "./http.ts";
import { fixedTimeEquals, hmac } from "./security.ts";
import type { Permission } from "./permissions.ts";
import { pgCode } from "./db.ts";

export const CookieName = "__Host-medlink_session";
export const DevCookieName = "medlink_session";
export const CsrfHeader = "X-CSRF-Token";

export const sessionCookieName = (secure: boolean) => (secure ? CookieName : DevCookieName);
export const csrfFor = (key: Uint8Array, sessionId: string) => hmac(key, "csrf:" + sessionId);

type Handler = (c: Ctx) => Promise<Response> | Response;
export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Registers an endpoint together with who may call it (checked on every request, and listed for the endpoint sweep test). */
export function route(app: Hono<Env>, method: Method, path: string, guard: Guard, handler: Handler) {
  routeGuards.push({ method, path, guard });
  const mw: MiddlewareHandler<Env>[] = [];
  if (guard.kind === "signedIn") mw.push(requireSignedIn);
  else if (guard.kind === "permission") mw.push(require(guard.permission));
  (app.on as any)(method, path, ...mw, (c: Ctx) => handler(c));
}

export const anonymous: Guard = { kind: "anonymous" };
export const signedIn: Guard = { kind: "signedIn" };
export const permission = (p: Permission): Guard => ({ kind: "permission", permission: p });

/** Anonymous endpoints never use the session, so a session cookie sent along is ignored there instead of tripping the CSRF check. */
function startsWithSegments(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export function isAnonymousPath(path: string): boolean {
  return startsWithSegments(path, "/public") || startsWithSegments(path, "/auth/login") || startsWithSegments(path, "/auth/link") ||
    startsWithSegments(path, "/health") || startsWithSegments(path, "/internal");
}

function net24(ip: string): string {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : ip;
}

/** The rate-limit keys a request counts against (BACKEND-SPEC §3), or none. */
function rateLimitKeys(d: AppDeps, method: string, path: string, ip: string): [string[], number[]] {
  const c = d.config;
  if (startsWithSegments(path, "/auth") && method !== "GET") {
    return [["i:" + ip, "n:" + net24(ip)], [c.authRatePerIp, c.authRatePerNet24]];
  }
  if (method === "POST" && path.startsWith("/public/hospitals/") && path.endsWith("/bookings")) {
    return [["b:" + ip, "h:" + path.split("/")[3]], [c.bookingRatePerIp, c.bookingRatePerHospital]];
  }
  if (startsWithSegments(path, "/scan")) return [["s:" + ip], [c.scanRatePerIp]];
  return [[], []];
}

export interface RouteModule {
  (app: Hono<Env>): void;
}

export function createApp(d: AppDeps, modules: RouteModule[]): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("deps", d);
    c.set("principal", null);
    await next();
    const h = c.res.headers;
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set("Cache-Control", "no-store");
    h.set("X-Frame-Options", "DENY");
  });

  app.onError((e, c) => {
    if (e instanceof JsonRequired) return error(c as Ctx, "JSON_REQUIRED", 415);
    if (e instanceof BadRequest) return error(c as Ctx, "BAD_REQUEST", 400);
    // Text PostgreSQL cannot store (a NUL byte) is the caller's mistake: 400, not 500.
    if (pgCode(e) === "22021" || pgCode(e) === "22P05") return error(c as Ctx, "INVALID_TEXT", 400);
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ level: "error", msg: "unhandled", requestId, error: (e as Error)?.name, code: pgCode(e) }));
    return json(c as Ctx, { error: "INTERNAL", requestId }, 500);
  });

  app.notFound((c) => c.body(null, 404));

  // Only the Cloudflare proxy (api.<domain>) may call the function; it passes the real client IP.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const secret = d.config.proxySecret;
    if (secret && !startsWithSegments(path, "/internal")) {
      const sent = c.req.header("x-medlink-proxy") ?? "";
      if (!fixedTimeEquals(sent, secret)) return error(c, "FORBIDDEN", 403);
    }
    c.set("ip", (c.req.header("x-medlink-client-ip") ?? "").trim() || "unknown");
    await next();
  });

  app.use(
    "*",
    cors({
      origin: (origin) => (d.config.corsOrigins.includes(origin) ? origin : null),
      credentials: true,
      allowHeaders: ["Content-Type", CsrfHeader, "Authorization", "Idempotency-Key"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
    }) as unknown as MiddlewareHandler<Env>,
  );

  // Resolves the session from the cookie (web) or the Authorization header (Windows app), and enforces CSRF on
  // unsafe cookie-authenticated requests.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (!isAnonymousPath(path)) {
      let token: string | undefined;
      let viaCookie = false;
      const header = c.req.header("authorization") ?? "";
      if (header.startsWith("Bearer ")) token = header.slice(7).trim();
      else {
        token = getCookie(c, sessionCookieName(d.config.cookieSecure));
        viaCookie = token !== undefined;
      }
      if (token && token.length <= 64) {
        const p = await validateSession(d, token, viaCookie);
        if (p) {
          const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
          if (viaCookie && unsafe) {
            const sent = c.req.header(CsrfHeader) ?? "";
            if (!sent || !fixedTimeEquals(sent, await csrfFor(d.config.sessionSigningKey, p.sessionId))) return error(c, "CSRF_INVALID", 403);
          }
          c.set("principal", p);
        }
      }
    }
    await next();
  });

  app.use("*", async (c, next) => {
    const [keys, limits] = rateLimitKeys(d, c.req.method, new URL(c.req.url).pathname, c.get("ip"));
    if (keys.length > 0) {
      const ok = await d.db.run(Scopes.system, async (tx) => {
        const [r] = await tx<{ ok: boolean }[]>`SELECT rate_limit_take(${keys}::text[], ${limits}::integer[]) AS ok`;
        return r.ok;
      });
      if (!ok) return error(c, "RATE_LIMITED", 429);
    }
    await next();
  });

  route(app, "GET", "/health", anonymous, async (c) => {
    await d.db.run(Scopes.system, (tx) => tx`SELECT 1`);
    return json(c, { status: "ok" });
  });

  for (const m of modules) m(app);
  return app;
}
