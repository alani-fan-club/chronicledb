import pg from "pg";
import type { ChronicleConfig } from "../config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(config: ChronicleConfig): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: config.database.user,
      password: config.database.password,
      max: 10,
    });
  }
  return pool;
}

export async function withClient<T>(
  config: ChronicleConfig,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool(config).connect();
  try {
    // AGE requires this search path for Cypher queries
    await client.query(
      `SET search_path = ag_catalog, "$user", public;`,
    );
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Execute a Cypher query against the chronicle graph via AGE.
 * Returns parsed JSON rows.
 */
export async function cypher<T = Record<string, unknown>>(
  config: ChronicleConfig,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  return withClient(config, async (client) => {
    // AGE Cypher queries are wrapped in SELECT * FROM cypher(...)
    // Parameters are interpolated into the Cypher string (AGE doesn't support $1 params in Cypher)
    let interpolated = query;
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        const escaped =
          typeof value === "string"
            ? `'${value.replace(/'/g, "''")}'`
            : String(value);
        interpolated = interpolated.replace(
          new RegExp(`\\$${key}`, "g"),
          escaped,
        );
      }
    }

    const sql = `SELECT * FROM cypher('chronicle', $$ ${interpolated} $$) as (result agtype);`;
    const { rows } = await client.query(sql);
    return rows.map((row: { result: string }) => {
      // AGE returns agtype which needs parsing
      const val = row.result;
      if (typeof val === "string") {
        try {
          return JSON.parse(val.replace(/::vertex|::edge|::path/g, ""));
        } catch {
          return val;
        }
      }
      return val;
    }) as T[];
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
