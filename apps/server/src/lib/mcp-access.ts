import type { Pool, PoolClient } from "pg";
import { pool } from "./database.js";
import { createOpaqueToken, hashToken } from "./security.js";

type QueryExecutor = Pick<Pool | PoolClient, "query">;

export type McpAccessSetting = {
  enabled: boolean;
  tokenHint: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
};

function newMcpToken(): string {
  return `cfman_mcp_${createOpaqueToken()}`;
}

function tokenHint(token: string): string {
  return `${token.slice(0, 14)}...${token.slice(-6)}`;
}

export async function getMcpAccessSetting(executor: QueryExecutor = pool): Promise<McpAccessSetting> {
  const result = await executor.query(
    `SELECT enabled, token_hint AS "tokenHint", rotated_at AS "rotatedAt", last_used_at AS "lastUsedAt"
       FROM mcp_access
      WHERE singleton = true`
  );
  return result.rows[0] ?? { enabled: false, tokenHint: null, rotatedAt: null, lastUsedAt: null };
}

export async function setMcpEnabled(
  enabled: boolean,
  userId: string,
  executor: QueryExecutor = pool
): Promise<{ setting: McpAccessSetting; token?: string }> {
  const current = await executor.query("SELECT token_hash FROM mcp_access WHERE singleton = true FOR UPDATE");
  let token: string | undefined;
  let tokenHash: string | null = current.rows[0]?.token_hash ?? null;
  let hint: string | null = null;
  if (enabled && !tokenHash) {
    token = newMcpToken();
    tokenHash = hashToken(token);
    hint = tokenHint(token);
  }
  await executor.query(
    `INSERT INTO mcp_access(singleton, enabled, token_hash, token_hint, owner_user_id, updated_by, rotated_at, updated_at)
     VALUES (true, $1, $2, $3, $4, $4, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, now())
     ON CONFLICT (singleton) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       token_hash = COALESCE(mcp_access.token_hash, EXCLUDED.token_hash),
       token_hint = COALESCE(mcp_access.token_hint, EXCLUDED.token_hint),
       owner_user_id = COALESCE(mcp_access.owner_user_id, EXCLUDED.owner_user_id),
       updated_by = EXCLUDED.updated_by,
       rotated_at = COALESCE(mcp_access.rotated_at, EXCLUDED.rotated_at),
       updated_at = now()`,
    [enabled, tokenHash, hint, userId]
  );
  return { setting: await getMcpAccessSetting(executor), ...(token ? { token } : {}) };
}

export async function rotateMcpToken(
  userId: string,
  executor: QueryExecutor = pool
): Promise<{ setting: McpAccessSetting; token: string }> {
  const token = newMcpToken();
  await executor.query(
    `INSERT INTO mcp_access(singleton, enabled, token_hash, token_hint, owner_user_id, updated_by, rotated_at, updated_at)
     VALUES (true, true, $1, $2, $3, $3, now(), now())
     ON CONFLICT (singleton) DO UPDATE SET
       enabled = true,
       token_hash = EXCLUDED.token_hash,
       token_hint = EXCLUDED.token_hint,
       owner_user_id = EXCLUDED.owner_user_id,
       updated_by = EXCLUDED.updated_by,
       rotated_at = now(),
       updated_at = now()`,
    [hashToken(token), tokenHint(token), userId]
  );
  return { setting: await getMcpAccessSetting(executor), token };
}

export async function authenticateMcpToken(token: string): Promise<{
  id: string;
  username: string;
  mustChangePassword: boolean;
} | null> {
  const result = await pool.query(
    `SELECT u.id, u.username, u.must_change_password AS "mustChangePassword"
       FROM mcp_access m
       JOIN users u ON u.id = m.owner_user_id
      WHERE m.singleton = true
        AND m.enabled = true
        AND m.token_hash = $1`,
    [hashToken(token)]
  );
  if (!result.rowCount) return null;
  void pool.query("UPDATE mcp_access SET last_used_at = now() WHERE singleton = true");
  return result.rows[0];
}
