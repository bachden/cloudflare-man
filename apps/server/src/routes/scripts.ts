import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/database.js";

const platformSchema = z.enum(["windows", "unix"]);
const languageSchema = z.enum(["powershell", "bash", "sh"]);
const scriptContent = z.string().min(1).max(262_144).refine((value) => value.trim().length > 0, "Script content is required");
const scriptMetadata = z.object({
  name: z.string().trim().min(1).max(120),
  platform: platformSchema,
  language: languageSchema,
  description: z.string().trim().max(500).default("")
});
const scriptCreateSchema = scriptMetadata.extend({ content: scriptContent });
const scriptUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  language: languageSchema.optional(),
  description: z.string().trim().max(500).optional()
});
const versionSchema = z.object({ content: scriptContent });
const executionHistorySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(50).default(10)
});

function validateLanguage(platform: "windows" | "unix", language: "powershell" | "bash" | "sh"): string | null {
  if (platform === "windows" && language !== "powershell") return "Windows scripts must use PowerShell";
  if (platform === "unix" && language === "powershell") return "Unix scripts must use Bash or sh";
  return null;
}

const scriptSummary = `jsonb_build_object(
  'id', s.id,
  'name', s.name,
  'platform', s.platform,
  'language', s.language,
  'description', s.description,
  'latestVersion', latest.version,
  'latestVersionId', latest.id,
  'executionStats', jsonb_build_object(
    'total', execution_stats.total,
    'succeeded', execution_stats.succeeded,
    'failed', execution_stats.failed,
    'timedOut', execution_stats."timedOut",
    'running', execution_stats.running
  ),
  'updatedAt', s.updated_at,
  'createdAt', s.created_at
)`;

export async function scriptRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/scripts", { preHandler: requireAuth }, async (request) => {
    const query = z.object({
      platform: platformSchema.optional(),
      name: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(5).max(100).default(100)
    }).parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT ${scriptSummary} AS script
         FROM managed_scripts s
         LEFT JOIN LATERAL (
           SELECT v.id, v.version
             FROM managed_script_versions v
            WHERE v.script_id = s.id
            ORDER BY v.version DESC
           LIMIT 1
         ) latest ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS total,
                  (count(*) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                  (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                  (count(*) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                  (count(*) FILTER (WHERE ce.status = 'running'))::int AS running
             FROM store_command_executions ce
             LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
             LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
            WHERE executed_version.script_id = s.id OR saved_version.script_id = s.id
         ) execution_stats ON true
        WHERE ($1::text IS NULL OR s.platform = $1)
          AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%')
        ORDER BY s.name, s.platform
        LIMIT $3 OFFSET $4`,
        [query.platform ?? null, query.name || null, query.pageSize, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS total
           FROM managed_scripts s
          WHERE ($1::text IS NULL OR s.platform = $1)
            AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%')`,
        [query.platform ?? null, query.name || null]
      )
    ]);
    const total = countResult.rows[0].total as number;
    return {
      scripts: result.rows.map((row) => row.script),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.get("/api/scripts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT s.id, s.name, s.platform, s.language, s.description,
              s.created_at AS "createdAt", s.updated_at AS "updatedAt",
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', v.id, 'version', v.version, 'content', v.content,
                'createdAt', v.created_at, 'createdBy', u.username
              ) ORDER BY v.version DESC) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS versions
         FROM managed_scripts s
         LEFT JOIN managed_script_versions v ON v.script_id = s.id
         LEFT JOIN users u ON u.id = v.created_by
        WHERE s.id = $1
        GROUP BY s.id`,
      [id]
    );
    if (!result.rowCount) return reply.code(404).send({ error: "Script not found" });
    return { script: result.rows[0] };
  });

  app.get("/api/scripts/:id/executions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = executionHistorySchema.parse(request.query);
    const offset = (query.page - 1) * query.pageSize;
    const script = await pool.query("SELECT 1 FROM managed_scripts WHERE id = $1", [id]);
    if (!script.rowCount) return reply.code(404).send({ error: "Script not found" });
    const joins = `
      FROM store_command_executions ce
      JOIN stores st ON st.id = ce.store_id
      LEFT JOIN enrollments e ON e.id = ce.enrollment_id
      LEFT JOIN users u ON u.id = ce.requested_by
      LEFT JOIN managed_script_versions executed_version ON executed_version.id = ce.script_version_id
      LEFT JOIN managed_script_versions saved_version ON saved_version.id = ce.saved_script_version_id
     WHERE (executed_version.script_id = $1 OR saved_version.script_id = $1)
       AND ($2::int IS NULL OR COALESCE(executed_version.version, saved_version.version) = $2)`;
    const [executionResult, statsResult] = await Promise.all([
      pool.query(
        `SELECT ce.id,
                ce.store_id AS "storeId", st.display_name AS "storeDisplayName",
                st.tenant_code AS "tenantCode", st.store_code AS "storeCode",
                ce.enrollment_id AS "enrollmentId",
                NULLIF(e.host_info->>'machineName', '') AS "computerName",
                NULLIF(e.host_info->>'osName', '') AS "osName",
                e.platform AS environment, e.platform AS "enrollmentPlatform",
                ce.script_type AS "scriptType",
                $1::uuid AS "scriptId",
                ce.script_version_id AS "scriptVersionId",
                ce.saved_script_id AS "savedScriptId",
                ce.saved_script_version_id AS "savedScriptVersionId",
                ce.saved_at AS "savedAt",
                COALESCE(executed_version.id, saved_version.id) AS "anchorScriptVersionId",
                COALESCE(executed_version.version, saved_version.version) AS "scriptVersion",
                COALESCE(ce.script_name, 'Inline script') AS "scriptName",
                ce.script_platform AS platform, ce.script_language AS language,
                ce.script, ce.timeout_ms AS "timeoutMs", ce.status,
                ce.started_at AS "startedAt", ce.finished_at AS "finishedAt",
                ce.elapsed_ms AS "elapsedMs", ce.exit_code AS "exitCode",
                ce.stdout, ce.stderr, ce.error, u.username AS "requestedBy"
         ${joins}
         ORDER BY ce.created_at DESC, ce.id DESC
         LIMIT $3 OFFSET $4`,
        [id, query.version ?? null, query.pageSize, offset]
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE ce.status = 'succeeded'))::int AS succeeded,
                (count(*) FILTER (WHERE ce.status = 'failed'))::int AS failed,
                (count(*) FILTER (WHERE ce.status = 'timed_out'))::int AS "timedOut",
                (count(*) FILTER (WHERE ce.status = 'running'))::int AS running
         ${joins}`,
        [id, query.version ?? null]
      )
    ]);
    const summary = statsResult.rows[0];
    const total = summary.total as number;
    return {
      scriptId: id,
      version: query.version ?? null,
      executions: executionResult.rows,
      summary,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize))
      }
    };
  });

  app.post("/api/scripts", { preHandler: requireAuth }, async (request, reply) => {
    const body = scriptCreateSchema.parse(request.body);
    const languageError = validateLanguage(body.platform, body.language);
    if (languageError) return reply.code(400).send({ error: languageError });
    const created = await withTransaction(async (client) => {
      const script = await client.query(
        `INSERT INTO managed_scripts(name, platform, language, description, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [body.name, body.platform, body.language, body.description, request.authUser!.id]
      );
      const version = await client.query(
        `INSERT INTO managed_script_versions(script_id, version, content, created_by)
         VALUES ($1, 1, $2, $3)
         RETURNING id, version`,
        [script.rows[0].id, body.content, request.authUser!.id]
      );
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "script.created",
        entityType: "script",
        entityId: script.rows[0].id,
        details: { platform: body.platform, language: body.language, version: 1 }
      }, client);
      return { id: script.rows[0].id as string, versionId: version.rows[0].id as string };
    });
    return reply.code(201).send({ id: created.id, versionId: created.versionId });
  });

  app.patch("/api/scripts/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = scriptUpdateSchema.parse(request.body);
    const current = await pool.query("SELECT platform, language FROM managed_scripts WHERE id = $1", [id]);
    if (!current.rowCount) return reply.code(404).send({ error: "Script not found" });
    const language = body.language ?? current.rows[0].language;
    const languageError = validateLanguage(current.rows[0].platform, language);
    if (languageError) return reply.code(400).send({ error: languageError });
    const result = await pool.query(
      `UPDATE managed_scripts
          SET name = COALESCE($1, name), language = COALESCE($2, language),
              description = COALESCE($3, description), updated_at = now()
        WHERE id = $4
        RETURNING id`,
      [body.name ?? null, body.language ?? null, body.description ?? null, id]
    );
    await writeAudit({ actorUserId: request.authUser!.id, action: "script.updated", entityType: "script", entityId: id, details: body });
    return { success: Boolean(result.rowCount) };
  });

  app.post("/api/scripts/:id/versions", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = versionSchema.parse(request.body);
    const version = await withTransaction(async (client) => {
      const script = await client.query("SELECT id FROM managed_scripts WHERE id = $1 FOR UPDATE", [id]);
      if (!script.rowCount) return null;
      const next = await client.query("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM managed_script_versions WHERE script_id = $1", [id]);
      const inserted = await client.query(
        `INSERT INTO managed_script_versions(script_id, version, content, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, version`,
        [id, next.rows[0].version, body.content, request.authUser!.id]
      );
      await client.query("UPDATE managed_scripts SET updated_at = now() WHERE id = $1", [id]);
      await writeAudit({ actorUserId: request.authUser!.id, action: "script.version_created", entityType: "script", entityId: id, details: { version: inserted.rows[0].version } }, client);
      return inserted.rows[0];
    });
    if (!version) return reply.code(404).send({ error: "Script not found" });
    return reply.code(201).send({ versionId: version.id, version: version.version });
  });
}
