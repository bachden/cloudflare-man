import { isIP } from "node:net";
import { config } from "../config.js";

const configuredWafIps = config.CFMAN_WAF_ALLOWED_IPS.split(",").map((value) => value.trim()).filter(Boolean);

export function isValidIpOrCidr(value: string): boolean {
  const [address, prefix] = value.split("/");
  const version = isIP(address ?? "");
  if (!version) return false;
  if (prefix === undefined) return true;
  const numericPrefix = Number(prefix);
  return Number.isInteger(numericPrefix) && numericPrefix >= 0 && numericPrefix <= (version === 4 ? 32 : 128);
}

async function defaultWafAllowedIps(providerMode: "live" | "mock"): Promise<string[]> {
  if (configuredWafIps.length) return configuredWafIps;
  if (providerMode === "mock") return ["127.0.0.1/32"];
  const response = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Unable to detect Cloudflare Man public IP; set CFMAN_WAF_ALLOWED_IPS and retry");
  const payload = await response.json() as { ip?: string };
  if (!payload.ip || !isIP(payload.ip)) throw new Error("Public IP detection returned an invalid address; set CFMAN_WAF_ALLOWED_IPS and retry");
  return [`${payload.ip}/${payload.ip.includes(":") ? 128 : 32}`];
}

export async function resolveWafAllowedIps(values: string[], providerMode: "live" | "mock"): Promise<string[]> {
  const allowedIps = values.length ? values : await defaultWafAllowedIps(providerMode);
  const invalid = allowedIps.find((value) => !isValidIpOrCidr(value));
  if (invalid) throw new Error(`Invalid WAF allowed IP or CIDR: ${invalid}`);
  return [...new Set(allowedIps)];
}
