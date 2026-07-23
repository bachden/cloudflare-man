import { writeAudit } from "./audit.js";
import { pool } from "./database.js";
import { checkStoreEndpoint, type EndpointCheck } from "./monitor.js";

export type StoreEndpointVerification = {
  publicationId: string | null;
  hostname: string;
  check: EndpointCheck;
};

export type StoreVerificationResult = {
  success: boolean;
  check: EndpointCheck;
  checks: StoreEndpointVerification[];
};

type VerificationOptions = {
  actorUserId?: string;
  attempts?: number;
  retryDelayMs?: number;
};

export async function verifyStoreEndpoints(
  storeId: string,
  options: VerificationOptions = {}
): Promise<StoreVerificationResult | null> {
  const store = await pool.query("SELECT id, hostname FROM stores WHERE id = $1", [storeId]);
  if (!store.rowCount) return null;

  const publications = await pool.query(
    "SELECT id, hostname FROM store_publications WHERE store_id = $1 ORDER BY created_at",
    [storeId]
  );
  const targets = publications.rowCount ? publications.rows : [{ id: null, hostname: store.rows[0].hostname }];
  const checks = await Promise.all(targets.map(async (target) => ({
    publicationId: target.id as string | null,
    hostname: target.hostname as string,
    check: await checkStoreEndpoint(target.hostname, {
      attempts: options.attempts,
      retryDelayMs: options.retryDelayMs
    })
  })));

  await Promise.all(checks.filter((item) => item.publicationId).map((item) => pool.query(
    "UPDATE store_publications SET status = $1, last_error = $2, updated_at = now() WHERE id = $3",
    [item.check.reachable ? "active" : "failed", item.check.error ?? null, item.publicationId]
  )));
  const success = checks.every((item) => item.check.reachable);
  if (success) {
    await pool.query(
      `UPDATE stores SET last_verified_at = now(), last_error = null,
              tunnel_status = 'healthy',
              onboarding_status = CASE WHEN onboarding_status IN ('connector_online', 'verified') THEN 'verified' ELSE onboarding_status END,
              updated_at = now() WHERE id = $1`,
      [storeId]
    );
  } else {
    const failed = checks.filter((item) => !item.check.reachable);
    await pool.query(
      "UPDATE stores SET last_error = $1, tunnel_status = 'down', updated_at = now() WHERE id = $2",
      [`${failed.length} published endpoint${failed.length === 1 ? " is" : "s are"} unreachable`, storeId]
    );
  }
  await writeAudit({
    ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
    action: success ? "store.verified" : "store.verification_failed",
    entityType: "store",
    entityId: storeId,
    details: { checks }
  });
  return { success, check: checks[0]!.check, checks };
}

export function scheduleStoreVerification(storeId: string): void {
  const timer = setTimeout(() => {
    void verifyStoreEndpoints(storeId, { attempts: 4, retryDelayMs: 5_000 }).catch(() => undefined);
  }, 15_000);
  timer.unref();
}
