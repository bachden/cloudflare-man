import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/database.js";
import { reconfigureStore } from "../lib/provisioning.js";
import { provisionBrowserRdp } from "../lib/rdp.js";
import { verifyStoreEndpoints } from "../lib/store-verification.js";
import { createOpaqueToken, hashToken } from "../lib/security.js";
import { selectZone, slugifyLabel } from "../lib/stores.js";
import { createCommandExecution, executeStoreScript, getCommandAgentConfig, ensureCommandAgentToken, COMMAND_AGENT_SERVICE_URL } from "../lib/command-agent.js";

const serviceUrlSchema = z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
  message: "Service URL must use HTTP or HTTPS"
});

const routeKindSchema = z.enum(["service", "command_agent"]);
const routeSchema = z.object({
  kind: routeKindSchema.default("service"),
  path: z.string().trim().min(1).max(200).regex(/^\//, "Path must start with /").transform(normalizePath),
  serviceUrl: serviceUrlSchema.optional()
}).superRefine((route, context) => {
  if (route.kind === "service" && !route.serviceUrl) {
    context.addIssue({ code: "custom", path: ["serviceUrl"], message: "A service URL is required" });
  }
});

function normalizePath(value: string): string {
  let path = value.trim();
  if (path.endsWith("/*")) path = path.slice(0, -2);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

const publicationSchema = z.object({
  suffix: z.string().trim().max(30).regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,28}[a-zA-Z0-9])?)?$/,
    "Suffix can contain letters, numbers, and inner hyphens"
  ).transform((value) => value.toLowerCase()),
  routes: z.array(routeSchema).min(1).max(20)
});

const publicationsSchema = z.array(publicationSchema).min(1).max(20).superRefine((publications, context) => {
  let commandAgentRoutes = 0;
  const suffixes = new Set<string>();
  publications.forEach((publication, publicationIndex) => {
    if (suffixes.has(publication.suffix)) {
      context.addIssue({ code: "custom", path: [publicationIndex, "suffix"], message: "Each subdomain suffix must be unique" });
    }
    suffixes.add(publication.suffix);
    const paths = new Set<string>();
    publication.routes.forEach((route, routeIndex) => {
      if (route.kind === "command_agent") commandAgentRoutes += 1;
      if (paths.has(route.path)) {
        context.addIssue({ code: "custom", path: [publicationIndex, "routes", routeIndex, "path"], message: "Each path must be unique within its subdomain" });
      }
      paths.add(route.path);
    });
  });
  if (commandAgentRoutes > 1) {
    context.addIssue({ code: "custom", message: "Only one command agent route can be configured per store" });
  }
});

const createStoreSchema = z.object({
  tenantCode: z.string().trim().min(1).max(80),
  storeCode: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(2).max(160),
  originUrl: serviceUrlSchema.optional(),
  zoneId: z.string().uuid().optional(),
  publications: publicationsSchema.optional()
}).superRefine((data, context) => {
  if (!data.publications && !data.originUrl) {
    context.addIssue({ code: "custom", path: ["originUrl"], message: "An origin URL or publication routes are required" });
  }
});

const connectivitySchema = z.object({ publications: publicationsSchema });

const listQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25)
});

const refreshStoresSchema = z.object({
  storeIds: z.array(z.string().uuid()).min(1).max(100)
});

const enrollmentSchema = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(24)
});

const executeScriptSchema = z.object({
  scriptVersionId: z.string().uuid(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(60_000)
});

async function enrollmentUrls(token: string) {
  const publicBaseUrl = await getPublicBaseUrl();
  return {
    shell: `${publicBaseUrl}/e/${token}/install.sh`,
    powershell: `${publicBaseUrl}/e/${token}/install.ps1`
  };
}

async function unenrollmentUrls(token: string) {
  const publicBaseUrl = await getPublicBaseUrl();
  return {
    shell: `${publicBaseUrl}/e/${token}/unenroll.sh`,
    powershell: `${publicBaseUrl}/e/${token}/unenroll.ps1`
  };
}

const publicationsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', p.id,
    'suffix', p.suffix,
    'hostname', p.hostname,
    'status', p.status,
    'lastError', p.last_error,
    'routes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id,
        'path', r.path,
        'serviceUrl', r.service_url,
        'kind', r.route_kind
      ) ORDER BY r.sort_order, r.created_at)
      FROM store_routes r WHERE r.publication_id = p.id
    ), '[]'::jsonb)
  ) ORDER BY p.created_at)
  FROM store_publications p WHERE p.store_id = s.id
), '[]'::jsonb)`;

const enrollmentsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', e.id,
    'status', e.status,
    'platform', CASE WHEN e.platform = 'windows' THEN 'windows' WHEN e.platform IS NOT NULL THEN 'unix' ELSE null END,
    'createdAt', e.created_at,
    'expiresAt', e.expires_at,
    'claimedAt', e.claimed_at,
    'installedAt', e.installed_at,
    'lastError', e.last_error,
    'hostInfo', e.host_info,
    'unenrollStatus', CASE
      WHEN e.unenrolled_at IS NOT NULL THEN 'unenrolled'
      WHEN e.unenroll_last_error IS NOT NULL THEN 'failed'
      WHEN e.unenroll_token_hash IS NOT NULL THEN 'pending'
      ELSE 'not_required'
    END,
    'unenrollRequestedAt', e.unenroll_requested_at,
    'unenrolledAt', e.unenrolled_at,
    'logCount', (SELECT count(*)::int FROM enrollment_logs l WHERE l.enrollment_id = e.id),
    'scripts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', es.script_kind,
        'platform', es.platform,
        'status', es.status,
        'startedAt', es.started_at,
        'finishedAt', es.finished_at,
        'lastError', es.last_error
      ) ORDER BY es.script_kind, es.platform)
      FROM enrollment_scripts es WHERE es.enrollment_id = e.id
    ), '[]'::jsonb)
  ) ORDER BY e.created_at DESC)
  FROM enrollments e WHERE e.store_id = s.id
), '[]'::jsonb)`;

const commandAgentJson = `(
  SELECT jsonb_build_object(
    'enabled', true,
    'hostname', p.hostname,
    'path', r.path,
    'endpoint', CASE WHEN r.path = '/' THEN 'https://' || p.hostname || '/exec'
                     ELSE 'https://' || p.hostname || r.path || '/exec' END,
    'status', ca.status,
    'lastSeenAt', ca.last_seen_at,
    'lastError', ca.last_error
  )
    FROM store_publications p
    JOIN store_routes r ON r.publication_id = p.id AND r.route_kind = 'command_agent'
    JOIN store_command_agents ca ON ca.store_id = s.id
   WHERE p.store_id = s.id
   ORDER BY p.created_at, r.sort_order, r.created_at
   LIMIT 1
)`;

const commandExecutionsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', ce.id,
    'enrollmentId', ce.enrollment_id,
    'scriptVersionId', ce.script_version_id,
    'scriptName', ce.name,
    'scriptVersion', ce.version,
    'platform', ce.platform,
    'language', ce.language,
    'script', ce.script,
    'timeoutMs', ce.timeout_ms,
    'status', ce.status,
    'startedAt', ce.started_at,
    'finishedAt', ce.finished_at,
    'elapsedMs', ce.elapsed_ms,
    'exitCode', ce.exit_code,
    'stdout', ce.stdout,
    'stderr', ce.stderr,
    'error', ce.error,
    'requestedBy', ce.username
  ) ORDER BY ce.created_at DESC)
  FROM LATERAL (
    SELECT ce.*, u.username, sv.version, ms.name, ms.platform, ms.language
      FROM store_command_executions ce
      LEFT JOIN users u ON u.id = ce.requested_by
      LEFT JOIN managed_script_versions sv ON sv.id = ce.script_version_id
      LEFT JOIN managed_scripts ms ON ms.id = sv.script_id
     WHERE ce.store_id = s.id
     ORDER BY ce.created_at DESC
     LIMIT 50
  ) ce
), '[]'::jsonb)`;

function preparePublications(
  storeCode: string,
  zoneName: string,
  publications: z.infer<typeof publicationsSchema>
) {
  const baseLabel = slugifyLabel(storeCode);
  return publications.map((publication) => ({
    ...publication,
    routes: publication.routes.map((route) => ({
      ...route,
      serviceUrl: route.kind === "command_agent" ? COMMAND_AGENT_SERVICE_URL : route.serviceUrl!
    })),
    hostname: `${publication.suffix ? `${baseLabel}-${publication.suffix}` : baseLabel}.${zoneName}`
  }));
}

export async function storeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stores", { preHandler: requireAuth }, async (request) => {
    const query = listQuerySchema.parse(request.query);
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.search) {
      values.push(`%${query.search}%`);
      conditions.push(`(s.store_code ILIKE $${values.length} OR s.tenant_code ILIKE $${values.length} OR s.display_name ILIKE $${values.length} OR s.hostname ILIKE $${values.length} OR EXISTS (SELECT 1 FROM store_publications p WHERE p.store_id = s.id AND p.hostname ILIKE $${values.length}))`);
    }
    if (query.status) {
      values.push(query.status);
      conditions.push(`s.onboarding_status = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await pool.query(`SELECT count(*)::int AS total FROM stores s ${where}`, values);
    const total = countResult.rows[0]?.total as number ?? 0;
    const offset = (query.page - 1) * query.pageSize;
    const pageValues = [...values, query.pageSize, offset];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.store_code AS "storeCode", s.display_name AS "displayName",
             s.origin_url AS "originUrl", s.hostname, s.tunnel_id AS "tunnelId", s.tunnel_name AS "tunnelName",
             s.tunnel_status AS "tunnelStatus", s.onboarding_status AS "onboardingStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.created_at AS "createdAt", a.id AS "accountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications
        FROM stores s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
        ${where}
       ORDER BY s.created_at DESC
       LIMIT $${limitParameter} OFFSET $${offsetParameter}
    `, pageValues);
    return {
      stores: result.rows,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/stores/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.store_code AS "storeCode", s.display_name AS "displayName",
             s.origin_url AS "originUrl", s.hostname, s.tunnel_id AS "tunnelId", s.tunnel_name AS "tunnelName",
             s.tunnel_status AS "tunnelStatus", s.onboarding_status AS "onboardingStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.created_at AS "createdAt", a.id AS "accountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${enrollmentsJson} AS enrollments,
             ${commandAgentJson} AS "commandAgent",
             ${commandExecutionsJson} AS "commandExecutions"
        FROM stores s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
       WHERE s.id = $1
    `, [id]);
    if (!result.rowCount) return reply.code(404).send({ error: "Store not found" });
    return { store: result.rows[0] };
  });

  app.get("/api/stores/:storeId/enrollments/:enrollmentId/logs", { preHandler: requireAuth }, async (request, reply) => {
    const { storeId, enrollmentId } = z.object({
      storeId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const result = await pool.query(
      `SELECT l.id, l.level, l.step, l.message, l.metadata, l.created_at AS "createdAt"
         FROM enrollment_logs l
         JOIN enrollments e ON e.id = l.enrollment_id
        WHERE e.store_id = $1 AND e.id = $2
        ORDER BY l.created_at ASC, l.id ASC`,
      [storeId, enrollmentId]
    );
    const enrollment = await pool.query("SELECT 1 FROM enrollments WHERE id = $1 AND store_id = $2", [enrollmentId, storeId]);
    if (!enrollment.rowCount) return reply.code(404).send({ error: "Enrollment not found" });
    return { logs: result.rows };
  });

  app.post("/api/stores/:id/commands/execute", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = executeScriptSchema.parse(request.body);
    const enrollmentResult = await pool.query(
      `SELECT id, platform
         FROM enrollments
        WHERE store_id = $1
          AND status IN ('ready', 'installed')
          AND unenrolled_at IS NULL
        ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
        LIMIT 1`,
      [id]
    );
    const enrollment = enrollmentResult.rows[0];
    if (!enrollment) return reply.code(409).send({ error: "This store has no active enrollment" });
    const scriptVersionResult = await pool.query(
      `SELECT v.id, v.content, v.version, s.id AS script_id, s.name, s.platform, s.language
         FROM managed_script_versions v
         JOIN managed_scripts s ON s.id = v.script_id
        WHERE v.id = $1`,
      [body.scriptVersionId]
    );
    const scriptVersion = scriptVersionResult.rows[0];
    if (!scriptVersion) return reply.code(404).send({ error: "Script version not found" });
    const enrollmentPlatform = enrollment.platform === "windows" ? "windows" : "unix";
    if (scriptVersion.platform !== enrollmentPlatform) {
      return reply.code(409).send({ error: `This script is for ${scriptVersion.platform}, but the active enrollment is ${enrollmentPlatform}` });
    }
    const agent = await getCommandAgentConfig(id);
    if (!agent) return reply.code(409).send({ error: "No command agent route is configured for this store" });
    const executionId = await createCommandExecution(id, enrollment.id, scriptVersion.id, request.authUser!.id, scriptVersion.content, body.timeoutMs);
    try {
      const result = await executeStoreScript(id, scriptVersion.content, body.timeoutMs, executionId);
      if (!result) return reply.code(409).send({ error: "No command agent route is configured for this store" });
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "store.command_executed",
        entityType: "store",
        entityId: id,
        details: { endpoint: agent.endpoint, executionId, enrollmentId: enrollment.id, scriptVersionId: scriptVersion.id, timeoutMs: body.timeoutMs, success: result.success, exitCode: result.exitCode }
      });
      return { executionId, endpoint: agent.endpoint, enrollmentId: enrollment.id, scriptVersionId: scriptVersion.id, scriptName: scriptVersion.name, version: scriptVersion.version, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command agent execution failed";
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "store.command_executed",
        entityType: "store",
        entityId: id,
        details: { endpoint: agent.endpoint, executionId, enrollmentId: enrollment.id, scriptVersionId: scriptVersion.id, timeoutMs: body.timeoutMs, success: false, error: message }
      });
      return reply.code(502).send({ error: message, executionId });
    }
  });

  app.post("/api/stores", { preHandler: requireAuth }, async (request, reply) => {
    const body = createStoreSchema.parse(request.body);
    const storeId = await withTransaction(async (client) => {
      const allocation = await selectZone(client, body.zoneId);
      const publications = body.publications ?? [{ suffix: "", routes: [{ kind: "service" as const, path: "/", serviceUrl: body.originUrl! }] }];
      const prepared = body.publications
        ? preparePublications(body.storeCode, allocation.zoneName, publications)
        : publications.map((publication) => ({ ...publication, hostname: `${slugifyLabel(`${body.tenantCode}-${body.storeCode}`)}.${allocation.zoneName}` }));
      const primary = prepared[0];
      if (!primary) throw new Error("At least one published endpoint is required");
      const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
      if (!primaryRoute) throw new Error("The primary published endpoint requires at least one route");
      const result = await client.query(
        `INSERT INTO stores(tenant_code, store_code, display_name, origin_url, account_id, zone_id, hostname)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, tenant_code AS "tenantCode", store_code AS "storeCode", display_name AS "displayName", hostname`,
        [body.tenantCode, body.storeCode, body.displayName, primaryRoute.serviceUrl, allocation.accountId, allocation.zoneId, primary.hostname]
      );
      for (const publication of prepared) {
        const inserted = await client.query(
          `INSERT INTO store_publications(store_id, suffix, hostname)
           VALUES ($1, $2, $3) RETURNING id`,
          [result.rows[0].id, publication.suffix, publication.hostname]
        );
        for (const [index, route] of publication.routes.entries()) {
          await client.query(
            `INSERT INTO store_routes(publication_id, path, service_url, route_kind, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [inserted.rows[0].id, route.path, route.serviceUrl, route.kind ?? "service", index]
          );
        }
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "store.created",
        entityType: "store",
        entityId: result.rows[0].id,
        details: {
          hostnames: prepared.map((publication) => publication.hostname),
          routeCount: prepared.reduce((total, publication) => total + publication.routes.length, 0),
          accountId: allocation.accountId,
          zoneId: allocation.zoneId
        }
      }, client);
      return result.rows[0].id as string;
    });
    const created = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.store_code AS "storeCode", s.display_name AS "displayName",
             s.origin_url AS "originUrl", s.hostname, s.tunnel_id AS "tunnelId", s.tunnel_name AS "tunnelName",
             s.tunnel_status AS "tunnelStatus", s.onboarding_status AS "onboardingStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.created_at AS "createdAt", a.id AS "accountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${commandAgentJson} AS "commandAgent"
        FROM stores s JOIN cloudflare_accounts a ON a.id = s.account_id JOIN zones z ON z.id = s.zone_id
       WHERE s.id = $1
    `, [storeId]);
    return reply.code(201).send({ store: created.rows[0] });
  });

  app.put("/api/stores/:id/connectivity", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = connectivitySchema.parse(request.body);
    const update = await withTransaction(async (client) => {
      const storeResult = await client.query(
        `SELECT s.id, s.store_code, s.tunnel_id, z.name AS zone_name
           FROM stores s JOIN zones z ON z.id = s.zone_id
          WHERE s.id = $1
          FOR UPDATE OF s`,
        [id]
      );
      const store = storeResult.rows[0];
      if (!store) return null;

      const existingResult = await client.query(
        "SELECT hostname, dns_record_id FROM store_publications WHERE store_id = $1 ORDER BY created_at",
        [id]
      );
      const existingByHostname = new Map<string, { dnsRecordId: string | null }>(
        existingResult.rows.map((publication) => [publication.hostname, { dnsRecordId: publication.dns_record_id }])
      );
      const prepared = preparePublications(store.store_code, store.zone_name, body.publications);
      const desiredHostnames = new Set(prepared.map((publication) => publication.hostname));
      const removedDnsRecordIds = existingResult.rows
        .filter((publication) => publication.dns_record_id && !desiredHostnames.has(publication.hostname))
        .map((publication) => publication.dns_record_id as string);

      await client.query("DELETE FROM store_publications WHERE store_id = $1", [id]);
      for (const publication of prepared) {
        const existing = existingByHostname.get(publication.hostname);
        const inserted = await client.query(
          `INSERT INTO store_publications(store_id, suffix, hostname, dns_record_id, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, publication.suffix, publication.hostname, existing?.dnsRecordId ?? null, existing?.dnsRecordId ? "active" : "pending"]
        );
        for (const [index, route] of publication.routes.entries()) {
          await client.query(
            `INSERT INTO store_routes(publication_id, path, service_url, route_kind, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [inserted.rows[0].id, route.path, route.serviceUrl, route.kind, index]
          );
        }
      }
      const primary = prepared[0];
      if (!primary) throw new Error("At least one published endpoint is required");
      const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
      if (!primaryRoute) throw new Error("The primary published endpoint requires at least one route");
      await client.query(
        "UPDATE stores SET hostname = $1, origin_url = $2, dns_record_id = $3, last_error = null, updated_at = now() WHERE id = $4",
        [primary.hostname, primaryRoute.serviceUrl, existingByHostname.get(primary.hostname)?.dnsRecordId ?? null, id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "store.connectivity_updated",
        entityType: "store",
        entityId: id,
        details: {
          hostnames: prepared.map((publication) => publication.hostname),
          routeCount: prepared.reduce((total, publication) => total + publication.routes.length, 0),
          removedHostnameCount: existingResult.rows.length - existingResult.rows.filter((publication) => desiredHostnames.has(publication.hostname)).length
        }
      }, client);
      return { tunnelId: store.tunnel_id as string | null, removedDnsRecordIds };
    });
    if (!update) return reply.code(404).send({ error: "Store not found" });

    try {
      const applied = update.tunnelId ? await reconfigureStore(id, update.removedDnsRecordIds) : false;
      return { success: true, applied };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connectivity update failed";
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/api/stores/:id/enrollments", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = enrollmentSchema.parse(request.body ?? {});
    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
    const issued = await withTransaction(async (client) => {
      const store = await client.query("SELECT id, tunnel_status FROM stores WHERE id = $1 FOR UPDATE", [id]);
      if (!store.rowCount) throw new Error("Store not found");
      await ensureCommandAgentToken(client, id);
      const previous: Array<{ enrollmentId: string; createdAt: string; expiresAt: Date; rawToken: string }> = [];
      if (["healthy", "degraded", "connector_online"].includes(store.rows[0].tunnel_status)) {
        const active = await client.query(
          `SELECT id, created_at
             FROM enrollments
            WHERE store_id = $1
              AND status IN ('claimed', 'provisioning', 'ready', 'installed')
              AND unenrolled_at IS NULL
            ORDER BY created_at DESC`,
          [id]
        );
        for (const row of active.rows) {
          const cleanupToken = createOpaqueToken();
          await client.query(
            `UPDATE enrollments
                SET unenroll_token_hash = $1, unenroll_token_expires_at = $2,
                    unenroll_requested_at = now(), unenrolled_at = null,
                    unenroll_last_error = null, updated_at = now()
              WHERE id = $3`,
            [hashToken(cleanupToken), expiresAt, row.id]
          );
          await client.query(
            `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
             VALUES ($1, 'unenroll', 'windows', 'available'), ($1, 'unenroll', 'unix', 'available')
             ON CONFLICT (enrollment_id, script_kind, platform) DO UPDATE SET
               status = 'available', started_at = null, finished_at = null, last_error = null, updated_at = now()`,
            [row.id]
          );
          previous.push({ enrollmentId: row.id, createdAt: row.created_at, expiresAt, rawToken: cleanupToken });
        }
      }
      await client.query(
        "UPDATE enrollments SET status = 'revoked', updated_at = now() WHERE store_id = $1 AND status IN ('url_issued', 'claimed', 'failed')",
        [id]
      );
      const result = await client.query(
        `INSERT INTO enrollments(store_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [id, hashToken(rawToken), expiresAt, request.authUser!.id]
      );
      await client.query(
        `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
         VALUES ($1, 'install', 'windows', 'available'), ($1, 'install', 'unix', 'available')`,
        [result.rows[0].id]
      );
      await client.query(
        "UPDATE stores SET onboarding_status = 'url_issued', last_error = null, updated_at = now() WHERE id = $1",
        [id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.issued",
        entityType: "store",
        entityId: id,
        details: {
          enrollmentId: result.rows[0].id,
          expiresAt,
          unenrollEnrollmentIds: previous.map((item) => item.enrollmentId)
        }
      }, client);
      return { id: result.rows[0].id as string, previous };
    });
    return reply.code(201).send({
      id: issued.id,
      expiresAt,
      urls: await enrollmentUrls(rawToken),
      unenrollCommands: await Promise.all(issued.previous.map(async (item) => ({
        enrollmentId: item.enrollmentId,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        urls: await unenrollmentUrls(item.rawToken)
      })))
    });
  });

  app.post("/api/stores/:id/enrollments/revoke", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const revoked = await withTransaction(async (client) => {
      const store = await client.query("SELECT id, onboarding_status FROM stores WHERE id = $1 FOR UPDATE", [id]);
      if (!store.rowCount) return null;
      const result = await client.query(
        `UPDATE enrollments SET status = 'revoked', updated_at = now()
            WHERE store_id = $1 AND status IN ('url_issued', 'claimed', 'provisioning', 'ready', 'failed')
          RETURNING id`,
        [id]
      );
      if (["url_issued", "claimed", "provisioning", "failed"].includes(store.rows[0].onboarding_status)) {
        await client.query("UPDATE stores SET onboarding_status = 'revoked', updated_at = now() WHERE id = $1", [id]);
      }
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.revoked",
        entityType: "store",
        entityId: id,
        details: { enrollmentCount: result.rowCount }
      }, client);
      return result.rowCount;
    });
    if (revoked === null) return reply.code(404).send({ error: "Store not found" });
    return { success: true, revoked };
  });

  app.post("/api/stores/:id/verify", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await verifyStoreEndpoints(id, { actorUserId: request.authUser!.id });
    if (!result) return reply.code(404).send({ error: "Store not found" });
    return result;
  });

  app.post("/api/stores/refresh", { preHandler: requireAuth }, async (request) => {
    const body = refreshStoresSchema.parse(request.body);
    const results: Array<{ storeId: string; success: boolean; error?: string }> = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < body.storeIds.length) {
        const storeId = body.storeIds[nextIndex++]!;
        try {
          const result = await verifyStoreEndpoints(storeId, {
            actorUserId: request.authUser!.id,
            attempts: 2,
            retryDelayMs: 1_000
          });
          results.push({ storeId, success: result?.success ?? false, ...(!result ? { error: "Store not found" } : {}) });
        } catch (error) {
          results.push({
            storeId,
            success: false,
            error: error instanceof Error ? error.message : "Store refresh failed"
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, body.storeIds.length) }, () => worker()));
    const refreshed = results.filter((result) => result.success).length;
    return { success: refreshed === results.length, refreshed, failed: results.length - refreshed, results };
  });

  app.post("/api/stores/:id/rdp/retry", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const store = await pool.query("SELECT id, rdp_target_ip FROM stores WHERE id = $1", [id]);
    if (!store.rowCount) return reply.code(404).send({ error: "Store not found" });
    if (!store.rows[0].rdp_target_ip) {
      return reply.code(409).send({ error: "The Windows installer has not reported an RDP target IP" });
    }
    const result = await provisionBrowserRdp(id);
    if (!result.ready) return reply.code(502).send({ error: result.error ?? "RDP provisioning failed" });
    return result;
  });
}
