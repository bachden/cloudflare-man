import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth.js";
import { pool } from "../lib/database.js";

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard", { preHandler: requireAuth }, async () => {
    const [stats, accountCapacity, recentStores, audit] = await Promise.all([
      pool.query(`
        SELECT (SELECT count(*)::int FROM stores) AS "totalStores",
               (SELECT count(*)::int FROM stores WHERE tunnel_status = 'healthy') AS "healthyStores",
               (SELECT count(*)::int FROM stores WHERE onboarding_status IN ('url_issued', 'waiting_for_new_enrollment', 'claimed', 'provisioning', 'connector_online')) AS "onboardingStores",
               (SELECT count(*)::int FROM stores WHERE onboarding_status = 'failed' OR tunnel_status IN ('down', 'degraded') OR rdp_status = 'failed') AS "attentionStores",
               (SELECT count(*)::int FROM cloudflare_accounts WHERE status = 'active') AS "activeAccounts",
               (SELECT count(*)::int FROM zones WHERE status = 'active') AS "activeZones"
      `),
      pool.query(`
        SELECT a.id, a.name, a.soft_tunnel_limit AS "softLimit",
               (SELECT count(*)::int FROM stores s WHERE s.account_id = a.id) AS "storeCount",
               (SELECT count(*)::int FROM zones z WHERE z.account_id = a.id AND z.status = 'active') AS "zoneCount",
               a.status
          FROM cloudflare_accounts a ORDER BY a.created_at ASC
      `),
      pool.query(`
        SELECT s.id, s.display_name AS "displayName", s.store_code AS "storeCode", s.hostname,
               s.onboarding_status AS "onboardingStatus", s.tunnel_status AS "tunnelStatus", s.created_at AS "createdAt"
          FROM stores s ORDER BY s.created_at DESC LIMIT 6
      `),
      pool.query(`
        SELECT id, action, entity_type AS "entityType", entity_id AS "entityId", details, created_at AS "createdAt"
          FROM audit_logs ORDER BY created_at DESC LIMIT 8
      `)
    ]);
    return {
      stats: stats.rows[0],
      accountCapacity: accountCapacity.rows,
      recentStores: recentStores.rows,
      recentActivity: audit.rows
    };
  });

  app.get("/api/audit", { preHandler: requireAuth }, async () => {
    const result = await pool.query(`
      SELECT l.id, l.action, l.entity_type AS "entityType", l.entity_id AS "entityId", l.details,
             l.ip_address AS "ipAddress", l.created_at AS "createdAt", u.username
        FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_user_id
       ORDER BY l.created_at DESC LIMIT 250
    `);
    return { entries: result.rows };
  });
}
