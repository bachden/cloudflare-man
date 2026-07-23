import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { getPublicBaseUrlSetting, normalizePublicBaseUrl, setPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth, requireSessionAuth } from "../lib/auth.js";
import { withTransaction } from "../lib/database.js";
import { getMcpAccessSetting, rotateMcpToken, setMcpEnabled } from "../lib/mcp-access.js";

const settingsSchema = z.object({
  publicBaseUrl: z.string().trim().min(1).max(500).transform((value, context) => {
    try {
      return normalizePublicBaseUrl(value);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid public base URL" });
      return z.NEVER;
    }
  })
});

const mcpSettingsSchema = z.object({ enabled: z.boolean() });

async function settingsResponse() {
  const [publicSetting, mcpAccess] = await Promise.all([getPublicBaseUrlSetting(), getMcpAccessSetting()]);
  return {
    ...publicSetting,
    mcp: {
      ...mcpAccess,
      endpoint: `${publicSetting.publicBaseUrl}/mcp`
    }
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireAuth }, async () => ({ settings: await settingsResponse() }));

  app.put("/api/settings", { preHandler: requireAuth }, async (request) => {
    const body = settingsSchema.parse(request.body);
    const publicBaseUrl = await withTransaction(async (client) => {
      const value = await setPublicBaseUrl(body.publicBaseUrl, request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.public_base_url_updated",
        entityType: "settings",
        entityId: "public_base_url",
        details: { publicBaseUrl: value },
        ipAddress: request.ip
      }, client);
      return value;
    });
    const mcpAccess = await getMcpAccessSetting();
    return { settings: { publicBaseUrl, configured: true, mcp: { ...mcpAccess, endpoint: `${publicBaseUrl}/mcp` } } };
  });

  app.patch("/api/settings/mcp", { preHandler: requireSessionAuth }, async (request) => {
    const body = mcpSettingsSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const updated = await setMcpEnabled(body.enabled, request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: body.enabled ? "settings.mcp_enabled" : "settings.mcp_disabled",
        entityType: "settings",
        entityId: "mcp_access",
        details: { enabled: body.enabled },
        ipAddress: request.ip
      }, client);
      return updated;
    });
    const publicSetting = await getPublicBaseUrlSetting();
    return {
      settings: { ...result.setting, endpoint: `${publicSetting.publicBaseUrl}/mcp` },
      ...(result.token ? { token: result.token } : {})
    };
  });

  app.post("/api/settings/mcp/rotate", { preHandler: requireSessionAuth }, async (request) => {
    const result = await withTransaction(async (client) => {
      const updated = await rotateMcpToken(request.authUser!.id, client);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "settings.mcp_token_rotated",
        entityType: "settings",
        entityId: "mcp_access",
        details: { tokenHint: updated.setting.tokenHint },
        ipAddress: request.ip
      }, client);
      return updated;
    });
    const publicSetting = await getPublicBaseUrlSetting();
    return {
      settings: { ...result.setting, endpoint: `${publicSetting.publicBaseUrl}/mcp` },
      token: result.token
    };
  });
}
