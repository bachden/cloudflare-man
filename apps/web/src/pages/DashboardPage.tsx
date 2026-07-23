import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, CloudCog, Plus, Radio, Store } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { CapacityBar } from "../components/CapacityBar";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";

type DashboardData = {
  stats: {
    totalStores: number;
    healthyStores: number;
    onboardingStores: number;
    attentionStores: number;
    activeAccounts: number;
    activeZones: number;
  };
  accountCapacity: Array<{ id: string; name: string; softLimit: number; storeCount: number; zoneCount: number; status: string }>;
  recentStores: Array<{ id: string; displayName: string; storeCode: string; hostname: string; onboardingStatus: string; tunnelStatus: string; createdAt: string }>;
  recentActivity: Array<{ id: number; action: string; entityType: string; entityId: string; createdAt: string }>;
};

export function DashboardPage() {
  const { data, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => api.get<DashboardData>("/api/dashboard"), refetchInterval: 30_000 });
  if (isLoading || !data) return <PageLoading />;
  const stats = [
    { label: "Total stores", value: data.stats.totalStores, icon: Store, tone: "neutral" },
    { label: "Healthy", value: data.stats.healthyStores, icon: CheckCircle2, tone: "success" },
    { label: "Onboarding", value: data.stats.onboardingStores, icon: Radio, tone: "warning" },
    { label: "Needs attention", value: data.stats.attentionStores, icon: AlertTriangle, tone: "danger" }
  ];
  return (
    <div className="page">
      <PageHeader title="Operations overview" eyebrow="Fleet status" actions={<Link className="button button-primary" to="/onboarding"><Plus size={16} />Onboard store</Link>} />
      <section className="stat-band">
        {stats.map(({ label, value, icon: Icon, tone }) => <div className="stat-item" key={label}><span className={`stat-icon stat-${tone}`}><Icon size={18} /></span><div><strong>{value.toLocaleString()}</strong><span>{label}</span></div></div>)}
      </section>

      <div className="dashboard-grid">
        <section className="panel capacity-panel">
          <header className="panel-header"><div><h2>Account capacity</h2><span>{data.stats.activeAccounts} accounts · {data.stats.activeZones} zones</span></div><Link className="text-link" to="/accounts">Manage <ArrowRight size={14} /></Link></header>
          <div className="capacity-list">
            {data.accountCapacity.length === 0 ? <EmptyRow icon={CloudCog} text="No Cloudflare accounts" action="Add account" to="/accounts" /> : data.accountCapacity.map((account) => (
              <div className="capacity-row" key={account.id}>
                <div className="capacity-name"><span className="account-glyph"><CloudCog size={16} /></span><div><strong>{account.name}</strong><span>{account.zoneCount} active zones</span></div></div>
                <CapacityBar value={account.storeCount} limit={account.softLimit} />
                <StatusBadge status={account.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="panel activity-panel">
          <header className="panel-header"><div><h2>Recent activity</h2><span>Control plane events</span></div><Link className="text-link" to="/audit">View all <ArrowRight size={14} /></Link></header>
          <div className="activity-list">
            {data.recentActivity.length === 0 ? <div className="quiet-empty">No activity recorded</div> : data.recentActivity.map((entry) => (
              <div className="activity-row" key={entry.id}><span className="activity-dot" /><div><strong>{entry.action.replaceAll(".", " ")}</strong><span>{entry.entityType} · {formatRelative(entry.createdAt)}</span></div></div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel table-panel">
        <header className="panel-header"><div><h2>Recently added stores</h2><span>Latest inventory changes</span></div><Link className="text-link" to="/stores">All stores <ArrowRight size={14} /></Link></header>
        <div className="table-scroll"><table><thead><tr><th>Store</th><th>Hostname</th><th>Onboarding</th><th>Tunnel</th><th>Added</th></tr></thead><tbody>
          {data.recentStores.length === 0 ? <tr><td colSpan={5}><div className="quiet-empty">No stores added</div></td></tr> : data.recentStores.map((store) => <tr key={store.id}><td><div className="primary-cell"><strong>{store.displayName}</strong><span>{store.storeCode}</span></div></td><td className="mono">{store.hostname}</td><td><StatusBadge status={store.onboardingStatus} /></td><td><StatusBadge status={store.tunnelStatus} /></td><td>{new Date(store.createdAt).toLocaleDateString()}</td></tr>)}
        </tbody></table></div>
      </section>
    </div>
  );
}

function formatRelative(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

function PageLoading() { return <div className="page"><div className="loading-line" /><div className="loading-block" /></div>; }

function EmptyRow({ icon: Icon, text, action, to }: { icon: typeof CloudCog; text: string; action: string; to: string }) {
  return <div className="empty-row"><Icon size={20} /><span>{text}</span><Link to={to}>{action}</Link></div>;
}

