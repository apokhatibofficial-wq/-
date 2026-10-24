// Database access. Every transaction sets the RLS context (app.scope, app.hospital_id) from the server-side
// principal, never from the request. The API connects as medlink_app, which is not the table owner, so
// row-level security always applies.
import postgres from "postgres";

export type Tx = postgres.TransactionSql<Record<string, unknown>>;
export type Sql = postgres.Sql<Record<string, unknown>>;

export interface DbScope {
  scope: "system" | "company" | "hospital";
  hospitalId: string | null;
}

export const Scopes = {
  /** Authentication pipeline only (login, session lookup, one-time links, jobs). */
  system: { scope: "system", hospitalId: null } as DbScope,
  company: { scope: "company", hospitalId: null } as DbScope,
  hospital(hospitalId: string | null): DbScope {
    if (!hospitalId) throw new Error("hospital id required");
    return { scope: "hospital", hospitalId };
  },
};

export function connect(url: string, max = 5): Sql {
  return postgres(url, {
    // The Supabase pooler runs in transaction mode: no prepared statements.
    prepare: false,
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    // Counts and sequence numbers fit in a JavaScript number.
    types: {
      int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
    } as any,
    onnotice: () => {},
  });
}

export class Db {
  constructor(readonly sql: Sql) {}

  run<T>(scope: DbScope, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.scope', ${scope.scope}, true), set_config('app.hospital_id', ${scope.hospitalId ?? ""}, true)`;
      return await work(tx);
    }) as Promise<T>;
  }
}

/** PostgreSQL error code, if the error came from the database. */
export function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string"
    ? (e as { code: string }).code
    : undefined;
}

export const isUniqueViolation = (e: unknown) => pgCode(e) === "23505";

/** Append-only audit trail. Never pass passwords, tokens, links, patient data or emails in meta. */
export async function audit(tx: Tx, actorId: string | null, hospitalId: string | null, action: string, target: string, meta: unknown = {}) {
  await tx`INSERT INTO audit_log (actor_id, hospital_id, action, target, meta_json)
           VALUES (${actorId}, ${hospitalId}, ${action}, ${target}, ${tx.json(meta ?? {} as any)})`;
}
