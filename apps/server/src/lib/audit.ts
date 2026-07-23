import type { PoolClient } from "pg";
import { pool } from "./database.js";

type AuditInput = {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
};

export async function writeAudit(input: AuditInput, client?: PoolClient): Promise<void> {
  const executor = client ?? pool;
  await executor.query(
    `INSERT INTO audit_logs(actor_user_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      input.actorUserId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.details ?? {}),
      input.ipAddress ?? null
    ]
  );
}

