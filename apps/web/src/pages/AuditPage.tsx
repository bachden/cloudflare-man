import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../api";
import { PageHeader } from "../components/PageHeader";

type AuditEntry = {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
  username: string | null;
};

export function AuditPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["audit"], queryFn: () => api.get<{ entries: AuditEntry[] }>("/api/audit") });
  const entries = useMemo(() => data?.entries.filter((entry) => `${entry.action} ${entry.entityType} ${entry.entityId ?? ""}`.toLowerCase().includes(search.toLowerCase())) ?? [], [data, search]);
  return <div className="page"><PageHeader title="Audit log" eyebrow="Security and changes" /><div className="toolbar"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter events" /></label><span className="result-count">{entries.length} events</span></div><section className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>Event</th><th>Entity</th><th>Actor</th><th>IP address</th><th>Time</th></tr></thead><tbody>{isLoading ? <tr><td colSpan={5}><div className="quiet-empty">Loading events...</div></td></tr> : entries.length === 0 ? <tr><td colSpan={5}><div className="quiet-empty">No audit events</div></td></tr> : entries.map((entry) => <tr key={entry.id}><td><span className="event-name">{entry.action.replaceAll(".", " ")}</span></td><td><div className="primary-cell"><strong>{entry.entityType}</strong><span className="mono">{entry.entityId ?? "-"}</span></div></td><td>{entry.username ?? "system"}</td><td className="mono subdued">{entry.ipAddress ?? "-"}</td><td>{new Date(entry.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section></div>;
}

