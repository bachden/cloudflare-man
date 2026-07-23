import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { pool } from "./database.js";
import { createOpaqueToken, hashToken } from "./security.js";
import { authenticateMcpToken } from "./mcp-access.js";

export const SESSION_COOKIE = "cfman_session";

export function sessionCookieOptions(expiresAt?: Date) {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.NODE_ENV === "production",
    ...(expiresAt ? { expires: expiresAt } : {})
  };
}

export async function createSession(
  userId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO sessions(user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, request.ip, request.headers["user-agent"] ?? null]
  );
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function requireSessionAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: "Authentication required" });
    return;
  }
  const result = await pool.query(
    `SELECT u.id, u.username, u.must_change_password, s.id AS session_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) {
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    await reply.code(401).send({ error: "Session expired" });
    return;
  }
  request.authUser = {
    id: row.id,
    username: row.username,
    mustChangePassword: row.must_change_password,
    sessionId: row.session_id
  };
  void pool.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);
}

export async function requireMcpAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) {
    await reply.code(401).send({ error: "MCP bearer token required" });
    return;
  }
  const user = await authenticateMcpToken(token);
  if (!user) {
    await reply.code(401).send({ error: "MCP is disabled or the bearer token is invalid" });
    return;
  }
  request.authUser = { ...user, sessionId: null };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.headers.authorization?.startsWith("Bearer ")) {
    return requireMcpAuth(request, reply);
  }
  return requireSessionAuth(request, reply);
}
