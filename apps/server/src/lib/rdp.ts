import { writeAudit } from "./audit.js";
import { CloudflareClient } from "./cloudflare.js";
import { pool } from "./database.js";
import { checkBrowserRdpGateway } from "./monitor.js";
import { decryptSecret } from "./security.js";
import { slugifyLabel } from "./stores.js";

export type RdpProvisioningResult = {
  ready: boolean;
  url?: string;
  error?: string;
};

export async function provisionBrowserRdp(storeId: string): Promise<RdpProvisioningResult> {
  const db = await pool.connect();
  let lockKey = `cloudflare-man:rdp:${storeId}`;
  let storeExists = false;
  try {
    const identity = await db.query("SELECT account_id FROM stores WHERE id = $1", [storeId]);
    if (!identity.rowCount) throw new Error("Store not found");
    storeExists = true;
    lockKey = `cloudflare-man:rdp-account:${identity.rows[0].account_id}`;
    await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    const result = await db.query(
      `SELECT s.id, s.tenant_code, s.store_code, s.tunnel_id, s.rdp_target_ip, s.rdp_port,
              s.rdp_vnet_id, s.rdp_route_id, s.rdp_target_id,
              a.id AS account_row_id, a.provider_mode, a.cf_account_id, a.api_token_encrypted,
              a.rdp_allowed_emails, a.rdp_access_policy_id,
              z.id AS zone_row_id, z.name AS zone_name, z.cf_zone_id,
              z.rdp_hostname, z.rdp_dns_record_id, z.rdp_access_app_id
         FROM stores s
         JOIN cloudflare_accounts a ON a.id = s.account_id
         JOIN zones z ON z.id = s.zone_id
        WHERE s.id = $1`,
      [storeId]
    );
    const store = result.rows[0];
    if (!store) throw new Error("Store not found");
    if (!store.tunnel_id || !store.rdp_target_ip) throw new Error("Tunnel and RDP target IP are required");
    if (store.provider_mode === "live" && (!store.cf_account_id || !store.api_token_encrypted || !store.cf_zone_id)) {
      throw new Error("Cloudflare account or zone is not fully configured for RDP");
    }
    const allowedEmails = (store.rdp_allowed_emails ?? []) as string[];
    if (store.provider_mode === "live" && allowedEmails.length === 0) {
      throw new Error("Configure at least one RDP operator email on the Cloudflare account");
    }

    await db.query(
      "UPDATE stores SET rdp_status = 'provisioning', rdp_last_error = null, updated_at = now() WHERE id = $1",
      [storeId]
    );

    const client = new CloudflareClient(
      store.cf_account_id ?? store.account_row_id,
      store.api_token_encrypted ? decryptSecret(store.api_token_encrypted) : "mock",
      store.provider_mode
    );
    const label = slugifyLabel(`${store.tenant_code}-${store.store_code}`);
    const vnet = store.rdp_vnet_id
      ? { id: store.rdp_vnet_id as string, name: `dcorp-${label}` }
      : await client.ensureVirtualNetwork(`dcorp-${label}`);
    await db.query("UPDATE stores SET rdp_vnet_id = $1, updated_at = now() WHERE id = $2", [vnet.id, storeId]);

    const route = store.rdp_route_id
      ? { id: store.rdp_route_id as string }
      : await client.ensureTunnelRoute(store.tunnel_id, vnet.id, String(store.rdp_target_ip));
    await db.query("UPDATE stores SET rdp_route_id = $1, updated_at = now() WHERE id = $2", [route.id, storeId]);

    const targetHostname = store.rdp_target_hostname ?? `store-${label}`;
    const target = store.rdp_target_id
      ? { id: store.rdp_target_id as string }
      : await client.ensureInfrastructureTarget(targetHostname, String(store.rdp_target_ip), vnet.id);
    await db.query(
      "UPDATE stores SET rdp_target_id = $1, rdp_target_hostname = $2, updated_at = now() WHERE id = $3",
      [target.id, targetHostname, storeId]
    );

    const rdpHostname = store.rdp_hostname ?? `rdp.${store.zone_name}`;
    const dnsRecord = await client.ensureBrowserRdpDnsRecord(store.cf_zone_id ?? "mock-zone", rdpHostname);
    await db.query(
      "UPDATE zones SET rdp_hostname = $1, rdp_dns_record_id = $2, updated_at = now() WHERE id = $3",
      [rdpHostname, dnsRecord.id, store.zone_row_id]
    );

    const policy = await client.ensureRdpAccessPolicy(store.rdp_access_policy_id, allowedEmails);
    await db.query(
      "UPDATE cloudflare_accounts SET rdp_access_policy_id = $1, updated_at = now() WHERE id = $2",
      [policy.id, store.account_row_id]
    );

    const hostnames = await db.query(
      `SELECT DISTINCT rdp_target_hostname
         FROM stores
        WHERE zone_id = $1 AND rdp_target_id IS NOT NULL AND rdp_target_hostname IS NOT NULL
        ORDER BY rdp_target_hostname`,
      [store.zone_row_id]
    );
    const application = await client.ensureBrowserRdpApplication({
      existingId: store.rdp_access_app_id,
      name: `cloudflare-man RDP ${store.zone_name}`,
      domain: rdpHostname,
      policyId: policy.id,
      targetHostnames: hostnames.rows.map((row) => row.rdp_target_hostname)
    });
    await db.query(
      "UPDATE zones SET rdp_access_app_id = $1, updated_at = now() WHERE id = $2",
      [application.id, store.zone_row_id]
    );

    const rdpUrl = `https://${rdpHostname}/rdp/${encodeURIComponent(vnet.id)}/${encodeURIComponent(String(store.rdp_target_ip))}/${store.rdp_port}`;
    if (store.provider_mode === "live") {
      const gateway = await checkBrowserRdpGateway(rdpUrl);
      if (!gateway.reachable) throw new Error(gateway.error ?? "Browser RDP gateway is not ready");
    }
    await db.query(
      `UPDATE stores SET rdp_status = 'ready', rdp_url = $1, rdp_last_error = null,
              updated_at = now() WHERE id = $2`,
      [rdpUrl, storeId]
    );
    await writeAudit({
      action: "store.rdp_provisioned",
      entityType: "store",
      entityId: storeId,
      details: { rdpHostname, targetHostname, targetIp: String(store.rdp_target_ip), vnetId: vnet.id }
    }, db);
    return { ready: true, url: rdpUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : "RDP provisioning failed";
    if (storeExists) {
      await db.query(
        "UPDATE stores SET rdp_status = 'failed', rdp_last_error = $1, updated_at = now() WHERE id = $2",
        [message, storeId]
      );
      await writeAudit({
        action: "store.rdp_failed",
        entityType: "store",
        entityId: storeId,
        details: { error: message }
      }, db);
    }
    return { ready: false, error: message };
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    db.release();
  }
}
