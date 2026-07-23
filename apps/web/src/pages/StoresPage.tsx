import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Apple, CheckCircle2, ChevronLeft, ChevronRight, FilePlus2, Monitor, MonitorUp, Plus, RefreshCw, Save, ScrollText, Search, Server, Settings2, ShieldAlert, ShieldCheck, TerminalSquare, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { ConnectivityEditor, connectivityPayload, validatePublications, type DraftPublication } from "../components/ConnectivityEditor";
import { CopyButton } from "../components/CopyButton";
import { FieldHelp } from "../components/FieldHelp";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { ScriptEditor } from "../components/ScriptEditor";
import { SearchableSelect } from "../components/SearchableSelect";
import { SideDrawer } from "../components/SideDrawer";
import { StatusBadge } from "../components/StatusBadge";
import type { AppSettings, EnrollmentResult, ManagedScript, ManagedScriptSummary, Store, StoreCommandExecution, StoreDeletePreflight, StoreEnrollment, StoreRoute, UnenrollmentResult } from "../types";

type StoreListResponse = {
  stores: Store[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type StoreRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
};

export type StoreDrawerTab = "overall" | "ingress" | "connect";

export function StoresPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Store | null>(null);
  const [selectedTab, setSelectedTab] = useState<StoreDrawerTab>("overall");
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
  const openStore = (store: Store, tab: StoreDrawerTab = "overall") => {
    setSelected(store);
    setSelectedTab(tab);
  };
  return (
    <div className="page">
      <PageHeader title="Stores" eyebrow="Tunnel inventory" actions={<><button className="button button-secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending || !data?.stores.length}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button><Link className="button button-primary" to="/onboarding"><Plus size={16} />Onboard store</Link></>} />
      <div className="toolbar">
        <label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search stores or hostnames" /></label>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter onboarding status"><option value="">All statuses</option><option value="active">Active</option><option value="verified">Verified</option><option value="waiting_for_new_enrollment">Waiting for new enrollment</option><option value="url_issued">URL issued</option><option value="claimed">Claimed</option><option value="provisioning">Provisioning</option><option value="ready">Ready</option><option value="installed">Installed</option><option value="connector_online">Connector online</option><option value="unenrolled">Unenrolled</option><option value="expired">Expired</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select>
        <span className="result-count">{pagination?.total ?? 0} stores</span>
      </div>
      <section className="panel table-panel store-table-panel">
        <div className="table-scroll"><table><thead><tr><th>Store</th><th>Assignment</th><th>Onboarding</th><th>Tunnel</th><th>RDP</th><th>Commands</th></tr></thead><tbody>
          {isLoading ? <tr><td colSpan={6}><div className="quiet-empty">Loading stores...</div></td></tr> : data?.stores.length === 0 ? <tr><td colSpan={6}><div className="quiet-empty">No stores match this view</div></td></tr> : data?.stores.map((store) => (
            <tr key={store.id} className="store-row" onClick={() => openStore(store)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openStore(store); } }} tabIndex={0}><td><div className="primary-cell"><strong>{store.displayName}</strong><span>{store.tenantCode} · {store.storeCode}</span></div></td><td><div className="primary-cell"><strong>{store.accountName}</strong><span>{store.zoneName}</span></div></td><td><StatusBadge status={store.onboardingStatus} /></td><td><StatusBadge status={store.tunnelStatus} /></td><td><StatusBadge status={store.rdpStatus} /></td><td>{store.commandAgent && <button className="icon-button command-agent-table-action" type="button" title="Open Connect tab" aria-label={`Open Connect tab for ${store.displayName}`} onClick={(event) => { event.stopPropagation(); openStore(store, "connect"); }}><TerminalSquare size={17} /></button>}</td></tr>
          ))}
        </tbody></table></div>
        {pagination && pagination.total > 0 && <div className="table-pagination"><span>{firstResult}-{lastResult} of {pagination.total}</span><div><button className="icon-button" title="Previous page" aria-label="Previous page" disabled={pagination.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></button><span>Page {pagination.page} of {pagination.totalPages}</span><button className="icon-button" title="Next page" aria-label="Next page" disabled={pagination.page >= pagination.totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></div></div>}
      </section>
      <StoreDrawer store={selected} tab={selectedTab} onTabChange={setSelectedTab} onClose={() => setSelected(null)} />
    </div>
  );
}

export function StoreDrawer({ store, tab, onTabChange, onClose }: { store: Store | null; tab: StoreDrawerTab; onTabChange: (tab: StoreDrawerTab) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  const [logEnrollment, setLogEnrollment] = useState<StoreEnrollment | null>(null);
  const [unenrollment, setUnenrollment] = useState<UnenrollmentResult | null>(null);
  const [deleteEnrollmentTarget, setDeleteEnrollmentTarget] = useState<StoreEnrollment | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreflight, setDeletePreflight] = useState<StoreDeletePreflight | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const [editingConnectivity, setEditingConnectivity] = useState(false);
  const [wafRoute, setWafRoute] = useState<StoreRoute | null>(null);
  const { data: detailData } = useQuery({
    queryKey: ["store-detail", store?.id],
    queryFn: () => api.get<{ store: Store }>(`/api/stores/${store!.id}`),
    enabled: Boolean(store),
    refetchInterval: (query) => query.state.data?.store.commandExecutions?.some((execution) => execution.status === "running") ? 2000 : false
  });
  const currentStore = detailData?.store ?? store;
  useEffect(() => setEditingConnectivity(false), [store?.id]);
  const { data: logData, isLoading: logsLoading } = useQuery({
    queryKey: ["enrollment-logs", store?.id, logEnrollment?.id],
    queryFn: () => api.get<{ logs: Array<{ id: number; level: string; step: string | null; message: string; metadata: Record<string, unknown>; createdAt: string }> }>(`/api/stores/${store!.id}/enrollments/${logEnrollment!.id}/logs`),
    enabled: Boolean(store && logEnrollment)
  });
  const mutation = useMutation({
    mutationFn: () => api.post<EnrollmentResult>(`/api/stores/${store!.id}/enrollments`, { expiresInHours: 24 }),
    onSuccess: async (result) => { setEnrollment(result); setUnenrollment(null); toast.success("Enrollment URL issued"); await queryClient.invalidateQueries({ queryKey: ["stores"] }); await queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] }); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to issue enrollment")
  });
  const verify = useMutation({
    mutationFn: (routeId: string) => api.post<{ success: boolean; check: { statusCode: number | null; latencyMs: number; error?: string }; checks: unknown[] }>(`/api/stores/${store!.id}/verify`, { routeId }),
    onSuccess: async (result) => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["stores"] }), queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] })]); if (result.success) toast.success("Endpoint verified"); else toast.error(result.check.error ?? "Endpoint is unreachable"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Verification failed")
  });
  const deleteEnrollment = useMutation({
    mutationFn: (enrollmentId: string) => api.delete<{ hardDeleted: boolean; logCount?: number }>(`/api/stores/${store!.id}/enrollments/${enrollmentId}`),
    onSuccess: async () => {
      setDeleteEnrollmentTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] }),
        queryClient.invalidateQueries({ queryKey: ["stores"] })
      ]);
      toast.success("Enrollment permanently deleted; logs are no longer available");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete enrollment")
  });
  const issueUnenrollment = useMutation({
    mutationFn: (enrollmentId: string) => api.post<UnenrollmentResult>(`/api/stores/${store!.id}/enrollments/${enrollmentId}/unenroll`, { expiresInHours: 24 }),
    onSuccess: async (result) => {
      setUnenrollment(result);
      await queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] });
      toast.success("Unenrollment command issued");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to issue unenrollment command")
  });
  const retryRdp = useMutation({
    mutationFn: () => api.post(`/api/stores/${store!.id}/rdp/retry`),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["stores"] }); toast.success("Browser RDP provisioned"); },
    onError: (error) => toast.error(error instanceof Error ? error.message : "RDP provisioning failed")
  });
  const deletePreflightMutation = useMutation({
    mutationFn: () => api.get<StoreDeletePreflight>(`/api/stores/${store!.id}/delete-preflight`),
    onSuccess: (result) => setDeletePreflight(result),
    onError: (error) => { setDeleteOpen(false); toast.error(error instanceof Error ? error.message : "Unable to check store deletion readiness"); }
  });
  const deleteStore = useMutation({
    mutationFn: () => api.delete(`/api/stores/${store!.id}`, {
      force: Boolean(deletePreflight && !deletePreflight.canDelete),
      ...(deletePreflight && !deletePreflight.canDelete ? { confirmName: deleteName } : {})
    }),
    onSuccess: async () => {
      setDeleteOpen(false);
      setDeletePreflight(null);
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] })
      ]);
      toast.success("Store deleted");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Unable to delete store");
      deletePreflightMutation.mutate();
    }
  });
  const openDelete = () => {
    setDeleteName("");
    setDeletePreflight(null);
    setDeleteOpen(true);
    deletePreflightMutation.mutate();
  };
  const close = () => { setEnrollment(null); setUnenrollment(null); setLogEnrollment(null); setDeleteEnrollmentTarget(null); setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); setEditingConnectivity(false); setWafRoute(null); onClose(); };
  return (
    <>
    <SideDrawer open={Boolean(store)} title={<div className="store-drawer-heading"><strong>{currentStore?.displayName ?? "Store details"}</strong>{currentStore && <div className="store-drawer-statuses"><div><span>Onboarding</span><StatusBadge status={currentStore.onboardingStatus} /></div><div><span>Tunnel</span><StatusBadge status={currentStore.tunnelStatus} /></div><div><span>RDP</span><StatusBadge status={currentStore.rdpStatus} /></div></div>}</div>} onClose={close}>
      {currentStore && <div className="store-drawer-content">
        <nav className="store-drawer-tabs" aria-label="Store detail sections">
          <button className={tab === "overall" ? "active" : ""} type="button" onClick={() => onTabChange("overall")}>Overall</button>
          <button className={tab === "ingress" ? "active" : ""} type="button" onClick={() => onTabChange("ingress")}>Ingress routes</button>
          <button className={tab === "connect" ? "active" : ""} type="button" onClick={() => onTabChange("connect")}>Connect</button>
        </nav>
        {tab === "overall" && <div className="store-drawer-tab">
          <section className="store-drawer-section">
            <header className="store-section-heading"><div><h3>Store overview</h3><span>Store assignment and infrastructure</span></div></header>
            <dl className="detail-list">
              <div><dt>Store code</dt><dd>{currentStore.tenantCode} / {currentStore.storeCode}</dd></div>
              <div><dt>Account</dt><dd>{currentStore.accountName}</dd></div>
              <div><dt>Zone</dt><dd>{currentStore.zoneName}</dd></div>
              <div><dt>Tunnel ID</dt><dd>{currentStore.tunnelId ? currentStore.cfAccountId ? <a className="mono detail-link" href={`https://dash.cloudflare.com/${encodeURIComponent(currentStore.cfAccountId)}/tunnels/${encodeURIComponent(currentStore.tunnelId)}/overview`} target="_blank" rel="noreferrer" title="Open tunnel details in Cloudflare">{currentStore.tunnelId}</a> : <span className="mono">{currentStore.tunnelId}</span> : "Not provisioned"}</dd></div>
            </dl>
          </section>
          <EnrollmentHistory enrollments={currentStore.enrollments ?? []} onViewLog={setLogEnrollment} onDelete={(enrollment) => setDeleteEnrollmentTarget(enrollment)} onUnenroll={(enrollment) => issueUnenrollment.mutate(enrollment.id)} deleting={deleteEnrollment.isPending} unenrolling={issueUnenrollment.isPending} />
          {unenrollment && <UnenrollmentCommands result={unenrollment} />}
          {enrollment ? <EnrollmentCommands result={enrollment} /> : <div className="detail-actions">
            <button className="button button-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}><TerminalSquare size={16} />{mutation.isPending ? "Issuing..." : "New enrollment"}</button>
            <button className="button button-danger" onClick={openDelete} disabled={deletePreflightMutation.isPending || deleteStore.isPending}><Trash2 size={15} />Delete store</button>
          </div>}
        </div>}
        {tab === "ingress" && <div className="store-drawer-tab">
          {editingConnectivity ? <EditConnectivityPanel store={currentStore} onClose={() => setEditingConnectivity(false)} /> : <section className="store-drawer-section publication-summary"><header className="store-section-heading"><div><h3>Published endpoints</h3><span>{currentStore.publications.length} hostname{currentStore.publications.length === 1 ? "" : "s"}</span></div><button className="button button-secondary" type="button" onClick={() => setEditingConnectivity(true)}><Settings2 size={15} />Edit connectivity</button></header>{currentStore.publications.map((publication) => <div className="publication-summary-item" key={publication.id}><div className="publication-summary-head"><code>{publication.hostname}</code><StatusBadge status={publication.status} /></div>{publication.routes.map((route) => <div className="publication-route" key={route.id}><code>{route.path}</code><span>→</span><code>{route.kind === "command_agent" ? "Cloudflare Man command agent" : route.serviceUrl}</code><div className="publication-route-actions"><button className="button button-secondary publication-verify-button" type="button" onClick={() => verify.mutate(route.id)} disabled={verify.isPending}><CheckCircle2 size={15} />{verify.isPending && verify.variables === route.id ? "Checking..." : "Verify endpoint"}</button><button className={`button button-secondary publication-waf-button ${route.wafEnabled && route.wafRuleId ? "waf-active" : ""}`} type="button" title={route.wafEnabled && !route.wafRuleId ? "WAF policy is pending application" : "Manage route WAF"} onClick={() => setWafRoute(route)}><ShieldCheck size={15} />WAF</button></div></div>)}</div>)}</section>}
        </div>}
        {tab === "connect" && <div className="store-drawer-tab store-connect-tab">
          <section className="store-drawer-section rdp-section">
            <header className="store-section-heading"><div><h3>Remote desktop</h3><span>{currentStore.rdpUrl ? new URL(currentStore.rdpUrl).hostname : "Browser RDP gateway"}</span></div><StatusBadge status={currentStore.rdpStatus} /></header>
            <div className="rdp-connection-row">
              <div><span>Target</span><code>{currentStore.rdpTargetIp ? `${currentStore.rdpTargetIp}:3389` : "Awaiting Windows installer"}</code></div>
              <div><span>Gateway</span><code>{currentStore.rdpUrl ?? "Not provisioned"}</code></div>
              <div className="rdp-connection-action">{currentStore.rdpStatus === "ready" && currentStore.rdpUrl && <a className="button button-primary" href={currentStore.rdpUrl} target="_blank" rel="noreferrer"><MonitorUp size={16} />Remote desktop</a>}{currentStore.rdpTargetIp && currentStore.rdpStatus !== "ready" && <button className="button button-secondary" onClick={() => retryRdp.mutate()} disabled={retryRdp.isPending}><RefreshCw size={15} />{retryRdp.isPending ? "Retrying..." : "Retry RDP"}</button>}</div>
            </div>
            {currentStore.rdpLastError && <div className="inline-alert">{currentStore.rdpLastError}</div>}
          </section>
          {currentStore.commandAgent ? <CommandExecutionPanel store={currentStore} /> : <div className="inline-alert">This store does not have a command agent endpoint.</div>}
        </div>}
      </div>}
    </SideDrawer>
    <EnrollmentDeleteDialog enrollment={deleteEnrollmentTarget} onClose={() => setDeleteEnrollmentTarget(null)} onConfirm={() => deleteEnrollmentTarget && deleteEnrollment.mutate(deleteEnrollmentTarget.id)} deleting={deleteEnrollment.isPending} />
    <StoreDeleteDialog open={deleteOpen} preflight={deletePreflight} loading={deletePreflightMutation.isPending} confirmationName={deleteName} onConfirmationNameChange={setDeleteName} onClose={() => { setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); }} onConfirm={() => deleteStore.mutate()} deleting={deleteStore.isPending} />
    <RouteWafDialog store={currentStore} route={wafRoute} onClose={() => setWafRoute(null)} />
    <Modal open={Boolean(logEnrollment)} title={`Enrollment log · ${logEnrollment ? new Date(logEnrollment.createdAt).toLocaleString() : ""}`} onClose={() => setLogEnrollment(null)} width="wide">
      {logsLoading ? <div className="quiet-empty">Loading logs...</div> : logData?.logs.length ? <div className="enrollment-log-list">{logData.logs.map((log) => <article key={log.id} className={`enrollment-log enrollment-log-${log.level}`}><header><StatusBadge status={log.level} /><strong>{log.step ?? "installer"}</strong><time>{new Date(log.createdAt).toLocaleString()}</time></header><p>{log.message}</p></article>)}</div> : <div className="quiet-empty">No logs have been reported for this enrollment.</div>}
    </Modal>
    </>
  );
}

function StoreDeleteDialog({
  open,
  preflight,
  loading,
  confirmationName,
  onConfirmationNameChange,
  onClose,
  onConfirm,
  deleting
}: {
  open: boolean;
  preflight: StoreDeletePreflight | null;
  loading: boolean;
  confirmationName: string;
  onConfirmationNameChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  const requiresName = Boolean(preflight && !preflight.canDelete);
  const nameMatches = !requiresName || confirmationName === preflight?.displayName;
  return <Modal open={open} title={`Delete store · ${preflight?.displayName ?? "Store"}`} onClose={onClose} width="wide">
    {loading || !preflight ? <div className="quiet-empty">Checking deletion readiness...</div> : <div className="delete-confirmation">
      <p>This permanently removes the store from Cloudflare Man and attempts to delete its store-owned Cloudflare DNS, tunnel, and RDP network resources.</p>
      <div className="delete-check-list">{preflight.checks.map((check) => <article className={`delete-check-row ${check.ok ? "delete-check-ok" : "delete-check-blocked"}`} key={check.id}><span className="delete-check-icon">{check.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}</span><div><strong>{check.label}</strong><p>{check.detail}</p><small><b>How to resolve:</b> {check.resolution}</small></div></article>)}</div>
      {requiresName && <div className="delete-force-panel"><div className="inline-alert"><AlertTriangle size={15} />One or more safety checks are not ready. Force delete will terminate remaining tunnel connections and may interrupt running commands.</div><label className="field"><span className="field-label">Type the store name to confirm <FieldHelp text="Enter the exact display name shown in the store details title. This extra confirmation is required when a tunnel, enrollment, or command is still active." /></span><input value={confirmationName} onChange={(event) => onConfirmationNameChange(event.target.value)} placeholder={preflight.displayName} autoComplete="off" /></label></div>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-danger" type="button" disabled={!nameMatches || deleting} onClick={onConfirm}><Trash2 size={15} />{deleting ? "Deleting..." : requiresName ? "Force delete store" : "Delete store"}</button></div>
    </div>}
  </Modal>;
}

function EnrollmentDeleteDialog({ enrollment, onClose, onConfirm, deleting }: { enrollment: StoreEnrollment | null; onClose: () => void; onConfirm: () => void; deleting: boolean }) {
  return <Modal open={Boolean(enrollment)} title={`Delete enrollment · ${enrollment ? enrollmentComputerName(enrollment) : ""}`} onClose={onClose}>
    <div className="enrollment-delete-dialog">
      <div className="inline-alert enrollment-delete-no-logs"><Trash2 size={15} />This permanently deletes the enrollment. Its logs will no longer be available to view.</div>
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-danger" type="button" onClick={onConfirm} disabled={deleting}><Trash2 size={15} />{deleting ? "Deleting..." : "Delete permanently"}</button></div>
    </div>
  </Modal>;
}

function EnrollmentHistory({ enrollments, onViewLog, onDelete, onUnenroll, deleting, unenrolling }: { enrollments: StoreEnrollment[]; onViewLog: (enrollment: StoreEnrollment) => void; onDelete: (enrollment: StoreEnrollment) => void; onUnenroll: (enrollment: StoreEnrollment) => void; deleting: boolean; unenrolling: boolean }) {
  return <section className="enrollment-history"><header><h3>Enrollment history</h3><span>{enrollments.length} attempt{enrollments.length === 1 ? "" : "s"}</span></header>{enrollments.length ? <div className="enrollment-history-list">{enrollments.map((enrollment) => {
    const environment = enrollmentEnvironment(enrollment);
    const displayStatus = enrollmentDisplayStatus(enrollment);
    const displayTime = enrollmentDisplayTime(enrollment, displayStatus);
    return <div className="enrollment-history-row" key={enrollment.id}>
      <div className="enrollment-history-field enrollment-computer-field"><div className="enrollment-computer-summary" title={environment} aria-label={`${environment} · ${enrollmentComputerName(enrollment)}`}><span className="enrollment-platform-icon">{enrollmentPlatformIcon(enrollment)}</span><strong>{enrollmentComputerName(enrollment)}</strong></div></div>
      <div className="enrollment-history-field enrollment-status-cell"><StatusBadge status={displayStatus} /></div>
      <time className="enrollment-event-time" dateTime={displayTime ?? undefined}>{displayTime ? new Date(displayTime).toLocaleString() : "-"}</time>
      <div className="enrollment-history-actions"><button className="button button-secondary enrollment-log-button" type="button" onClick={() => onViewLog(enrollment)}><ScrollText size={15} />View log</button>{enrollment.isCurrent ? <button className="icon-button enrollment-unenroll-button" type="button" title="Unenroll this computer" aria-label={`Unenroll ${enrollmentComputerName(enrollment)}`} onClick={() => onUnenroll(enrollment)} disabled={unenrolling}><Unplug size={16} /></button> : enrollment.unenrollStatus === "unenrolled" && !enrollment.deletedAt ? <button className="icon-button enrollment-delete-button" type="button" title="Delete enrollment permanently" aria-label={`Delete enrollment for ${enrollmentComputerName(enrollment)}`} onClick={() => onDelete(enrollment)} disabled={deleting}><Trash2 size={15} /></button> : <span className="enrollment-action-placeholder" aria-hidden="true" />}</div>
    </div>;
  })}</div> : <div className="quiet-empty">No enrollment links have been issued for this store.</div>}</section>;
}

function enrollmentComputerName(enrollment: StoreEnrollment): string {
  return enrollment.computerName ?? enrollment.hostInfo.machineName ?? "N/A";
}

function enrollmentPlatformIcon(enrollment: StoreEnrollment) {
  switch (enrollment.environment ?? enrollment.platform) {
    case "darwin": return <Apple size={19} />;
    case "linux": return <Server size={19} />;
    default: return <Monitor size={19} />;
  }
}

function enrollmentRunStatus(enrollment: StoreEnrollment): "never_run" | "running" | "success" | "failed" {
  const installScripts = enrollment.scripts.filter((script) => script.kind === "install");
  if (installScripts.some((script) => script.status === "failed") || enrollment.status === "failed") return "failed";
  if (installScripts.some((script) => script.status === "running") || ["claimed", "provisioning", "ready"].includes(enrollment.status)) return "running";
  if (installScripts.some((script) => script.status === "completed") || enrollment.status === "installed") return "success";
  return "never_run";
}

function enrollmentDisplayStatus(enrollment: StoreEnrollment): string {
  if (enrollment.deletedAt) return "deleted";
  if (enrollment.isCurrent) return "connected";
  if (enrollment.unenrollStatus === "unenrolled") return "unenrolled";
  if (enrollment.unenrollStatus === "failed") return "unenroll_failed";
  if (enrollment.unenrollStatus === "pending") return "unenroll_pending";
  if (enrollmentRunStatus(enrollment) === "never_run" && (enrollment.status === "expired" || new Date(enrollment.expiresAt).getTime() <= Date.now())) return "staled";
  return enrollmentRunStatus(enrollment);
}

function enrollmentDisplayTime(enrollment: StoreEnrollment, status: string): string | null {
  if (status === "deleted") return enrollment.deletedAt;
  if (status === "connected") return enrollment.installedAt ?? enrollment.claimedAt ?? enrollment.createdAt;
  if (status === "unenrolled") return enrollment.unenrolledAt;
  if (status === "unenroll_pending" || status === "unenroll_failed") return enrollment.unenrollRequestedAt;
  if (status === "never_run" || status === "staled") return enrollment.createdAt;
  if (status === "running") return enrollment.claimedAt ?? enrollment.createdAt;
  if (status === "success") return enrollment.installedAt ?? enrollment.createdAt;
  const finishedScript = enrollment.scripts.find((script) => script.status === "failed" && script.finishedAt);
  return finishedScript?.finishedAt ?? enrollment.claimedAt ?? enrollment.createdAt;
}

function enrollmentEnvironment(enrollment: StoreEnrollment): string {
  switch (enrollment.environment ?? enrollment.platform) {
    case "windows": return "Windows";
    case "linux": return "Linux";
    case "darwin": return "macOS";
    case "unix": return "Unix";
    default: return "Not detected";
  }
}

type CommandExecutionResult = {
  executionId: string;
  endpoint: string;
  enrollmentId: string;
  scriptType: "managed" | "inline";
  scriptId: string | null;
  scriptVersionId: string | null;
  scriptName: string;
  version: number | null;
  platform: "windows" | "unix";
  language: "powershell" | "bash" | "sh";
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type CommandExecutionPage = {
  executions: StoreCommandExecution[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

const quickScriptDefaults = {
  windows: "Write-Output \"Store: $env:COMPUTERNAME\"\n",
  unix: "printf 'Store: %s\\n' \"$(hostname)\"\n"
};

function CommandExecutionPanel({ store }: { store: Store }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [executionMode, setExecutionMode] = useState<"saved" | "inline">("saved");
  const [inlineName, setInlineName] = useState("");
  const [inlineContent, setInlineContent] = useState(quickScriptDefaults.windows);
  const [inlineLanguage, setInlineLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null);
  const [expandLatestAfterExecution, setExpandLatestAfterExecution] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickLanguage, setQuickLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [quickDescription, setQuickDescription] = useState("");
  const [quickContent, setQuickContent] = useState(quickScriptDefaults.windows);
  const activeEnrollment = [...(store.enrollments ?? [])].filter((enrollment) => enrollment.isCurrent && ["ready", "installed"].includes(enrollment.status) && enrollment.unenrolledAt === null && enrollment.deletedAt === null).sort((left, right) => new Date(right.installedAt ?? right.createdAt).getTime() - new Date(left.installedAt ?? left.createdAt).getTime())[0];
  const hostPlatform = activeEnrollment?.platform ?? null;
  const historyPageSize = 10;
  const { data: executionData } = useQuery({
    queryKey: ["command-executions", store.id, historyPage, historyPageSize],
    queryFn: () => api.get<CommandExecutionPage>(`/api/stores/${store.id}/command-executions?page=${historyPage}&pageSize=${historyPageSize}`),
    refetchInterval: (query) => query.state.data?.executions.some((execution) => execution.status === "running") ? 2000 : false
  });
  const { data: scriptData } = useQuery({
    queryKey: ["scripts", "command-agent", hostPlatform],
    queryFn: () => api.get<{ scripts: ManagedScriptSummary[] }>(`/api/scripts${hostPlatform ? `?platform=${hostPlatform}` : ""}`),
    enabled: Boolean(hostPlatform)
  });
  const { data: selectedScriptData } = useQuery({
    queryKey: ["script-detail", selectedScriptId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${selectedScriptId}`),
    enabled: Boolean(selectedScriptId)
  });
  const selectedScript = selectedScriptData?.script;
  const selectedScriptVersion = selectedScript?.versions.find((version) => version.id === selectedVersionId) ?? selectedScript?.versions[0];
  const scriptOptions = scriptData?.scripts ?? [];
  const pickerOptions = scriptOptions.map((script) => ({ value: script.id, label: `${script.name} · ${script.platform}` }));
  useEffect(() => {
    if (!selectedScriptId && scriptOptions[0]) setSelectedScriptId(scriptOptions[0].id);
  }, [scriptOptions, selectedScriptId]);
  useEffect(() => {
    if (selectedScript && selectedScript.versions[0] && !selectedScript.versions.some((version) => version.id === selectedVersionId)) setSelectedVersionId(selectedScript.versions[0].id);
  }, [selectedScript, selectedVersionId]);
  useEffect(() => {
    if (!hostPlatform) return;
    const language = hostPlatform === "windows" ? "powershell" : "bash";
    setInlineLanguage(language);
    setInlineName("");
    setInlineContent(quickScriptDefaults[hostPlatform]);
    setExecutionMode("saved");
    setHistoryPage(1);
    setExpandedExecutionId(null);
  }, [hostPlatform, store.id]);
  const openQuickCreate = () => {
    if (!hostPlatform) return;
    setQuickName("");
    setQuickDescription("");
    setQuickLanguage(hostPlatform === "windows" ? "powershell" : "bash");
    setQuickContent(quickScriptDefaults[hostPlatform]);
    setQuickCreateOpen(true);
  };
  const quickCreate = useMutation({
    mutationFn: () => api.post<{ id: string; versionId: string }>("/api/scripts", {
      name: quickName,
      platform: hostPlatform,
      language: quickLanguage,
      description: quickDescription,
      content: quickContent
    }),
    onSuccess: async (created) => {
      setQuickCreateOpen(false);
      setSelectedScriptId(created.id);
      setSelectedVersionId(created.versionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", created.id] })
      ]);
      toast.success("Quick script created");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to create script")
  });
  const execute = useMutation({
    mutationFn: () => api.post<CommandExecutionResult>(`/api/stores/${store.id}/commands/execute`, {
      ...(executionMode === "saved"
        ? { scriptVersionId: selectedVersionId }
        : { inlineScript: inlineContent, name: inlineName, language: inlineLanguage }),
      timeoutMs: timeoutSeconds * 1_000
    }),
    onSuccess: async (response) => {
      setHistoryPage(1);
      setExpandedExecutionId(response.executionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["stores"] })
      ]);
      setExpandLatestAfterExecution(false);
      if (response.success) toast.success("Script completed successfully");
      else toast.error(`Script exited with code ${response.exitCode ?? "timeout"}`);
    },
    onError: async (error) => {
      setHistoryPage(1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["stores"] })
      ]);
      setExpandLatestAfterExecution(true);
      toast.error(error instanceof Error ? error.message : "Unable to execute script");
    }
  });
  const refreshHistory = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["command-executions", store.id], type: "active" }),
    onError: () => toast.error("Unable to refresh execution history")
  });
  const saveInlineExecution = useMutation({
    mutationFn: (execution: StoreCommandExecution) => api.post<{ executionId: string; scriptId: string; versionId: string; version: number; alreadySaved: boolean }>(`/api/stores/${store.id}/commands/executions/${execution.id}/save-script`, { name: execution.scriptName ?? "Inline script" }),
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions", store.id] }),
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", saved.scriptId] })
      ]);
      toast.success(saved.alreadySaved ? "Script is already in the library" : "Inline script saved to the library");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save inline script")
  });
  const agent = store.commandAgent!;
  const executions = executionData?.executions ?? [];
  const historyPagination = executionData?.pagination;
  const enrollmentById = new Map((store.enrollments ?? []).map((enrollment) => [enrollment.id, enrollment]));
  useEffect(() => {
    if (expandLatestAfterExecution && executions[0]) {
      setExpandedExecutionId(executions[0].id);
      setExpandLatestAfterExecution(false);
    }
  }, [executions, expandLatestAfterExecution]);
  const canExecute = Boolean(hostPlatform) && !execute.isPending && (executionMode === "saved" ? Boolean(selectedVersionId) : Boolean(inlineName.trim() && inlineContent.trim()));
  return <>
    <section className="command-agent-panel">
      <header><div><h3>Command agent</h3><code>{agent.endpoint}</code></div><StatusBadge status={agent.status} /></header>
      {agent.lastError && <div className="inline-alert">{agent.lastError}</div>}
      {!hostPlatform ? <div className="inline-alert">An active enrollment is required before running a script.</div> : <>
        <div className="command-mode-toggle" role="tablist" aria-label="Script source">
          <button type="button" role="tab" aria-selected={executionMode === "saved"} className={executionMode === "saved" ? "active" : ""} onClick={() => setExecutionMode("saved")}>Saved script</button>
          <button type="button" role="tab" aria-selected={executionMode === "inline"} className={executionMode === "inline" ? "active" : ""} onClick={() => setExecutionMode("inline")}>Inline script</button>
        </div>
        {executionMode === "saved" ? <div className="command-script-picker">
          <label className="field command-saved-script-field"><span className="field-label">Saved script <FieldHelp text="Search scripts compatible with the active enrollment. Management and quick-create actions are available inside the dropdown." /></span><SearchableSelect name="commandScript" value={selectedScriptId} options={pickerOptions} ariaLabel="Select saved script" emptyMessage="No compatible scripts" onValueChange={(value) => { setSelectedScriptId(value); setSelectedVersionId(""); }} actions={[
            { label: "Manage scripts", icon: <Settings2 size={14} />, onSelect: () => navigate("/scripts") },
            { label: "Create new", icon: <FilePlus2 size={14} />, onSelect: openQuickCreate }
          ]} /></label>
          <label className="field"><span className="field-label">Version <FieldHelp text="Select the exact immutable script version to execute. The execution history retains this version reference." /></span><select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>{!selectedScript?.versions.length && <option value="">No version available</option>}{selectedScript?.versions.map((version) => <option value={version.id} key={version.id}>Version {version.version}</option>)}</select></label>
        </div> : <div className="command-inline-script">
          <div className="command-inline-heading"><div><strong>Inline script</strong><span>Runs once and stays outside the library unless saved from history.</span></div></div>
          <div className="command-inline-metadata"><label className="field"><span className="field-label">Name <FieldHelp text="Identifies this one-off execution in store history. It is also used if you later save the execution to the script library." /></span><input value={inlineName} maxLength={120} onChange={(event) => setInlineName(event.target.value)} placeholder="One-off maintenance" /></label>{hostPlatform === "unix" ? <label className="field"><span className="field-label">Language</span><select aria-label="Inline script language" value={inlineLanguage} onChange={(event) => setInlineLanguage(event.target.value as typeof inlineLanguage)}><option value="bash">Bash</option><option value="sh">POSIX sh</option></select></label> : <label className="field"><span className="field-label">Language</span><input value="PowerShell" disabled /></label>}</div>
          <ScriptEditor value={inlineContent} language={inlineLanguage} height="220px" onChange={setInlineContent} />
        </div>}
        {executionMode === "saved" && selectedScript && selectedScriptVersion && <div className="command-script-preview"><header><div><strong>Script preview</strong><span>{selectedScript.name} · Version {selectedScriptVersion.version}</span></div><code>{selectedScript.language}</code></header><ScriptEditor value={selectedScriptVersion.content} language={selectedScript.language} height="220px" readOnly /></div>}
        <div className="command-execution-controls"><label className="field"><span className="field-label">Timeout (seconds) <FieldHelp text="The maximum time the command agent may let this script run before terminating it. Allowed range: 1 to 300 seconds." /></span><input type="number" min={1} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary command-execute-button" type="button" disabled={!canExecute} onClick={() => execute.mutate()}><TerminalSquare size={15} />{execute.isPending ? "Executing..." : "Execute script"}</button></div>
      </>}
      <div className="command-execution-history"><header><h4>Execution history</h4><div className="command-history-head-actions"><span>{historyPagination?.total ?? 0} run{historyPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshHistory.isPending} onClick={() => refreshHistory.mutate()}><RefreshCw size={14} className={refreshHistory.isPending ? "spin-icon" : undefined} /></button></div></header>{executions.length ? executions.map((execution: StoreCommandExecution) => {
        const enrollment = execution.enrollmentId ? enrollmentById.get(execution.enrollmentId) : undefined;
        const environment = enrollment ? enrollmentEnvironment(enrollment) : "Enrollment unavailable";
        const computerName = enrollment ? enrollmentComputerName(enrollment) : "Enrollment unavailable";
        const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : "Running";
        const scriptLabel = `${execution.scriptName ?? "Saved script"}${execution.scriptVersion ? ` v${execution.scriptVersion}` : ""}`;
        const inlineName = execution.scriptName ?? "Inline script";
        const isSaving = saveInlineExecution.isPending && saveInlineExecution.variables?.id === execution.id;
        const executionLanguage = execution.language ?? (execution.platform === "windows" ? "powershell" : "bash");
        return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={expandedExecutionId === execution.id} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(execution.id); else if (expandedExecutionId === execution.id) setExpandedExecutionId(null); }}><summary><span><StatusBadge status={execution.status} label={statusLabel} />{execution.scriptType === "inline" ? <><span className="command-execution-source-tag">inline</span>{execution.savedScriptId ? <Link className="command-execution-script-link" to={`/scripts?scriptId=${encodeURIComponent(execution.savedScriptId)}&version=1`} onClick={(event) => event.stopPropagation()}>{inlineName}</Link> : <strong className="command-execution-inline-name">{inlineName}</strong>}</> : execution.scriptId ? <Link className="command-execution-script-link" to={`/scripts?scriptId=${encodeURIComponent(execution.scriptId)}${execution.scriptVersion ? `&version=${execution.scriptVersion}` : ""}`} onClick={(event) => event.stopPropagation()}>{scriptLabel}</Link> : <strong>{scriptLabel}</strong>}<code>{computerName} · {environment}</code></span><span className="command-execution-timing"><time>{new Date(execution.startedAt).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status === "running" ? "running" : "-"}</code></span></summary>{expandedExecutionId === execution.id && <div className="command-execution-body">{execution.scriptType === "inline" && <div className="command-execution-actions">{execution.savedScriptId ? <Link className="button button-secondary button-small" to={`/scripts?scriptId=${encodeURIComponent(execution.savedScriptId)}&version=1`}><ScrollText size={14} />Open saved script</Link> : <button className="button button-secondary button-small" type="button" disabled={isSaving} onClick={() => saveInlineExecution.mutate(execution)}><Save size={14} />{isSaving ? "Saving..." : "Save script"}</button>}</div>}<ScriptEditor value={execution.script} language={executionLanguage} height="200px" readOnly />{execution.error && <div className="inline-alert">{execution.error}</div>}{execution.stdout && <div className="command-output-block"><header><strong>stdout</strong><CopyButton value={execution.stdout} label="Copy stdout" iconOnly /></header><pre>{execution.stdout}</pre></div>}{execution.stderr && <div className="command-output-block"><header><strong>stderr</strong><CopyButton value={execution.stderr} label="Copy stderr" iconOnly /></header><pre>{execution.stderr}</pre></div>}{!execution.stdout && !execution.stderr && !execution.error && <div className="quiet-empty">The script produced no output.</div>}</div>}</details>;
      }) : <div className="quiet-empty">No scripts have been executed for this store.</div>}{historyPagination && historyPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={historyPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setHistoryPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {historyPagination.page} of {historyPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={historyPagination.page >= historyPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setHistoryPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</div>
    </section>
    <Modal open={quickCreateOpen} title="Create new script" onClose={() => setQuickCreateOpen(false)} width="wide">
      <div className="command-quick-create"><div className="script-metadata-grid command-quick-create-fields"><label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown in the script picker. Names must be unique within the platform." /></span><input value={quickName} onChange={(event) => setQuickName(event.target.value)} placeholder="Store health check" /></label><label className="field"><span className="field-label">Language</span><select value={quickLanguage} onChange={(event) => setQuickLanguage(event.target.value as typeof quickLanguage)}>{hostPlatform === "windows" ? <option value="powershell">PowerShell</option> : <><option value="bash">Bash</option><option value="sh">POSIX sh</option></>}</select></label><label className="field"><span className="field-label">Description</span><input value={quickDescription} onChange={(event) => setQuickDescription(event.target.value)} placeholder="Optional description" /></label></div><ScriptEditor value={quickContent} language={quickLanguage} height="300px" onChange={setQuickContent} /><div className="form-actions"><span className="script-editor-hint">Creates version 1 and selects it for this run</span><button className="button button-primary" type="button" disabled={!quickName.trim() || !quickContent.trim() || quickCreate.isPending} onClick={() => quickCreate.mutate()}><Save size={15} />{quickCreate.isPending ? "Saving..." : "Save script"}</button></div></div>
    </Modal>
  </>;
}

function EditConnectivityPanel({ store, onClose }: { store: Store; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [publications, setPublications] = useState<DraftPublication[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    setPublications(store?.publications.map((publication) => ({
      key: publication.id,
      suffix: publication.suffix,
      routes: publication.routes.map((route) => ({ key: route.id, path: route.path, serviceUrl: route.serviceUrl, kind: route.kind ?? "service" }))
    })) ?? []);
  }, [store.id]);
  const mutation = useMutation({
    mutationFn: () => api.put<{ success: boolean; applied: boolean }>(`/api/stores/${store!.id}/connectivity`, { publications: connectivityPayload(publications) }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] })
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
  return <section className="store-drawer-section connectivity-inline-editor">
    <header className="store-section-heading"><div><h3>Edit connectivity</h3><span>{store.displayName} · update published subdomains and ingress paths</span></div><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button></header>
    {error && <div className="form-error">{error}</div>}
    <div className="connectivity-scope"><div><span>Cloudflare account</span><strong>{store.accountName}</strong></div><div><span>DNS zone</span><strong>{store.zoneName}</strong></div><div><span>Tunnel</span><strong className="mono">{store.tunnelId ?? "Pending installation"}</strong></div></div>
    <ConnectivityEditor storeId={store.storeCode} zoneName={store.zoneName} publications={publications} onChange={setPublications} />
    <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={save} disabled={mutation.isPending}>{mutation.isPending ? "Updating..." : "Save connectivity"}</button></div>
  </section>;
}

function RouteWafDialog({ store, route, onClose }: { store: Store | null; route: StoreRoute | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(true);
  const [allowedIps, setAllowedIps] = useState("");
  const [error, setError] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["route-waf", store?.id, route?.id],
    queryFn: () => api.get<{ waf: { enabled: boolean; allowedIps: string[]; defaulted: boolean } }>(`/api/stores/${store!.id}/routes/${route!.id}/waf`),
    enabled: Boolean(store && route)
  });
  useEffect(() => {
    if (!route) return;
    setEnabled(route.wafEnabled);
    setAllowedIps(route.wafAllowedIps.join("\n"));
    setError("");
  }, [route]);
  useEffect(() => {
    if (!data?.waf) return;
    setEnabled(data.waf.enabled);
    setAllowedIps(data.waf.allowedIps.join("\n"));
  }, [data]);
  const mutation = useMutation({
    mutationFn: () => api.patch<{ waf: { enabled: boolean; allowedIps: string[] } }>(`/api/stores/${store!.id}/routes/${route!.id}/waf`, {
      enabled,
      allowedIps: allowedIps.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean)
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] }),
        queryClient.invalidateQueries({ queryKey: ["stores"] }),
        queryClient.invalidateQueries({ queryKey: ["route-waf", store?.id, route?.id] })
      ]);
      toast.success("Route WAF updated");
      onClose();
    },
    onError: (requestError) => setError(requestError instanceof Error ? requestError.message : "Unable to update route WAF")
  });
  return <Modal open={Boolean(store && route)} title={`Route WAF · ${route?.path ?? ""}`} onClose={onClose}>
    {route && <div className="route-waf-dialog">
      {error && <div className="form-error">{error}</div>}
      {isLoading ? <div className="quiet-empty">Loading WAF policy...</div> : <>
        <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>Allow-list protection</strong><small>When enabled, Cloudflare blocks every source IP except the addresses below.</small></span></label>
        <label className="field"><span className="field-label">Allowed Cloudflare Man IPs or CIDRs <FieldHelp text="Use one public IPv4, IPv6, or CIDR per line. Leave the list unchanged to use the server's configured Cloudflare Man source IP. Never use 0.0.0.0/0 unless this route is intentionally public." /></span><textarea value={allowedIps} onChange={(event) => setAllowedIps(event.target.value)} rows={4} placeholder="203.0.113.10/32" disabled={!enabled} /></label>
        {data?.waf.defaulted && <div className="inline-alert"><ShieldCheck size={15} />The addresses were resolved from CFMAN_WAF_ALLOWED_IPS or the Cloudflare Man server's public IP.</div>}
      </>}
      <div className="form-actions"><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="button" onClick={() => mutation.mutate()} disabled={isLoading || mutation.isPending}>{mutation.isPending ? "Updating..." : "Save WAF policy"}</button></div>
    </div>}
  </Modal>;
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
  const cleanupCommands = result.unenrollCommands ?? [];
  const commandFor = (urls: { shell: string; powershell: string }) => {
    const powershell = withCurrentBaseUrl(urls.powershell);
    const shell = withCurrentBaseUrl(urls.shell);
    return platform === "windows" ? `irm '${powershell}' | iex` : `curl -fsSL '${shell}' | sudo bash`;
  };
  return <div className="enrollment-command-stack">
    {cleanupCommands.length > 0 && <div className="unenroll-command-panel"><div className="command-note"><ShieldAlert size={14} />A running tunnel instance was found. Run the cleanup command on the old store machine before installing this new link.</div>{cleanupCommands.map((cleanup) => { const cleanupCommand = commandFor(cleanup.urls); return <div className="command-section" key={cleanup.enrollmentId}><div className="command-head"><strong>Unenroll instance created {new Date(cleanup.createdAt).toLocaleString()}</strong><CopyButton value={cleanupCommand} label="Copy cleanup command" /></div><pre><code>{cleanupCommand}</code></pre>{platform === "windows" && <div className="command-note"><ShieldAlert size={14} />Run PowerShell as Administrator.</div>}<div className="expiry-line">Cleanup link expires {new Date(cleanup.expiresAt).toLocaleString()}</div></div>; })}</div>}
    <div className="command-section"><div className="command-head"><div className="segmented compact"><button type="button" className={platform === "windows" ? "active" : ""} onClick={() => setPlatform("windows")}>PowerShell</button><button type="button" className={platform === "unix" ? "active" : ""} onClick={() => setPlatform("unix")}>Bash</button></div><CopyButton value={command} label="Copy command" /></div><pre><code>{command}</code></pre>{platform === "windows" && <div className="command-note"><ShieldAlert size={14} />Run PowerShell as Administrator.</div>}<div className="expiry-line">Expires {new Date(result.expiresAt).toLocaleString()}</div></div>
  </div>;
}

function UnenrollmentCommands({ result }: { result: UnenrollmentResult }) {
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
  return <div className="unenroll-command-panel"><div className="command-note"><ShieldAlert size={14} />Run this cleanup command on the connected store machine. It expires {new Date(result.expiresAt).toLocaleString()}.</div><div className="command-head"><div className="segmented compact"><button type="button" className={platform === "windows" ? "active" : ""} onClick={() => setPlatform("windows")}>PowerShell</button><button type="button" className={platform === "unix" ? "active" : ""} onClick={() => setPlatform("unix")}>Bash</button></div><CopyButton value={command} label="Copy unenroll command" /></div><pre><code>{command}</code></pre>{platform === "windows" && <div className="command-note"><ShieldAlert size={14} />Run PowerShell as Administrator.</div>}</div>;
}
