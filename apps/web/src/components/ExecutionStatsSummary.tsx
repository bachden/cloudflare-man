import { CheckCircle2, CircleX, TimerOff } from "lucide-react";
import type { ExecutionStats } from "../types";

export function ExecutionStatsSummary({ stats, compact = false }: { stats: ExecutionStats; compact?: boolean }) {
  return (
    <span className={`execution-stats ${compact ? "execution-stats-compact" : ""}`} aria-label={`${stats.succeeded} succeeded, ${stats.failed} errors, ${stats.timedOut} timeouts`}>
      <span className={`execution-stat execution-stat-succeeded ${stats.succeeded === 0 ? "execution-stat-zero" : ""}`} title="Succeeded"><CheckCircle2 size={12} /><strong>{stats.succeeded}</strong>{!compact && <small>Succeeded</small>}</span>
      <span className={`execution-stat execution-stat-failed ${stats.failed === 0 ? "execution-stat-zero" : ""}`} title="Error"><CircleX size={12} /><strong>{stats.failed}</strong>{!compact && <small>Error</small>}</span>
      <span className={`execution-stat execution-stat-timeout ${stats.timedOut === 0 ? "execution-stat-zero" : ""}`} title="Timeout"><TimerOff size={12} /><strong>{stats.timedOut}</strong>{!compact && <small>Timeout</small>}</span>
    </span>
  );
}
