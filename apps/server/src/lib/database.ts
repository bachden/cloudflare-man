import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import pg, { type PoolClient } from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  options: `-c search_path=${config.DATABASE_SCHEMA},public`,
  max: 12,
  idleTimeoutMillis: 30_000
});

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDatabaseIfMissing(): Promise<void> {
  const safeSchema = config.DATABASE_SCHEMA.replaceAll('"', '""');
  const adminPool = new Pool({ connectionString: config.DATABASE_URL });
  try {
    await adminPool.query(`CREATE SCHEMA IF NOT EXISTS "${safeSchema}"`);
  } finally {
    await adminPool.end();
  }
}

export async function runMigrations(): Promise<void> {
  await createDatabaseIfMissing();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const name = basename(file);
    const existing = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (existing.rowCount) continue;
    const sql = await readFile(join(migrationDirectory, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    });
  }
}

export async function seedRootUser(): Promise<void> {
  const existing = await pool.query("SELECT 1 FROM users WHERE username = 'root'");
  if (existing.rowCount) return;
  const passwordHash = await bcrypt.hash("12345678", 12);
  await pool.query(
    "INSERT INTO users(username, password_hash, must_change_password) VALUES ('root', $1, true)",
    [passwordHash]
  );
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
