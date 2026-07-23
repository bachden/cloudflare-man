import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { createOpaqueToken, decryptSecret, encryptSecret } from "./security.js";

export const COMMAND_AGENT_SERVICE_URL = "http://127.0.0.1:47831";

type Queryable = Pick<PoolClient, "query">;

export type CommandAgentConfig = {
  storeId: string;
  hostname: string;
  path: string;
  endpoint: string;
  token: string;
  status: "pending" | "ready" | "failed";
  lastSeenAt: string | null;
  lastError: string | null;
};

export async function ensureCommandAgentToken(client: Queryable, storeId: string): Promise<string> {
  const existing = await client.query("SELECT token_encrypted FROM store_command_agents WHERE store_id = $1", [storeId]);
  if (existing.rows[0]?.token_encrypted) return decryptSecret(existing.rows[0].token_encrypted as string);
  const token = createOpaqueToken();
  await client.query(
    `INSERT INTO store_command_agents(store_id, token_encrypted)
     VALUES ($1, $2)
     ON CONFLICT (store_id) DO NOTHING`,
    [storeId, encryptSecret(token)]
  );
  const inserted = await client.query("SELECT token_encrypted FROM store_command_agents WHERE store_id = $1", [storeId]);
  if (!inserted.rows[0]?.token_encrypted) throw new Error("Unable to initialize the store command agent");
  return decryptSecret(inserted.rows[0].token_encrypted as string);
}

export async function getCommandAgentConfig(storeId: string): Promise<CommandAgentConfig | null> {
  const result = await pool.query(
    `SELECT s.id AS store_id, p.hostname, r.path, ca.token_encrypted, ca.status,
            ca.last_seen_at, ca.last_error
       FROM stores s
       JOIN store_publications p ON p.store_id = s.id
       JOIN store_routes r ON r.publication_id = p.id AND r.route_kind = 'command_agent'
       JOIN store_command_agents ca ON ca.store_id = s.id
      WHERE s.id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at
      LIMIT 1`,
    [storeId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    storeId: row.store_id,
    hostname: row.hostname,
    path: row.path,
    endpoint: `https://${row.hostname}${row.path}`,
    token: decryptSecret(row.token_encrypted),
    status: row.status,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error
  };
}

export type CommandExecutionResult = {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function createCommandExecution(
  input: {
    storeId: string;
    enrollmentId: string;
    scriptVersionId: string | null;
    requestedBy: string;
    script: string;
    timeoutMs: number;
    scriptType: "managed" | "inline";
    scriptName: string;
    scriptPlatform: "windows" | "unix";
    scriptLanguage: "powershell" | "bash" | "sh";
    scriptVersion: number | null;
  }
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO store_command_executions(
       store_id, enrollment_id, script_version_id, requested_by, script, timeout_ms,
       script_type, script_name, script_platform, script_language, script_version_number
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.storeId,
      input.enrollmentId,
      input.scriptVersionId,
      input.requestedBy,
      input.script,
      input.timeoutMs,
      input.scriptType,
      input.scriptName,
      input.scriptPlatform,
      input.scriptLanguage,
      input.scriptVersion
    ]
  );
  return result.rows[0].id as string;
}

async function finishCommandExecution(
  executionId: string,
  status: "succeeded" | "failed" | "timed_out",
  startedAt: number,
  result: Partial<CommandExecutionResult> & { error?: string }
): Promise<void> {
  await pool.query(
    `UPDATE store_command_executions
        SET status = $1, finished_at = now(), elapsed_ms = $2, exit_code = $3,
            stdout = $4, stderr = $5, error = $6
      WHERE id = $7`,
    [
      status,
      Math.max(0, Date.now() - startedAt),
      typeof result.exitCode === "number" ? result.exitCode : null,
      result.stdout ?? "",
      result.stderr ?? "",
      result.error ?? null,
      executionId
    ]
  );
}

export async function executeStoreScript(
  storeId: string,
  script: string,
  timeoutMs: number,
  executionId?: string
): Promise<CommandExecutionResult | null> {
  const agent = await getCommandAgentConfig(storeId);
  const startedAt = Date.now();
  if (!agent) {
    if (executionId) await finishCommandExecution(executionId, "failed", startedAt, { error: "No command agent route is configured for this store" });
    return null;
  }
  try {
    const response = await fetch(agent.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cloudflare-Man-Agent-Token": agent.token
      },
      body: JSON.stringify({ script, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 10_000)
    });
    const payload = await response.json().catch(() => ({})) as Partial<CommandExecutionResult> & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `Command agent returned HTTP ${response.status}`);
    const result: CommandExecutionResult = {
      success: Boolean(payload.success),
      exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
      stdout: typeof payload.stdout === "string" ? payload.stdout : "",
      stderr: typeof payload.stderr === "string" ? payload.stderr : "",
      durationMs: typeof payload.durationMs === "number" ? payload.durationMs : Date.now() - startedAt
    };
    if (executionId) {
      await finishCommandExecution(
        executionId,
        payload.error === "Script timed out" ? "timed_out" : result.success ? "succeeded" : "failed",
        startedAt,
        payload.error ? { ...result, error: payload.error } : result
      );
    }
    await pool.query(
      `UPDATE store_command_agents
          SET status = 'ready', last_seen_at = now(), last_error = null, updated_at = now()
        WHERE store_id = $1`,
      [storeId]
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command agent request failed";
    if (executionId) {
      await finishCommandExecution(
        executionId,
        error instanceof Error && error.name === "TimeoutError" ? "timed_out" : "failed",
        startedAt,
        { error: message }
      );
    }
    await pool.query(
      `UPDATE store_command_agents
          SET status = 'failed', last_error = $1, updated_at = now()
        WHERE store_id = $2`,
      [message, storeId]
    );
    throw new Error(message);
  }
}
