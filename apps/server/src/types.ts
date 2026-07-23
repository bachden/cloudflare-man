import type { PoolClient } from "pg";

export type AuthUser = {
  id: string;
  username: string;
  mustChangePassword: boolean;
  sessionId: string | null;
};

export type DatabaseClient = PoolClient;

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
