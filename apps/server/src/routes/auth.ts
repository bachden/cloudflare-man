import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { createSession, requireAuth, SESSION_COOKIE, sessionCookieOptions } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/database.js";
import { hashToken } from "../lib/security.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200)
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await pool.query(
      "SELECT id, username, password_hash, must_change_password FROM users WHERE username = $1",
      [body.username]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
      await writeAudit({ action: "auth.login_failed", entityType: "user", entityId: body.username, ipAddress: request.ip });
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    await createSession(user.id, request, reply);
    await writeAudit({ actorUserId: user.id, action: "auth.login", entityType: "user", entityId: user.id, ipAddress: request.ip });
    return { user: { id: user.id, username: user.username, mustChangePassword: user.must_change_password } };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request) => ({
    user: {
      id: request.authUser!.id,
      username: request.authUser!.username,
      mustChangePassword: request.authUser!.mustChangePassword
    }
  }));

  app.post("/api/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return reply.code(204).send();
  });

  app.post("/api/auth/change-password", { preHandler: requireAuth }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [request.authUser!.id]);
    if (!(await bcrypt.compare(body.currentPassword, result.rows[0].password_hash))) {
      return reply.code(400).send({ error: "Current password is incorrect" });
    }
    if (body.currentPassword === body.newPassword) {
      return reply.code(400).send({ error: "New password must be different" });
    }
    const passwordHash = await bcrypt.hash(body.newPassword, 12);
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2",
        [passwordHash, request.authUser!.id]
      );
      await client.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [request.authUser!.id, request.authUser!.sessionId]);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "auth.password_changed",
        entityType: "user",
        entityId: request.authUser!.id,
        ipAddress: request.ip
      }, client);
    });
    return { success: true };
  });
}

