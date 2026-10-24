// /auth: sign-in, sign-out, the current user, and one-time links (setup / activation / reset).
import type { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { anonymous, csrfFor, route, sessionCookieName, signedIn } from "../app.ts";
import { completeLink, idleFor, inspectLink, login, logout, Passwords } from "../auth.ts";
import { body, deps, type Env, error, json, principal, str } from "../http.ts";
import { permissionsFor, type Principal } from "../permissions.ts";

export function me(p: Principal) {
  return {
    id: p.userId,
    email: p.email,
    scope: p.scope,
    hospitalId: p.hospitalId,
    roles: p.roles,
    permissions: permissionsFor(p.roles),
  };
}

export function authRoutes(app: Hono<Env>) {
  // Rate-limited by the middleware in app.ts.
  route(app, "POST", "/auth/login", anonymous, async (c) => {
    const d = deps(c);
    const b = await body(c);
    const email = str(b, "email"), password = str(b, "password"), totp = str(b, "totp"), clientField = str(b, "client");
    if (!email || !email.trim() || !password || password.length > Passwords.maxLength || email.length > 254) {
      return error(c, "INVALID_CREDENTIALS", 401);
    }
    const client = clientField === "windows" ? "windows" : "web";
    const r = await login(d, email, password, totp, client);
    switch (r.outcome) {
      case "ok": {
        const p = r.principal;
        if (client === "web") {
          setCookie(c, sessionCookieName(d.config.cookieSecure), r.token, {
            httpOnly: true,
            secure: d.config.cookieSecure,
            sameSite: "Strict",
            path: "/",
            maxAge: Math.floor(idleFor(p.roles) / 1000),
          });
        }
        return json(c, {
          status: "ok",
          user: me(p),
          csrf: client === "web" ? await csrfFor(d.config.sessionSigningKey, p.sessionId) : null,
          // The Windows app keeps its token in memory (BACKEND-SPEC §3); the web never sees it.
          token: client === "windows" ? r.token : null,
        });
      }
      case "mfa_required":
        return json(c, { status: "mfa_required" });
      case "locked":
        return error(c, "ACCOUNT_LOCKED", 423, { lockedUntil: r.lockedUntil.toISOString() });
      case "mfa_not_enrolled":
        return error(c, "MFA_NOT_ENROLLED", 403);
      case "hospital_suspended":
        return error(c, "HOSPITAL_SUSPENDED", 403);
      default:
        return error(c, "INVALID_CREDENTIALS", 401);
    }
  });

  route(app, "POST", "/auth/logout", signedIn, async (c) => {
    const d = deps(c);
    await logout(d, principal(c));
    setCookie(c, sessionCookieName(d.config.cookieSecure), "", {
      secure: d.config.cookieSecure,
      sameSite: "Strict",
      path: "/",
      expires: new Date(0),
    });
    return json(c, { status: "ok" });
  });

  route(app, "GET", "/auth/me", signedIn, async (c) => {
    const p = principal(c);
    return json(c, { user: me(p), csrf: p.viaCookie ? await csrfFor(deps(c).config.sessionSigningKey, p.sessionId) : null });
  });

  // Tokens travel in POST bodies, never in URLs.
  route(app, "POST", "/auth/link/inspect", anonymous, async (c) => {
    const token = str(await body(c), "token");
    if (!token || token.length > 64) return error(c, "LINK_INVALID", 410);
    const info = await inspectLink(deps(c), token);
    if (!info) return error(c, "LINK_INVALID", 410);
    return json(c, { ...info, passwordMinLength: Passwords.minLength });
  });

  route(app, "POST", "/auth/link/complete", anonymous, async (c) => {
    const b = await body(c);
    const token = str(b, "token"), password = str(b, "password"), totp = str(b, "totp");
    if (!token || token.length > 64 || password === null || password.length > Passwords.maxLength) return error(c, "LINK_INVALID", 410);
    switch (await completeLink(deps(c), token, password, totp)) {
      case "ok":
        return json(c, { status: "ok" });
      case "bad_password":
        return error(c, "PASSWORD_WEAK", 422, { minLength: Passwords.minLength });
      case "bad_totp":
        return error(c, "TOTP_INVALID", 422);
      default:
        return error(c, "LINK_INVALID", 410);
    }
  });
}
