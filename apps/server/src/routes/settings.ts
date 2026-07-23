import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { getPublicBaseUrlSetting, normalizePublicBaseUrl, setPublicBaseUrl } from "../lib/app-settings.js";
import { requireAuth } from "../lib/auth.js";
import { withTransaction } from "../lib/database.js";

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

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: requireAuth }, async () => ({ settings: await getPublicBaseUrlSetting() }));

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
    return { settings: { publicBaseUrl, configured: true } };
  });
}
