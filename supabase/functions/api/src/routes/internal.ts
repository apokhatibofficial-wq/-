// The scheduler's endpoint. pg_cron (pg_net) calls it every minute with the jobs secret; nobody else can.
import type { Hono } from "hono";
import { route } from "../app.ts";
import { deps, type Env, error, json } from "../http.ts";
import { tick } from "../jobs.ts";
import { fixedTimeEquals } from "../security.ts";

export function internalRoutes(app: Hono<Env>) {
  route(app, "POST", "/internal/jobs", { kind: "jobs" }, async (c) => {
    const d = deps(c);
    const sent = c.req.header("x-medlink-jobs") ?? "";
    if (!d.config.jobsSecret || !fixedTimeEquals(sent, d.config.jobsSecret)) return error(c, "FORBIDDEN", 403);
    return json(c, { status: "ok", ...(await tick(d.db, d.email, d.config.alertEmail, d.now())) });
  });
}
