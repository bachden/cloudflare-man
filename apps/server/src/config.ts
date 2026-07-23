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
  WEB_ORIGIN: z.string().url().default("http://127.0.0.1:5173"),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:5173"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("public"),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CLOUDFLARED_VERSION: z.string().min(1),
  ALLOW_MOCK_ACCOUNTS: booleanFromString.default(false)
});

export const config = schema.parse(process.env);
