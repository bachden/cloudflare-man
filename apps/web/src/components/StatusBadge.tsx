const healthy = new Set(["active", "healthy", "verified", "installed", "enabled", "ready"]);
const warning = new Set(["url_issued", "claimed", "provisioning", "connector_online", "inactive", "pending", "unverified", "degraded"]);
const danger = new Set(["failed", "down", "invalid", "expired", "revoked"]);

export function StatusBadge({ status }: { status: string }) {
  const tone = healthy.has(status) ? "success" : warning.has(status) ? "warning" : danger.has(status) ? "danger" : "neutral";
  return <span className={`status status-${tone}`}><i />{status.replaceAll("_", " ")}</span>;
}
