import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

const encryptionKey = Buffer.from(config.ENCRYPTION_KEY, "hex");

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted secret");
  const [ivValue, tagValue, ciphertextValue] = parts;
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

