// MEDLINK API on Supabase Edge Functions. The Cloudflare proxy (api.<domain>) forwards every request here.
import { buildApp } from "./src/main.ts";
import { loadConfig } from "./src/config.ts";
import { connect, Db } from "./src/db.ts";
import { ResendEmailSender } from "./src/email.ts";

const config = await loadConfig(Deno.env.toObject());
const app = buildApp({ config, db: new Db(connect(config.dbUrl)), email: new ResendEmailSender(config), now: () => new Date() });

Deno.serve((req) => {
  // Supabase passes the function's own name as the first path segment: /api/auth/login → /auth/login.
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return app.fetch(new Request(url, req));
});
