import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const booleanFromString = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("public"),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CLOUDFLARED_VERSION: z.string().min(1),
  CFMAN_WAF_ALLOWED_IPS: z.string().default(""),
  ALLOW_MOCK_ACCOUNTS: booleanFromString.default(false)
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL ?? `http://${parsed.SERVER_HOST}:${parsed.SERVER_PORT}`
};
