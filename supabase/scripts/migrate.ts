// Applies MEDLINK's SQL migrations in order, each in its own transaction, as the database owner, then sets the
// password of the role the API uses (medlink_app). Same bookkeeping as the .NET migrator (schema_migrations).
//   DB_OWNER_URL=postgres://... DB_APP_PASSWORD=... deno run -A supabase/scripts/migrate.ts
import postgres from "npm:postgres@3.4.9";

export const migrationsDir = new URL("../../api/src/MedLink.Api/Data/Migrations/", import.meta.url);

async function sha256Hex(text: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function migrate(ownerUrl: string, appPassword: string | null, log: (s: string) => void = () => {}): Promise<string[]> {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    await sql`SELECT pg_advisory_lock(7240001)`;
    try {
      const done = new Map((await sql<{ version: string; checksum: string }[]>`SELECT version, checksum FROM schema_migrations`)
        .map((r) => [r.version, r.checksum]));
      const files = [];
      for await (const e of Deno.readDir(migrationsDir)) if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
      files.sort();
      for (const f of files) {
        const version = f.replace(/\.sql$/, "");
        const text = await Deno.readTextFile(new URL(f, migrationsDir));
        const checksum = await sha256Hex(text);
        const existing = done.get(version);
        if (existing !== undefined) {
          if (existing !== checksum) throw new Error(`Migration ${version} was changed after it was applied. Add a new migration instead.`);
          continue;
        }
        await sql.begin(async (tx) => {
          await tx.unsafe(text);
          await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${version}, ${checksum})`;
        });
        applied.push(version);
        log(`applied ${version}`);
      }
      if (appPassword) {
        const [{ stmt }] = await sql<{ stmt: string }[]>`SELECT format('ALTER ROLE medlink_app LOGIN PASSWORD %L', ${appPassword}::text) AS stmt`;
        await sql.unsafe(stmt);
        const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
        await sql.unsafe(`GRANT CONNECT ON DATABASE "${db.replaceAll('"', '""')}" TO medlink_app`);
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(7240001)`;
    }
  } finally {
    await sql.end();
  }
  return applied;
}

if (import.meta.main) {
  const url = Deno.env.get("DB_OWNER_URL");
  if (!url) {
    console.error("set DB_OWNER_URL (the database owner's connection string)");
    Deno.exit(2);
  }
  const applied = await migrate(url, Deno.env.get("DB_APP_PASSWORD") || null, console.log);
  console.log(applied.length === 0 ? "database is up to date" : `${applied.length} migration(s) applied`);
}
