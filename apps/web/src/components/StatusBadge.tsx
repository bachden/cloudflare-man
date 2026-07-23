const healthy = new Set(["active", "healthy", "verified", "installed", "enabled", "ready", "completed", "success", "succeeded", "connected", "waiting_for_new_enrollment"]);
const warning = new Set(["url_issued", "claimed", "provisioning", "connector_online", "inactive", "pending", "running", "timed_out", "never_run", "staled", "unenroll_pending", "unenroll_failed", "unverified", "degraded"]);
const danger = new Set(["failed", "unenroll_failed", "down", "invalid", "expired", "revoked"]);

export function StatusBadge({ status, label: customLabel }: { status: string; label?: string }) {
  const tone = healthy.has(status) ? "success" : warning.has(status) ? "warning" : danger.has(status) ? "danger" : "neutral";
  const label = customLabel ?? (status === "staled_ignored" ? "staled - ignored" : status === "waiting_for_new_enrollment" ? "waiting for new enrollment" : status.replaceAll("_", " "));
  return <span className={`status status-${tone}`}><i />{label}</span>;
}
