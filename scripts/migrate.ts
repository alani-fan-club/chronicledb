import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "../src/config.js";
import { getPool, closePool } from "../src/db/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = getPool(config);

  console.log("=== ChronicleDB Migration ===");
  console.log(`Database: ${config.database.host}:${config.database.port}/${config.database.database}`);

  const migrationPath = resolve(
    __dirname,
    "../src/db/migrations/001_initial_schema.sql",
  );
  const sql = readFileSync(migrationPath, "utf-8");

  // Split on semicolons but respect $$ delimiters for AGE queries
  const statements = splitSqlStatements(sql);

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;

    try {
      await pool.query(trimmed);
      console.log(`  OK: ${trimmed.slice(0, 60).replace(/\n/g, " ")}...`);
    } catch (err) {
      const msg = (err as Error).message;
      // Skip "already exists" errors for idempotent runs
      if (msg.includes("already exists")) {
        console.log(`  SKIP (exists): ${trimmed.slice(0, 60).replace(/\n/g, " ")}...`);
      } else {
        console.error(`  FAIL: ${trimmed.slice(0, 60).replace(/\n/g, " ")}...`);
        console.error(`        ${msg}`);
      }
    }
  }

  console.log("\nMigration complete.");
  await closePool();
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "$" && sql[i + 1] === "$") {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i++;
      continue;
    }

    if (char === ";" && !inDollarQuote) {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
