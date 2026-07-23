const healthy = new Set(["active", "healthy", "verified", "installed", "enabled", "ready", "completed", "success", "connected"]);
const warning = new Set(["url_issued", "claimed", "provisioning", "connector_online", "inactive", "pending", "running", "never_run", "staled", "unenroll_pending", "unenroll_failed", "unverified", "degraded"]);
const danger = new Set(["failed", "timed_out", "unenroll_failed", "down", "invalid", "expired", "revoked"]);

export function StatusBadge({ status }: { status: string }) {
  const tone = healthy.has(status) ? "success" : warning.has(status) ? "warning" : danger.has(status) ? "danger" : "neutral";
  const label = status === "staled_ignored" ? "staled - ignored" : status.replaceAll("_", " ");
  return <span className={`status status-${tone}`}><i />{label}</span>;
}
