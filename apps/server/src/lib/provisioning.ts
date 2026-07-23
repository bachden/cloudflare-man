import { writeAudit } from "./audit.js";
import { CloudflareClient, type CloudflareIngressRule } from "./cloudflare.js";
import { pool } from "./database.js";
import { decryptSecret } from "./security.js";
import { slugifyLabel } from "./stores.js";
import { COMMAND_AGENT_SERVICE_URL } from "./command-agent.js";

type PublicationRoute = { path: string; serviceUrl: string; routeKind: "service" | "command_agent"; sortOrder: number };
type Publication = { id: string; hostname: string; dnsRecordId: string | null; routes: PublicationRoute[] };
type StoreConnectivity = {
  id: string;
  tenant_code: string;
  store_code: string;
  tunnel_id: string | null;
  account_row_id: string;
  provider_mode: "live" | "mock";
  cf_account_id: string | null;
  api_token_encrypted: string | null;
  cf_zone_id: string | null;
};

type ProvisioningResult = {
  tunnelToken: string;
  tunnelId: string;
  hostname: string;
  providerMode: "live" | "mock";
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pathPrefixPattern(path: string): string | undefined {
  if (path === "/") return undefined;
  return `^${escapeRegex(path)}(?:/.*)?$`;
}

function ingressRules(publications: Publication[]): CloudflareIngressRule[] {
  return publications.flatMap((publication) => publication.routes
    .slice()
    .sort((left, right) => {
      if (left.path === "/") return 1;
      if (right.path === "/") return -1;
      return left.sortOrder - right.sortOrder;
    })
    .map((route) => {
      const path = pathPrefixPattern(route.path);
      return {
        hostname: publication.hostname,
        service: route.serviceUrl,
        ...(path ? { path } : {})
      };
    }));
}

async function loadPublications(storeId: string): Promise<Publication[]> {
  const publicationRows = await pool.query(
    `SELECT p.id, p.hostname, p.dns_record_id, r.path, r.service_url, r.sort_order,
              r.route_kind
       FROM store_publications p
       JOIN store_routes r ON r.publication_id = p.id
      WHERE p.store_id = $1
      ORDER BY p.created_at, r.sort_order, r.created_at`,
    [storeId]
  );
  const byPublication = new Map<string, Publication>();
  for (const row of publicationRows.rows) {
    const publication: Publication = byPublication.get(row.id) ?? {
      id: row.id,
      hostname: row.hostname,
      dnsRecordId: row.dns_record_id,
      routes: []
    };
    publication.routes.push({
      path: row.path,
      serviceUrl: row.route_kind === "command_agent" ? COMMAND_AGENT_SERVICE_URL : row.service_url,
      routeKind: row.route_kind,
      sortOrder: row.sort_order
    });
    byPublication.set(row.id, publication);
  }
  return [...byPublication.values()];
}

function cloudflareClient(store: StoreConnectivity): CloudflareClient {
  return new CloudflareClient(
    store.cf_account_id ?? store.account_row_id,
    store.api_token_encrypted ? decryptSecret(store.api_token_encrypted) : "mock",
    store.provider_mode
  );
}

async function applyConnectivity(
  storeId: string,
  store: StoreConnectivity,
  client: CloudflareClient,
  tunnelId: string,
  publications: Publication[]
): Promise<void> {
  const primary = publications[0];
  if (!primary) throw new Error("Store has no published endpoints");
  const primaryRoute = primary.routes.find((route) => route.path === "/") ?? primary.routes[0];
  if (!primaryRoute) throw new Error(`Published endpoint ${primary.hostname} has no routes`);
  await client.configureTunnel(tunnelId, ingressRules(publications));
  for (const publication of publications) {
    if (!publication.dnsRecordId) {
      const record = await client.createDnsRecord(store.cf_zone_id ?? "mock-zone", publication.hostname, tunnelId);
      publication.dnsRecordId = record.id;
    }
    await pool.query(
      `UPDATE store_publications
          SET dns_record_id = $1, status = 'active', last_error = null, updated_at = now()
        WHERE id = $2`,
      [publication.dnsRecordId, publication.id]
    );
  }
  await pool.query(
    "UPDATE stores SET dns_record_id = $1, hostname = $2, origin_url = $3, last_error = null, updated_at = now() WHERE id = $4",
    [primary.dnsRecordId, primary.hostname, primaryRoute.serviceUrl, storeId]
  );
}

export async function reconfigureStore(storeId: string, removedDnsRecordIds: string[] = []): Promise<boolean> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.tunnel_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as StoreConnectivity | undefined;
  if (!store) throw new Error("Store not found");
  if (!store.tunnel_id) return false;
  if (store.provider_mode === "live" && (!store.cf_zone_id || !store.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }
  const publications = await loadPublications(storeId);
  if (publications.length === 0) throw new Error("Store has no published endpoints");
  const client = cloudflareClient(store);
  try {
    await applyConnectivity(storeId, store, client, store.tunnel_id, publications);
    for (const recordId of removedDnsRecordIds) {
      await client.deleteDnsRecord(store.cf_zone_id ?? "mock-zone", recordId);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connectivity update failed";
    await pool.query(
      "UPDATE store_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE store_id = $2",
      [message, storeId]
    );
    await pool.query("UPDATE stores SET last_error = $1, updated_at = now() WHERE id = $2", [message, storeId]);
    throw error;
  }
}

export async function provisionStore(storeId: string): Promise<ProvisioningResult> {
  const result = await pool.query(
    `SELECT s.id, s.tenant_code, s.store_code, s.origin_url, s.hostname, s.tunnel_id, s.dns_record_id,
            a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
            z.cf_zone_id
       FROM stores s
       JOIN cloudflare_accounts a ON a.id = s.account_id
       JOIN zones z ON z.id = s.zone_id
      WHERE s.id = $1`,
    [storeId]
  );
  const store = result.rows[0] as StoreConnectivity | undefined;
  if (!store) throw new Error("Store not found");
  if (store.provider_mode === "live" && (!store.cf_zone_id || !store.api_token_encrypted)) {
    throw new Error("Cloudflare account or zone is not fully configured");
  }

  const client = cloudflareClient(store);
  const publications = await loadPublications(storeId);
  if (publications.length === 0) throw new Error("Store has no published endpoints");

  await pool.query(
    "UPDATE stores SET onboarding_status = 'provisioning', last_error = null, updated_at = now() WHERE id = $1",
    [storeId]
  );

  try {
    let tunnelId = store.tunnel_id as string | null;
    let tunnelToken: string;
    if (!tunnelId) {
      const tunnelName = `dcorp-${slugifyLabel(`${store.tenant_code}-${store.store_code}`)}`;
      const tunnel = await client.createTunnel(tunnelName);
      tunnelId = tunnel.id;
      tunnelToken = tunnel.token ?? await client.getTunnelToken(tunnel.id);
      await pool.query(
        `UPDATE stores SET tunnel_id = $1, tunnel_name = $2, tunnel_status = 'inactive', updated_at = now()
         WHERE id = $3`,
        [tunnel.id, tunnelName, storeId]
      );
    } else {
      tunnelToken = await client.getTunnelToken(tunnelId);
    }

    await applyConnectivity(storeId, store, client, tunnelId, publications);

    await pool.query(
      `UPDATE stores SET onboarding_status = 'claimed', last_error = null, updated_at = now() WHERE id = $1`,
      [storeId]
    );
    await writeAudit({
      action: "store.provisioned",
      entityType: "store",
      entityId: storeId,
      details: {
        tunnelId,
        hostnames: publications.map((publication) => publication.hostname),
        routeCount: publications.reduce((total, publication) => total + publication.routes.length, 0),
        providerMode: store.provider_mode
      }
    });
    return { tunnelToken, tunnelId, hostname: publications[0]!.hostname, providerMode: store.provider_mode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Store provisioning failed";
    await pool.query(
      "UPDATE store_publications SET status = 'failed', last_error = $1, updated_at = now() WHERE store_id = $2",
      [message, storeId]
    );
    await pool.query(
      "UPDATE stores SET onboarding_status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
      [message, storeId]
    );
    throw error;
  }
}
