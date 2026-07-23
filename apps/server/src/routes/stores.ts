import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth } from "../lib/auth.js";
import { CloudflareClient } from "../lib/cloudflare.js";
import { pool, withTransaction } from "../lib/database.js";
import { decryptSecret } from "../lib/security.js";
import { reconfigureStore } from "../lib/provisioning.js";
import { isValidIpOrCidr, resolveWafAllowedIps } from "../lib/route-waf.js";
import { provisionBrowserRdp } from "../lib/rdp.js";
import { verifyStoreEndpoints } from "../lib/store-verification.js";
import { createOpaqueToken, hashToken } from "../lib/security.js";
import { selectZone, slugifyLabel } from "../lib/stores.js";
import { createCommandExecution, executeStoreScript, getCommandAgentConfig, ensureCommandAgentToken, COMMAND_AGENT_SERVICE_URL } from "../lib/command-agent.js";

const serviceUrlSchema = z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
  message: "Service URL must use HTTP or HTTPS"
});
const optionalServiceUrlSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  serviceUrlSchema.optional()
);

const routeKindSchema = z.enum(["service", "command_agent"]);
const routeSchema = z.object({
  kind: routeKindSchema.default("service"),
  path: z.string().trim().min(1).max(200).regex(/^\//, "Path must start with /").transform(normalizePath),
  serviceUrl: optionalServiceUrlSchema
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

const CIDR_MAX_LENGTH = 64;
const routeWafSchema = z.object({
  enabled: z.boolean().default(true),
  allowedIps: z.array(z.string().trim().min(1).max(CIDR_MAX_LENGTH)).max(20).default([])
});

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

const deleteStoreSchema = z.object({
  confirmName: z.string().trim().max(160).optional(),
  force: z.boolean().default(false)
});

type StoreDeleteExecutor = Pick<PoolClient, "query">;
type StoreDeleteContext = {
  id: string;
  displayName: string;
  storeCode: string;
  tunnelId: string | null;
  tunnelStatus: string;
  rdpRouteId: string | null;
  rdpTargetId: string | null;
  rdpVnetId: string | null;
  providerMode: "live" | "mock";
  accountRowId: string;
  cfAccountId: string | null;
  apiTokenEncrypted: string | null;
  cfZoneId: string | null;
  activeEnrollmentCount: number;
  activeEnrollmentPlatforms: string | null;
  runningCommandCount: number;
  commandAgentStatus: string | null;
  commandAgentLastSeenAt: string | null;
  publications: Array<{
    hostname: string;
    dnsRecordId: string | null;
    path: string;
    wafRulesetId: string | null;
    wafRuleId: string | null;
  }>;
};

type StoreDeleteCheck = {
  id: "tunnel" | "enrollments" | "commands" | "cloudflare";
  label: string;
  ok: boolean;
  detail: string;
  resolution: string;
};

type StoreDeletePreflight = {
  storeId: string;
  displayName: string;
  canDelete: boolean;
  checks: StoreDeleteCheck[];
  checkedAt: string;
};

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

async function loadStoreDeleteContext(executor: StoreDeleteExecutor, storeId: string): Promise<StoreDeleteContext | null> {
  const storeResult = await executor.query(
    `SELECT s.id, s.display_name AS "displayName", s.store_code AS "storeCode",
            s.tunnel_id AS "tunnelId", s.tunnel_status AS "tunnelStatus",
            s.rdp_route_id AS "rdpRouteId", s.rdp_target_id AS "rdpTargetId", s.rdp_vnet_id AS "rdpVnetId",
            a.id AS "accountRowId", a.provider_mode AS "providerMode", a.cf_account_id AS "cfAccountId",
            a.api_token_encrypted AS "apiTokenEncrypted", z.cf_zone_id AS "cfZoneId",
            (SELECT count(*)::int FROM enrollments e
              WHERE e.store_id = s.id
                AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL) AS "activeEnrollmentCount",
            (SELECT string_agg(COALESCE(e.platform, 'unknown'), ', ' ORDER BY e.created_at)
               FROM enrollments e
              WHERE e.store_id = s.id
                AND e.status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL) AS "activeEnrollmentPlatforms",
            (SELECT count(*)::int FROM store_command_executions ce
              WHERE ce.store_id = s.id AND ce.status = 'running') AS "runningCommandCount",
            ca.status AS "commandAgentStatus", ca.last_seen_at AS "commandAgentLastSeenAt"
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
       LEFT JOIN store_command_agents ca ON ca.store_id = s.id
      WHERE s.id = $1`,
    [storeId]
  );
  if (!storeResult.rowCount) return null;
  const publicationResult = await executor.query(
    `SELECT p.hostname, p.dns_record_id AS "dnsRecordId", r.path,
            r.waf_ruleset_id AS "wafRulesetId", r.waf_rule_id AS "wafRuleId"
       FROM store_publications p
       JOIN store_routes r ON r.publication_id = p.id
      WHERE p.store_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [storeId]
  );
  return { ...storeResult.rows[0], publications: publicationResult.rows } as StoreDeleteContext;
}

function buildStoreDeletePreflight(context: StoreDeleteContext): StoreDeletePreflight {
  const activeTunnel = Boolean(context.tunnelId && ["healthy", "degraded", "connector_online"].includes(context.tunnelStatus));
  const tunnelCheck: StoreDeleteCheck = {
    id: "tunnel",
    label: "Tunnel is disconnected",
    ok: !activeTunnel,
    detail: context.tunnelId ? `Tunnel ${context.tunnelId} is ${context.tunnelStatus}.` : "No Cloudflare Tunnel has been provisioned.",
    resolution: activeTunnel
      ? "Run the generated unenrollment command on the store, stop cloudflared if needed, then refresh this check. Force delete will terminate Cloudflare tunnel connections."
      : "No action required."
  };
  const enrollmentCheck: StoreDeleteCheck = {
    id: "enrollments",
    label: "All installed enrollments are unenrolled",
    ok: context.activeEnrollmentCount === 0,
    detail: context.activeEnrollmentCount
      ? `${context.activeEnrollmentCount} active enrollment${context.activeEnrollmentCount === 1 ? "" : "s"}${context.activeEnrollmentPlatforms ? ` (${context.activeEnrollmentPlatforms})` : ""}.`
      : "No active installed enrollment remains.",
    resolution: context.activeEnrollmentCount
      ? "Open Enrollment history, run the matching Windows or Unix unenrollment command, and wait for the status to become unenrolled."
      : "No action required."
  };
  const commandsCheck: StoreDeleteCheck = {
    id: "commands",
    label: "No command execution is running",
    ok: context.runningCommandCount === 0,
    detail: context.runningCommandCount
      ? `${context.runningCommandCount} command execution${context.runningCommandCount === 1 ? " is" : "s are"} still running.`
      : "No command execution is currently running.",
    resolution: context.runningCommandCount
      ? "Wait for the command to finish or fail. Force delete removes the local execution history and may interrupt the remote request."
      : "No action required."
  };
  const cloudflareReady = context.providerMode === "mock" || Boolean(context.cfAccountId && context.cfZoneId && context.apiTokenEncrypted);
  const cloudflareCheck: StoreDeleteCheck = {
    id: "cloudflare",
    label: "Cloudflare cleanup credentials are available",
    ok: cloudflareReady,
    detail: cloudflareReady ? `Store-owned DNS and tunnel resources can be cleaned from the ${context.providerMode} account.` : "The live account or zone is missing its API credentials.",
    resolution: cloudflareReady
      ? "No action required."
      : "Open Account pool and restore the account token and zone ID before deleting, otherwise Cloudflare resources could be orphaned."
  };
  const checks = [tunnelCheck, enrollmentCheck, commandsCheck, cloudflareCheck];
  return {
    storeId: context.id,
    displayName: context.displayName,
    canDelete: checks.every((check) => check.ok),
    checks,
    checkedAt: new Date().toISOString()
  };
}

async function cleanupStoreResources(context: StoreDeleteContext): Promise<void> {
  const client = new CloudflareClient(
    context.cfAccountId ?? context.accountRowId,
    context.apiTokenEncrypted ? decryptSecret(context.apiTokenEncrypted) : "mock",
    context.providerMode
  );
  for (const publication of context.publications) {
    if (!publication.wafRuleId || !context.cfZoneId) continue;
    await client.configureRouteWaf({
      zoneId: context.cfZoneId,
      hostname: publication.hostname,
      path: publication.path,
      enabled: false,
      allowedIps: [],
      rulesetId: publication.wafRulesetId
    });
  }
  const deletedDnsRecords = new Set<string>();
  for (const publication of context.publications) {
    if (publication.dnsRecordId && context.cfZoneId && !deletedDnsRecords.has(publication.dnsRecordId)) {
      await client.deleteDnsRecord(context.cfZoneId, publication.dnsRecordId);
      deletedDnsRecords.add(publication.dnsRecordId);
    }
  }
  if (context.rdpRouteId) await client.deleteTunnelRoute(context.rdpRouteId);
  if (context.rdpTargetId) await client.deleteInfrastructureTarget(context.rdpTargetId);
  if (context.rdpVnetId) await client.deleteVirtualNetwork(context.rdpVnetId);
  if (context.tunnelId) {
    await client.deleteTunnelConnections(context.tunnelId);
    await client.deleteTunnel(context.tunnelId);
  }
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
        'kind', r.route_kind,
        'wafEnabled', r.waf_enabled,
        'wafAllowedIps', r.waf_allowed_ips,
        'wafRulesetId', r.waf_ruleset_id,
        'wafRuleId', r.waf_rule_id
      ) ORDER BY r.sort_order, r.created_at)
      FROM store_routes r WHERE r.publication_id = p.id
    ), '[]'::jsonb)
  ) ORDER BY p.created_at)
  FROM store_publications p WHERE p.store_id = s.id
), '[]'::jsonb)`;

const latestEnrollmentJoin = `LEFT JOIN LATERAL (
  SELECT e.status, e.expires_at,
         EXISTS (
           SELECT 1
             FROM enrollments previous
            WHERE previous.store_id = e.store_id
              AND previous.id <> e.id
              AND previous.deleted_at IS NULL
              AND previous.unenrolled_at IS NULL
              AND previous.status IN ('claimed', 'provisioning', 'ready', 'installed')
         ) AS has_active_previous
    FROM enrollments e
   WHERE e.store_id = s.id
     AND e.deleted_at IS NULL
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT 1
) latest_enrollment ON TRUE`;

const onboardingStatusExpression = `CASE
  WHEN latest_enrollment.status IS NULL THEN s.onboarding_status
  WHEN latest_enrollment.status = 'url_issued' AND latest_enrollment.expires_at <= now() THEN 'expired'
  WHEN latest_enrollment.status = 'url_issued' AND latest_enrollment.has_active_previous THEN 'waiting_for_new_enrollment'
  ELSE latest_enrollment.status
END`;

const enrollmentsJson = `COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
            'id', e.id,
    'computerName', NULLIF(e.host_info->>'machineName', ''),
    'isCurrent', e.deleted_at IS NULL
      AND e.unenrolled_at IS NULL
      AND e.status IN ('ready', 'installed')
      AND e.id = (
        SELECT current_enrollment.id
          FROM enrollments current_enrollment
         WHERE current_enrollment.store_id = s.id
           AND current_enrollment.deleted_at IS NULL
           AND current_enrollment.unenrolled_at IS NULL
           AND current_enrollment.status IN ('ready', 'installed')
         ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
         LIMIT 1
      ),
    'deletedAt', e.deleted_at,
    'status', e.status,
    'platform', CASE WHEN e.platform = 'windows' THEN 'windows' WHEN e.platform IS NOT NULL THEN 'unix' ELSE null END,
    'environment', e.platform,
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
    'unenrollReason', e.unenroll_reason,
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
      conditions.push(`${onboardingStatusExpression} = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countResult = await pool.query(`SELECT count(*)::int AS total FROM stores s ${latestEnrollmentJoin} ${where}`, values);
    const total = countResult.rows[0]?.total as number ?? 0;
    const offset = (query.page - 1) * query.pageSize;
    const pageValues = [...values, query.pageSize, offset];
    const limitParameter = values.length + 1;
    const offsetParameter = values.length + 2;
    const result = await pool.query(`
      SELECT s.id, s.tenant_code AS "tenantCode", s.store_code AS "storeCode", s.display_name AS "displayName",
             s.origin_url AS "originUrl", s.hostname, s.tunnel_id AS "tunnelId", s.tunnel_name AS "tunnelName",
             s.tunnel_status AS "tunnelStatus", ${onboardingStatusExpression} AS "onboardingStatus",
             latest_enrollment.status AS "latestEnrollmentStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${commandAgentJson} AS "commandAgent"
        FROM stores s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
        ${latestEnrollmentJoin}
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
             s.tunnel_status AS "tunnelStatus", ${onboardingStatusExpression} AS "onboardingStatus",
             latest_enrollment.status AS "latestEnrollmentStatus",
             s.rdp_status AS "rdpStatus", s.rdp_target_ip::text AS "rdpTargetIp",
             s.rdp_url AS "rdpUrl", s.rdp_last_error AS "rdpLastError",
             s.last_connected_at AS "lastConnectedAt", s.last_verified_at AS "lastVerifiedAt", s.last_error AS "lastError",
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
             ${publicationsJson} AS publications,
             ${enrollmentsJson} AS enrollments,
             ${commandAgentJson} AS "commandAgent",
             ${commandExecutionsJson} AS "commandExecutions"
        FROM stores s
        JOIN cloudflare_accounts a ON a.id = s.account_id
        JOIN zones z ON z.id = s.zone_id
        ${latestEnrollmentJoin}
       WHERE s.id = $1
    `, [id]);
    if (!result.rowCount) return reply.code(404).send({ error: "Store not found" });
    return { store: result.rows[0] };
  });

  app.get("/api/stores/:storeId/routes/:routeId/waf", { preHandler: requireAuth }, async (request, reply) => {
    const { storeId, routeId } = z.object({ storeId: z.string().uuid(), routeId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT r.id, r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id,
              a.provider_mode AS "providerMode"
         FROM store_routes r
         JOIN store_publications p ON p.id = r.publication_id
         JOIN stores s ON s.id = p.store_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
        WHERE p.store_id = $1 AND r.id = $2`,
      [storeId, routeId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Ingress route not found" });
    const row = result.rows[0];
    try {
      const allowedIps = await resolveWafAllowedIps(row.waf_allowed_ips ?? [], row.providerMode);
      return { waf: { enabled: row.waf_enabled, allowedIps, rulesetId: row.waf_ruleset_id, ruleId: row.waf_rule_id, defaulted: !(row.waf_allowed_ips?.length) } };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Unable to resolve WAF source IP" });
    }
  });

  app.patch("/api/stores/:storeId/routes/:routeId/waf", { preHandler: requireAuth }, async (request, reply) => {
    const { storeId, routeId } = z.object({ storeId: z.string().uuid(), routeId: z.string().uuid() }).parse(request.params);
    const body = routeWafSchema.parse(request.body ?? {});
    const result = await pool.query(
      `SELECT r.id, r.path, r.waf_allowed_ips, r.waf_ruleset_id,
              p.hostname, z.cf_zone_id AS "cfZoneId",
              a.id AS "accountRowId", a.cf_account_id AS "cfAccountId", a.api_token_encrypted AS "apiTokenEncrypted",
              a.provider_mode AS "providerMode"
         FROM store_routes r
         JOIN store_publications p ON p.id = r.publication_id
         JOIN stores s ON s.id = p.store_id
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE p.store_id = $1 AND r.id = $2`,
      [storeId, routeId]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Ingress route not found" });
    const route = result.rows[0] as {
      path: string;
      hostname: string;
      cfZoneId: string | null;
      accountRowId: string;
      cfAccountId: string | null;
      apiTokenEncrypted: string | null;
      providerMode: "live" | "mock";
      waf_allowed_ips: string[] | null;
      waf_ruleset_id: string | null;
    };
    const invalidInput = body.allowedIps.find((value) => !isValidIpOrCidr(value));
    if (invalidInput) return reply.code(400).send({ error: `Invalid WAF allowed IP or CIDR: ${invalidInput}` });
    const allowedIps = body.enabled
      ? await resolveWafAllowedIps(body.allowedIps, route.providerMode)
      : [...new Set(body.allowedIps.length ? body.allowedIps : (route.waf_allowed_ips ?? []))];
    const invalid = allowedIps.find((value) => !isValidIpOrCidr(value));
    if (invalid) return reply.code(400).send({ error: `Invalid WAF allowed IP or CIDR: ${invalid}` });
    if (body.enabled && !allowedIps.length) return reply.code(400).send({ error: "At least one allowed IP or CIDR is required when WAF is enabled" });
    try {
      const client = new CloudflareClient(
        route.cfAccountId ?? route.accountRowId,
        route.apiTokenEncrypted ? decryptSecret(route.apiTokenEncrypted) : "mock",
        route.providerMode
      );
      const applied = await client.configureRouteWaf({
        zoneId: route.cfZoneId ?? "mock-zone",
        hostname: route.hostname,
        path: route.path,
        enabled: body.enabled,
        allowedIps,
        rulesetId: route.waf_ruleset_id
      });
      await pool.query(
        `UPDATE store_routes
            SET waf_enabled = $1, waf_allowed_ips = $2, waf_ruleset_id = $3, waf_rule_id = $4, updated_at = now()
          WHERE id = $5`,
        [body.enabled, allowedIps, applied.rulesetId, applied.ruleId, routeId]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: body.enabled ? "route.waf_enabled" : "route.waf_disabled",
        entityType: "store_route",
        entityId: routeId,
        details: { storeId, hostname: route.hostname, path: route.path, allowedIps, rulesetId: applied.rulesetId, ruleId: applied.ruleId }
      });
      return { success: true, waf: { enabled: body.enabled, allowedIps, rulesetId: applied.rulesetId, ruleId: applied.ruleId } };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "Unable to apply route WAF" });
    }
  });

  app.delete("/api/stores/:storeId/enrollments/:enrollmentId", { preHandler: requireAuth }, async (request, reply) => {
    const { storeId, enrollmentId } = z.object({
      storeId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const deleted = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT e.id, e.deleted_at,
                (SELECT count(*)::int FROM enrollment_logs l WHERE l.enrollment_id = e.id) AS log_count,
                e.deleted_at IS NULL
                AND e.unenrolled_at IS NULL
                AND e.status IN ('ready', 'installed')
                AND e.id = (
                  SELECT current_enrollment.id
                    FROM enrollments current_enrollment
                   WHERE current_enrollment.store_id = e.store_id
                     AND current_enrollment.deleted_at IS NULL
                     AND current_enrollment.unenrolled_at IS NULL
                     AND current_enrollment.status IN ('ready', 'installed')
                   ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
                   LIMIT 1
                ) AS is_current
           FROM enrollments e
          WHERE e.store_id = $1 AND e.id = $2
          FOR UPDATE`,
        [storeId, enrollmentId]
      );
      const enrollment = result.rows[0];
      if (!enrollment) return { kind: "missing" as const };
      if (enrollment.is_current) return { kind: "current" as const };
      const deletedAt = new Date().toISOString();
      await client.query("DELETE FROM enrollments WHERE store_id = $1 AND id = $2", [storeId, enrollmentId]);
      const activeEnrollment = await client.query(
        `SELECT 1
           FROM enrollments
          WHERE store_id = $1
            AND deleted_at IS NULL
            AND unenrolled_at IS NULL
            AND status IN ('ready', 'installed')
          ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC
          LIMIT 1`,
        [storeId]
      );
      await client.query(
        `UPDATE stores
            SET onboarding_status = CASE WHEN $2 THEN 'verified' ELSE 'revoked' END,
                last_error = null, updated_at = now()
          WHERE id = $1 AND onboarding_status = 'waiting_for_new_enrollment'`,
        [storeId, Boolean(activeEnrollment.rowCount)]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.deleted",
        entityType: "enrollment",
        entityId: enrollmentId,
        details: { storeId, hardDelete: true, logCount: enrollment.log_count }
      }, client);
      return { kind: "deleted" as const, deletedAt, logCount: enrollment.log_count as number };
    });
    if (deleted.kind === "missing") return reply.code(404).send({ error: "Enrollment not found" });
    if (deleted.kind === "current") return reply.code(409).send({ error: "The current connected enrollment cannot be deleted" });
    return { success: true, deletedAt: deleted.deletedAt, hardDeleted: true, logCount: deleted.logCount, alreadyDeleted: false };
  });

  app.post("/api/stores/:storeId/enrollments/:enrollmentId/unenroll", { preHandler: requireAuth }, async (request, reply) => {
    const { storeId, enrollmentId } = z.object({
      storeId: z.string().uuid(),
      enrollmentId: z.string().uuid()
    }).parse(request.params);
    const body = enrollmentSchema.parse(request.body ?? {});
    const rawToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
    const issued = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT e.id, e.created_at, e.status, e.unenrolled_at, e.deleted_at,
                e.status IN ('ready', 'installed')
                AND e.unenrolled_at IS NULL
                AND e.deleted_at IS NULL
                AND e.id = (
                  SELECT current_enrollment.id
                    FROM enrollments current_enrollment
                   WHERE current_enrollment.store_id = e.store_id
                     AND current_enrollment.deleted_at IS NULL
                     AND current_enrollment.unenrolled_at IS NULL
                     AND current_enrollment.status IN ('ready', 'installed')
                   ORDER BY COALESCE(current_enrollment.installed_at, current_enrollment.claimed_at, current_enrollment.created_at) DESC
                   LIMIT 1
                ) AS is_current
           FROM enrollments e
          WHERE e.store_id = $1 AND e.id = $2
          FOR UPDATE`,
        [storeId, enrollmentId]
      );
      const enrollment = result.rows[0];
      if (!enrollment) return { kind: "missing" as const };
      if (!enrollment.is_current) return { kind: "not_current" as const };
      await client.query(
        `UPDATE enrollments
            SET unenroll_token_hash = $1, unenroll_token_expires_at = $2,
                unenroll_requested_at = now(), unenrolled_at = null,
                unenroll_reason = null, unenroll_last_error = null, updated_at = now()
          WHERE id = $3`,
        [hashToken(rawToken), expiresAt, enrollmentId]
      );
      await client.query(
        `INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
         VALUES ($1, 'unenroll', 'windows', 'available'), ($1, 'unenroll', 'unix', 'available')
         ON CONFLICT (enrollment_id, script_kind, platform) DO UPDATE SET
           status = 'available', started_at = null, finished_at = null, last_error = null, updated_at = now()`,
        [enrollmentId]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "enrollment.unenroll_issued",
        entityType: "enrollment",
        entityId: enrollmentId,
        details: { storeId, expiresAt }
      }, client);
      return { kind: "issued" as const, createdAt: enrollment.created_at as string };
    });
    if (issued.kind === "missing") return reply.code(404).send({ error: "Enrollment not found" });
    if (issued.kind === "not_current") return reply.code(409).send({ error: "Only the current connected enrollment can be unenrolled" });
    return {
      enrollmentId,
      createdAt: issued.createdAt,
      expiresAt,
      urls: await unenrollmentUrls(rawToken)
    };
  });

  app.get("/api/stores/:id/delete-preflight", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = await loadStoreDeleteContext(pool, id);
    if (!context) return reply.code(404).send({ error: "Store not found" });
    return buildStoreDeletePreflight(context);
  });

  app.delete("/api/stores/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = deleteStoreSchema.parse(request.body ?? {});
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lockedStore = await client.query("SELECT id FROM stores WHERE id = $1 FOR UPDATE", [id]);
      if (!lockedStore.rowCount) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Store not found" });
      }
      const context = await loadStoreDeleteContext(client, id);
      if (!context) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "Store not found" });
      }
      const preflight = buildStoreDeletePreflight(context);
      const cloudflareCheck = preflight.checks.find((check) => check.id === "cloudflare");
      if (!cloudflareCheck?.ok) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Cloudflare cleanup is not ready", preflight });
      }
      if (!preflight.canDelete && (!body.force || body.confirmName !== context.displayName)) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "Store safety checks require an explicit name confirmation", preflight, requiresNameConfirmation: true });
      }
      await cleanupStoreResources(context);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "store.deleted",
        entityType: "store",
        entityId: id,
        details: {
          displayName: context.displayName,
          storeCode: context.storeCode,
          forced: !preflight.canDelete,
          tunnelId: context.tunnelId,
          publicationCount: context.publications.length
        }
      }, client);
      await client.query("DELETE FROM stores WHERE id = $1", [id]);
      await client.query("COMMIT");
      return reply.code(204).send();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const message = error instanceof Error ? error.message : "Store deletion failed";
      return reply.code(502).send({ error: `Store resources could not be fully deleted: ${message}` });
    } finally {
      client.release();
    }
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
          AND deleted_at IS NULL
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
             s.created_at AS "createdAt", a.id AS "accountId", a.cf_account_id AS "cfAccountId", a.name AS "accountName", z.id AS "zoneId", z.name AS "zoneName",
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
        `SELECT p.hostname, p.dns_record_id,
                r.path, r.waf_enabled, r.waf_allowed_ips, r.waf_ruleset_id, r.waf_rule_id
           FROM store_publications p
           LEFT JOIN store_routes r ON r.publication_id = p.id
          WHERE p.store_id = $1
          ORDER BY p.created_at, r.sort_order, r.created_at`,
        [id]
      );
      const existingByHostname = new Map<string, { dnsRecordId: string | null }>(
        existingResult.rows.filter((publication) => publication.dns_record_id || publication.path === null).map((publication) => [publication.hostname, { dnsRecordId: publication.dns_record_id }])
      );
      const existingWafByRoute = new Map<string, { enabled: boolean; allowedIps: string[]; rulesetId: string | null; ruleId: string | null }>(
        existingResult.rows.filter((route) => route.path !== null).map((route) => [`${route.hostname}${route.path}`, {
          enabled: route.waf_enabled,
          allowedIps: route.waf_allowed_ips ?? [],
          rulesetId: route.waf_ruleset_id,
          ruleId: route.waf_rule_id
        }])
      );
      const prepared = preparePublications(store.store_code, store.zone_name, body.publications);
      const desiredHostnames = new Set(prepared.map((publication) => publication.hostname));
      const desiredRouteKeys = new Set(prepared.flatMap((publication) => publication.routes.map((route) => `${publication.hostname}${route.path}`)));
      const removedDnsRecordIds = [...new Set<string>(existingResult.rows
        .filter((publication) => publication.dns_record_id && !desiredHostnames.has(publication.hostname))
        .map((publication) => publication.dns_record_id as string))];
      const removedWafRoutes = existingResult.rows
        .filter((route) => route.path !== null && route.waf_rule_id && !desiredRouteKeys.has(`${route.hostname}${route.path}`))
        .map((route) => ({
          hostname: route.hostname as string,
          path: route.path as string,
          rulesetId: route.waf_ruleset_id as string | null
        }));

      await client.query("DELETE FROM store_publications WHERE store_id = $1", [id]);
      for (const publication of prepared) {
        const existing = existingByHostname.get(publication.hostname);
        const inserted = await client.query(
          `INSERT INTO store_publications(store_id, suffix, hostname, dns_record_id, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, publication.suffix, publication.hostname, existing?.dnsRecordId ?? null, existing?.dnsRecordId ? "active" : "pending"]
        );
        for (const [index, route] of publication.routes.entries()) {
          const waf = existingWafByRoute.get(`${publication.hostname}${route.path}`);
          await client.query(
            `INSERT INTO store_routes(publication_id, path, service_url, route_kind, sort_order, waf_enabled, waf_allowed_ips, waf_ruleset_id, waf_rule_id)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), COALESCE($7, ARRAY[]::text[]), $8, $9)`,
            [inserted.rows[0].id, route.path, route.serviceUrl, route.kind, index, waf?.enabled ?? null, waf?.allowedIps ?? null, waf?.rulesetId ?? null, waf?.ruleId ?? null]
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
          removedHostnameCount: new Set(existingResult.rows.filter((publication) => !desiredHostnames.has(publication.hostname)).map((publication) => publication.hostname)).size,
          removedWafRouteCount: removedWafRoutes.length
        }
      }, client);
      return { tunnelId: store.tunnel_id as string | null, removedDnsRecordIds, removedWafRoutes };
    });
    if (!update) return reply.code(404).send({ error: "Store not found" });

    try {
      const applied = update.tunnelId ? await reconfigureStore(id, update.removedDnsRecordIds, update.removedWafRoutes) : false;
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
              AND deleted_at IS NULL
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
        "UPDATE stores SET onboarding_status = $1, last_error = null, updated_at = now() WHERE id = $2",
        [previous.length ? "waiting_for_new_enrollment" : "url_issued", id]
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
    const body = z.object({ publicationId: z.string().uuid().optional(), routeId: z.string().uuid().optional() }).parse(request.body ?? {});
    const result = await verifyStoreEndpoints(id, {
      actorUserId: request.authUser!.id,
      ...(body.publicationId ? { publicationId: body.publicationId } : {}),
      ...(body.routeId ? { routeId: body.routeId } : {})
    });
    if (!result) return reply.code(404).send({ error: body.routeId ? "Ingress route not found" : body.publicationId ? "Published endpoint not found" : "Store not found" });
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
