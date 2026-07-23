const healthy = new Set(["active", "healthy", "verified", "installed", "enabled", "ready"]);
const warning = new Set(["url_issued", "claimed", "provisioning", "connector_online", "inactive", "pending", "unenroll_pending", "unenroll_failed", "unverified", "degraded"]);
const danger = new Set(["failed", "unenroll_failed", "down", "invalid", "expired", "revoked"]);

export function StatusBadge({ status }: { status: string }) {
  const tone = healthy.has(status) ? "success" : warning.has(status) ? "warning" : danger.has(status) ? "danger" : "neutral";
  return <span className={`status status-${tone}`}><i />{status.replaceAll("_", " ")}</span>;
}
