import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink, MonitorUp, MoreHorizontal, Plus, RefreshCw, Search, Settings2, ShieldAlert, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { ConnectivityEditor, connectivityPayload, validatePublications, type DraftPublication } from "../components/ConnectivityEditor";
import { CopyButton } from "../components/CopyButton";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import type { AppSettings, EnrollmentResult, Store } from "../types";

type StoreListResponse = {
  stores: Store[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type StoreRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
};

export function StoresPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Store | null>(null);
  const [connectivityStore, setConnectivityStore] = useState<Store | null>(null);
  const pageSize = 25;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  const { data, isLoading } = useQuery({
    queryKey: ["stores", search, status, page, pageSize],
    queryFn: () => api.get<StoreListResponse>(`/api/stores?${params.toString()}`)
  });
  const refresh = useMutation({
    mutationFn: () => api.post<StoreRefreshResponse>("/api/stores/refresh", { storeIds: data?.stores.map((store) => store.id) ?? [] }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      if (result.failed) toast.warning(`${result.refreshed} refreshed, ${result.failed} failed`);
      else toast.success(`${result.refreshed} store${result.refreshed === 1 ? "" : "s"} refreshed`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to refresh stores")
  });
  useEffect(() => setPage(1), [search, status]);
  const pagination = data?.pagination;
  const firstResult = pagination && pagination.total > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const lastResult = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;
  return (
    <div className="page">
      <PageHeader title="Stores" eyebrow="Tunnel inventory" actions={<><button className="button button-secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending || !data?.stores.length}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button><Link className="button button-primary" to="/onboarding"><Plus size={16} />Onboard store</Link></>} />
      <div className="toolbar">
        <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search stores or hostnames" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter onboarding status"><option value="">All statuses</option><option value="active">Active</option><option value="verified">Verified</option><option value="url_issued">URL issued</option><option value="provisioning">Provisioning</option><option value="connector_online">Connector online</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select>
        <span className="result-count">{pagination?.total ?? 0} stores</span>
      </div>
      <section className="panel table-panel store-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Store</th><th>Hostname</th><th>Assignment</th><th>Onboarding</th><th>Tunnel</th><th>RDP</th><th /></tr></thead><tbody>
          {isLoading ? <tr><td colSpan={7}><div className="quiet-empty">Loading stores...</div></td></tr> : data?.stores.length === 0 ? <tr><td colSpan={7}><div className="quiet-empty">No stores match this view</div></td></tr> : data?.stores.map((store) => (
            <tr key={store.id}><td><div className="primary-cell"><strong>{store.displayName}</strong><span>{store.tenantCode} · {store.storeCode}</span></div></td><td><div className="hostname-cell"><span className="mono">{store.hostname}</span>{store.publications.length > 1 && <span className="endpoint-count">+{store.publications.length - 1}</span>}<button className="copy-icon" title="Copy hostname" onClick={() => { void navigator.clipboard.writeText(store.hostname); toast.success("Hostname copied"); }}><Copy size={14} /></button></div></td><td><div className="primary-cell"><strong>{store.accountName}</strong><span>{store.zoneName}</span></div></td><td><StatusBadge status={store.onboardingStatus} /></td><td><StatusBadge status={store.tunnelStatus} /></td><td>{store.rdpStatus === "ready" && store.rdpUrl ? <a className="button button-secondary table-action" href={store.rdpUrl} target="_blank" rel="noreferrer"><MonitorUp size={15} />Remote desktop</a> : <StatusBadge status={store.rdpStatus} />}</td><td><button className="icon-button" title="Store details" onClick={() => setSelected(store)}><MoreHorizontal size={18} /></button></td></tr>
          ))}
        </tbody></table></div>
        {pagination && pagination.total > 0 && <div className="table-pagination"><span>{firstResult}-{lastResult} of {pagination.total}</span><div><button className="icon-button" title="Previous page" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="icon-button" title="Next page" aria-label="Next page" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></div></div>}
      </section>
      <StoreModal store={selected} onClose={() => setSelected(null)} onEditConnectivity={(store) => { setSelected(null); setConnectivityStore(store); }} />
      <EditConnectivityModal store={connectivityStore} onClose={() => setConnectivityStore(null)} />
    </div>
  );
}

function StoreModal({ store, onClose, onEditConnectivity }: { store: Store | null; onClose: () => void; onEditConnectivity: (store: Store) => void }) {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  const mutation = useMutation({
    mutationFn: () => api.post<EnrollmentResult>(`/api/stores/${store!.id}/enrollments`, { expiresInHours: 24 }),
    onSuccess: async (result) => { setEnrollment(result); toast.success("Enrollment URL issued"); await queryClient.invalidateQueries({ queryKey: ["stores"] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to issue enrollment")
  });
  const verify = useMutation({
    mutationFn: () => api.post<{ success: boolean; check: { statusCode: number | null; latencyMs: number; error?: string }; checks: unknown[] }>(`/api/stores/${store!.id}/verify`),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ["stores"] }); if (result.success) toast.success(`${result.checks.length} endpoint${result.checks.length === 1 ? "" : "s"} verified`); else toast.error(result.check.error ?? "One or more endpoints are unreachable"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Verification failed")
  });
  const revoke = useMutation({
    mutationFn: () => api.post(`/api/stores/${store!.id}/enrollments/revoke`),
    onSuccess: async () => { setEnrollment(null); await queryClient.invalidateQueries({ queryKey: ["stores"] }); toast.success("Enrollment revoked"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to revoke enrollment")
  });
  const retryRdp = useMutation({
    mutationFn: () => api.post(`/api/stores/${store!.id}/rdp/retry`),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["stores"] }); toast.success("Browser RDP provisioned"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "RDP provisioning failed")
  });
  const close = () => { setEnrollment(null); onClose(); };
  const canRevoke = ["url_issued", "claimed", "provisioning", "failed"].includes(store?.onboardingStatus ?? "");
  return (
    <Modal open={Boolean(store)} title={store?.displayName ?? "Store details"} onClose={close} width="wide">
      {store && <div className="detail-layout">
        <dl className="detail-list">
          <div><dt>Store code</dt><dd>{store.tenantCode} / {store.storeCode}</dd></div>
          <div><dt>Hostname</dt><dd className="mono">{store.hostname}</dd></div>
          <div><dt>Origin</dt><dd className="mono">{store.originUrl}</dd></div>
          <div><dt>Account</dt><dd>{store.accountName}</dd></div>
          <div><dt>Zone</dt><dd>{store.zoneName}</dd></div>
          <div><dt>Tunnel ID</dt><dd className="mono">{store.tunnelId ?? "Not provisioned"}</dd></div>
          <div><dt>RDP target</dt><dd className="mono">{store.rdpTargetIp ? `${store.rdpTargetIp}:3389` : "Awaiting Windows installer"}</dd></div>
          <div><dt>RDP gateway</dt><dd className="mono">{store.rdpUrl ? new URL(store.rdpUrl).hostname : "Not provisioned"}</dd></div>
        </dl>
        <div className="detail-status">
          <div><span>Onboarding</span><StatusBadge status={store.onboardingStatus} /></div>
          <div><span>Tunnel</span><StatusBadge status={store.tunnelStatus} /></div>
          <div><span>RDP</span><StatusBadge status={store.rdpStatus} /></div>
        </div>
        <section className="publication-summary"><header><h3>Published endpoints</h3><span>{store.publications.length} hostname{store.publications.length === 1 ? "" : "s"}</span></header>{store.publications.map((publication) => <div className="publication-summary-item" key={publication.id}><div><code>{publication.hostname}</code><StatusBadge status={publication.status} />{store.tunnelStatus === "healthy" && <a className="copy-icon" href={`https://${publication.hostname}`} target="_blank" rel="noreferrer" title="Open endpoint"><ExternalLink size={14} /></a>}</div>{publication.routes.map((route) => <div className="publication-route" key={route.id}><code>{route.path}</code><span>→</span><code>{route.serviceUrl}</code></div>)}</div>)}</section>
        {store.rdpLastError && <div className="inline-alert">{store.rdpLastError}</div>}
        {enrollment ? <EnrollmentCommands result={enrollment} /> : <div className="detail-actions">
          <button className="button button-secondary" onClick={() => onEditConnectivity(store)}><Settings2 size={15} />Edit connectivity</button>
          <button className="button button-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}><TerminalSquare size={16} />{mutation.isPending ? "Issuing..." : "Issue install URL"}</button>
          {store.rdpStatus === "ready" && store.rdpUrl && <a className="button button-primary" href={store.rdpUrl} target="_blank" rel="noreferrer"><MonitorUp size={16} />Remote desktop</a>}
          {store.rdpTargetIp && store.rdpStatus !== "ready" && <button className="button button-secondary" onClick={() => retryRdp.mutate()} disabled={retryRdp.isPending}><RefreshCw size={15} />{retryRdp.isPending ? "Retrying..." : "Retry RDP"}</button>}
          <button className="button button-secondary" onClick={() => verify.mutate()} disabled={verify.isPending}><CheckCircle2 size={15} />{verify.isPending ? "Checking..." : "Verify endpoint"}</button>
          {canRevoke && <button className="button button-danger" onClick={() => { if (window.confirm("Revoke this enrollment URL?")) revoke.mutate(); }} disabled={revoke.isPending}><ShieldAlert size={15} />Revoke</button>}
          {store.tunnelStatus === "healthy" && <a className="button button-secondary" href={`https://${store.hostname}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open endpoint</a>}
        </div>}
      </div>}
    </Modal>
  );
}

function EditConnectivityModal({ store, onClose }: { store: Store | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [publications, setPublications] = useState<DraftPublication[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setPublications(store?.publications.map((publication) => ({
      key: publication.id,
      suffix: publication.suffix,
      routes: publication.routes.map((route) => ({ key: route.id, path: route.path, serviceUrl: route.serviceUrl }))
    })) ?? []);
  }, [store]);
  const mutation = useMutation({
    mutationFn: () => api.put<{ success: boolean; applied: boolean }>(`/api/stores/${store!.id}/connectivity`, { publications: connectivityPayload(publications) }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      toast.success(result.applied ? "Tunnel connectivity updated" : "Connectivity saved for provisioning");
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to update connectivity")
  });
  const save = () => {
    const validationError = validatePublications(publications);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    mutation.mutate();
  };
  return (
    <Modal open={Boolean(store)} title={`Edit connectivity · ${store?.displayName ?? "store"}`} onClose={onClose} width="wide">
      {store && <div className="connectivity-modal">
        {error && <div className="form-error">{error}</div>}
        <div className="connectivity-scope"><div><span>Cloudflare account</span><strong>{store.accountName}</strong></div><div><span>DNS zone</span><strong>{store.zoneName}</strong></div><div><span>Tunnel</span><strong className="mono">{store.tunnelId ?? "Pending installation"}</strong></div></div>
        <ConnectivityEditor storeId={store.storeCode} zoneName={store.zoneName} publications={publications} onChange={setPublications} />
        <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={save} disabled={mutation.isPending}>{mutation.isPending ? "Updating..." : "Save connectivity"}</button></div>
      </div>}
    </Modal>
  );
}

export function EnrollmentCommands({ result }: { result: EnrollmentResult }) {
  const [platform, setPlatform] = useState<"windows" | "unix">("windows");
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: AppSettings }>("/api/settings") });
  const withCurrentBaseUrl = (value: string) => {
    if (!data?.settings.publicBaseUrl) return value;
    const url = new URL(value);
    return `${data.settings.publicBaseUrl}${url.pathname}${url.search}`;
  };
  const powershellUrl = withCurrentBaseUrl(result.urls.powershell);
  const shellUrl = withCurrentBaseUrl(result.urls.shell);
  const command = platform === "windows" ? `irm '${powershellUrl}' | iex` : `curl -fsSL '${shellUrl}' | sudo bash`;
  return <div className="command-section"><div className="command-head"><div className="segmented compact"><button type="button" className={platform === "windows" ? "active" : ""} onClick={() => setPlatform("windows")}>PowerShell</button><button type="button" className={platform === "unix" ? "active" : ""} onClick={() => setPlatform("unix")}>Bash</button></div><CopyButton value={command} label="Copy command" /></div><pre><code>{command}</code></pre>{platform === "windows" && <div className="command-note"><ShieldAlert size={14} />Run PowerShell as Administrator.</div>}<div className="expiry-line">Expires {new Date(result.expiresAt).toLocaleString()}</div></div>;
}
