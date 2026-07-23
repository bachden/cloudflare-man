import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Copy, ExternalLink, Monitor, MonitorUp, MoreHorizontal, Plus, RefreshCw, ScrollText, Search, Settings2, ShieldAlert, TerminalSquare, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { ConnectivityEditor, connectivityPayload, validatePublications, type DraftPublication } from "../components/ConnectivityEditor";
import { CopyButton } from "../components/CopyButton";
import { FieldHelp } from "../components/FieldHelp";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import type { AppSettings, EnrollmentResult, ManagedScript, ManagedScriptSummary, Store, StoreCommandExecution, StoreDeletePreflight, StoreEnrollment } from "../types";

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
  const [logEnrollment, setLogEnrollment] = useState<StoreEnrollment | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePreflight, setDeletePreflight] = useState<StoreDeletePreflight | null>(null);
  const [deleteName, setDeleteName] = useState("");
  const { data: detailData } = useQuery({
    queryKey: ["store-detail", store?.id],
    queryFn: () => api.get<{ store: Store }>(`/api/stores/${store!.id}`),
    enabled: Boolean(store),
    refetchInterval: (query) => query.state.data?.store.commandExecutions?.some((execution) => execution.status === "running") ? 2000 : false
  });
  const currentStore = detailData?.store ?? store;
  const { data: logData, isLoading: logsLoading } = useQuery({
    queryKey: ["enrollment-logs", store?.id, logEnrollment?.id],
    queryFn: () => api.get<{ logs: Array<{ id: number; level: string; step: string | null; message: string; metadata: Record<string, unknown>; createdAt: string }> }>(`/api/stores/${store!.id}/enrollments/${logEnrollment!.id}/logs`),
    enabled: Boolean(store && logEnrollment)
  });
  const mutation = useMutation({
    mutationFn: () => api.post<EnrollmentResult>(`/api/stores/${store!.id}/enrollments`, { expiresInHours: 24 }),
    onSuccess: async (result) => { setEnrollment(result); toast.success("Enrollment URL issued"); await queryClient.invalidateQueries({ queryKey: ["stores"] }); await queryClient.invalidateQueries({ queryKey: ["store-detail", store?.id] }); },
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
  const close = () => { setEnrollment(null); setLogEnrollment(null); setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); onClose(); };
  const canRevoke = ["url_issued", "claimed", "provisioning", "failed"].includes(currentStore?.onboardingStatus ?? "");
  return (
    <>
    <Modal open={Boolean(store)} title={currentStore?.displayName ?? "Store details"} onClose={close} width="wide">
      {currentStore && <div className="detail-layout">
        <dl className="detail-list">
          <div><dt>Store code</dt><dd>{currentStore.tenantCode} / {currentStore.storeCode}</dd></div>
          <div><dt>Hostname</dt><dd className="mono">{currentStore.hostname}</dd></div>
          <div><dt>Origin</dt><dd className="mono">{currentStore.originUrl}</dd></div>
          <div><dt>Account</dt><dd>{currentStore.accountName}</dd></div>
          <div><dt>Zone</dt><dd>{currentStore.zoneName}</dd></div>
          <div><dt>Tunnel ID</dt><dd className="mono">{currentStore.tunnelId ?? "Not provisioned"}</dd></div>
          <div><dt>RDP target</dt><dd className="mono">{currentStore.rdpTargetIp ? `${currentStore.rdpTargetIp}:3389` : "Awaiting Windows installer"}</dd></div>
          <div><dt>RDP gateway</dt><dd className="mono">{currentStore.rdpUrl ? new URL(currentStore.rdpUrl).hostname : "Not provisioned"}</dd></div>
        </dl>
        <div className="detail-status">
          <div><span>Onboarding</span><StatusBadge status={currentStore.onboardingStatus} /></div>
          <div><span>Tunnel</span><StatusBadge status={currentStore.tunnelStatus} /></div>
          <div><span>RDP</span><StatusBadge status={currentStore.rdpStatus} /></div>
        </div>
        <section className="publication-summary"><header><h3>Published endpoints</h3><span>{currentStore.publications.length} hostname{currentStore.publications.length === 1 ? "" : "s"}</span></header>{currentStore.publications.map((publication) => <div className="publication-summary-item" key={publication.id}><div><code>{publication.hostname}</code><StatusBadge status={publication.status} />{currentStore.tunnelStatus === "healthy" && <a className="copy-icon" href={`https://${publication.hostname}`} target="_blank" rel="noreferrer" title="Open endpoint"><ExternalLink size={14} /></a>}</div>{publication.routes.map((route) => <div className="publication-route" key={route.id}><code>{route.path}</code><span>→</span><code>{route.kind === "command_agent" ? "Cloudflare Man command agent" : route.serviceUrl}</code></div>)}</div>)}</section>
        {currentStore.rdpLastError && <div className="inline-alert">{currentStore.rdpLastError}</div>}
        <EnrollmentHistory enrollments={currentStore.enrollments ?? []} onViewLog={setLogEnrollment} />
        {currentStore.commandAgent && <CommandExecutionPanel store={currentStore} />}
        {enrollment ? <EnrollmentCommands result={enrollment} /> : <div className="detail-actions">
          <button className="button button-secondary" onClick={() => onEditConnectivity(currentStore)}><Settings2 size={15} />Edit connectivity</button>
          <button className="button button-primary" onClick={() => mutation.mutate()} disabled={mutation.isPending}><TerminalSquare size={16} />{mutation.isPending ? "Issuing..." : "Issue install URL"}</button>
          {currentStore.rdpStatus === "ready" && currentStore.rdpUrl && <a className="button button-primary" href={currentStore.rdpUrl} target="_blank" rel="noreferrer"><MonitorUp size={16} />Remote desktop</a>}
          {currentStore.rdpTargetIp && currentStore.rdpStatus !== "ready" && <button className="button button-secondary" onClick={() => retryRdp.mutate()} disabled={retryRdp.isPending}><RefreshCw size={15} />{retryRdp.isPending ? "Retrying..." : "Retry RDP"}</button>}
          <button className="button button-secondary" onClick={() => verify.mutate()} disabled={verify.isPending}><CheckCircle2 size={15} />{verify.isPending ? "Checking..." : "Verify endpoint"}</button>
          {canRevoke && <button className="button button-danger" onClick={() => { if (window.confirm("Revoke this enrollment URL?")) revoke.mutate(); }} disabled={revoke.isPending}><ShieldAlert size={15} />Revoke</button>}
          {currentStore.tunnelStatus === "healthy" && <a className="button button-secondary" href={`https://${currentStore.hostname}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open endpoint</a>}
          <button className="button button-danger" onClick={openDelete} disabled={deletePreflightMutation.isPending || deleteStore.isPending}><Trash2 size={15} />Delete store</button>
        </div>}
      </div>}
    </Modal>
    <StoreDeleteDialog open={deleteOpen} preflight={deletePreflight} loading={deletePreflightMutation.isPending} confirmationName={deleteName} onConfirmationNameChange={setDeleteName} onClose={() => { setDeleteOpen(false); setDeletePreflight(null); setDeleteName(""); }} onConfirm={() => deleteStore.mutate()} deleting={deleteStore.isPending} />
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

function EnrollmentHistory({ enrollments, onViewLog }: { enrollments: StoreEnrollment[]; onViewLog: (enrollment: StoreEnrollment) => void }) {
  return <section className="enrollment-history"><header><h3>Enrollment history</h3><span>{enrollments.length} attempt{enrollments.length === 1 ? "" : "s"}</span></header>{enrollments.length ? <div className="enrollment-history-list">{enrollments.map((enrollment) => {
    const runStatus = enrollmentRunStatus(enrollment);
    const environment = enrollmentEnvironment(enrollment);
    return <div className="enrollment-history-row" key={enrollment.id}>
      <div className="enrollment-history-field"><span className="enrollment-history-label">Run status</span><StatusBadge status={runStatus} /></div>
      <div className="enrollment-history-field"><span className="enrollment-history-label">Environment</span><span className="enrollment-environment"><Monitor size={15} />{environment}</span></div>
      <button className="button button-secondary enrollment-log-button" type="button" onClick={() => onViewLog(enrollment)}><ScrollText size={15} />View log</button>
    </div>;
  })}</div> : <div className="quiet-empty">No enrollment links have been issued for this store.</div>}</section>;
}

function enrollmentRunStatus(enrollment: StoreEnrollment): "never_run" | "running" | "success" | "failed" {
  const installScripts = enrollment.scripts.filter((script) => script.kind === "install");
  if (installScripts.some((script) => script.status === "failed") || enrollment.status === "failed") return "failed";
  if (installScripts.some((script) => script.status === "running") || ["claimed", "provisioning", "ready"].includes(enrollment.status)) return "running";
  if (installScripts.some((script) => script.status === "completed") || enrollment.status === "installed") return "success";
  return "never_run";
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
  scriptVersionId: string;
  scriptName: string;
  version: number;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

function CommandExecutionPanel({ store }: { store: Store }) {
  const queryClient = useQueryClient();
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [result, setResult] = useState<CommandExecutionResult | null>(null);
  const activeEnrollment = [...(store.enrollments ?? [])].filter((enrollment) => ["ready", "installed"].includes(enrollment.status) && enrollment.unenrolledAt === null).sort((left, right) => new Date(right.installedAt ?? right.createdAt).getTime() - new Date(left.installedAt ?? left.createdAt).getTime())[0];
  const hostPlatform = activeEnrollment?.platform ?? null;
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
  const scriptOptions = scriptData?.scripts ?? [];
  useEffect(() => {
    if (!selectedScriptId && scriptOptions[0]) setSelectedScriptId(scriptOptions[0].id);
  }, [scriptOptions, selectedScriptId]);
  useEffect(() => {
    if (selectedScript && selectedScript.versions[0] && !selectedScript.versions.some((version) => version.id === selectedVersionId)) setSelectedVersionId(selectedScript.versions[0].id);
  }, [selectedScript, selectedVersionId]);
  const execute = useMutation({
    mutationFn: () => api.post<CommandExecutionResult>(`/api/stores/${store.id}/commands/execute`, {
      scriptVersionId: selectedVersionId,
      timeoutMs: timeoutSeconds * 1_000
    }),
    onSuccess: async (response) => {
      setResult(response);
      await queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] });
      if (response.success) toast.success("Script completed successfully");
      else toast.error(`Script exited with code ${response.exitCode ?? "timeout"}`);
    },
    onError: async (error) => { await queryClient.invalidateQueries({ queryKey: ["store-detail", store.id] }); toast.error(error instanceof Error ? error.message : "Unable to execute script"); }
  });
  const agent = store.commandAgent!;
  const executions = store.commandExecutions ?? [];
  return <section className="command-agent-panel">
    <header><div><h3>Command agent</h3><code>{agent.endpoint}</code></div><StatusBadge status={agent.status} /></header>
    {agent.lastError && <div className="inline-alert">{agent.lastError}</div>}
    {!hostPlatform ? <div className="inline-alert">An active enrollment is required before running a saved script.</div> : <div className="command-script-picker"><label className="field"><span className="field-label">Saved script <FieldHelp text="Only scripts compatible with the platform reported by this store's active enrollment are listed." /></span><select value={selectedScriptId} onChange={(event) => { setSelectedScriptId(event.target.value); setSelectedVersionId(""); }}>{scriptOptions.length === 0 && <option value="">No compatible scripts</option>}{scriptOptions.map((script) => <option value={script.id} key={script.id}>{script.name} · {script.platform}</option>)}</select></label><label className="field"><span className="field-label">Version <FieldHelp text="Select the exact immutable script version to execute. The execution history retains this version reference." /></span><select value={selectedVersionId} onChange={(event) => setSelectedVersionId(event.target.value)}>{!selectedScript?.versions.length && <option value="">No version available</option>}{selectedScript?.versions.map((version) => <option value={version.id} key={version.id}>Version {version.version}</option>)}</select></label><Link className="text-link" to="/scripts">Manage scripts</Link></div>}
    <div className="command-agent-controls"><label className="field"><span className="field-label">Timeout (seconds) <FieldHelp text="The maximum time the command agent may let this script run before terminating it. Allowed range: 1 to 300 seconds." /></span><input type="number" min={1} max={300} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Math.min(300, Math.max(1, Number(event.target.value) || 1)))} /></label><button className="button button-primary" type="button" disabled={!selectedVersionId || execute.isPending || !hostPlatform} onClick={() => execute.mutate()}><TerminalSquare size={15} />{execute.isPending ? "Executing..." : "Execute script"}</button></div>
    {result && <div className="command-result"><header><StatusBadge status={result.success ? "completed" : "failed"} /><span>Exit {result.exitCode ?? "timeout"} · {result.durationMs} ms</span></header>{result.stdout && <div><strong>stdout</strong><pre>{result.stdout}</pre></div>}{result.stderr && <div><strong>stderr</strong><pre>{result.stderr}</pre></div>}{!result.stdout && !result.stderr && <div className="quiet-empty">The script produced no output.</div>}</div>}
    <div className="command-execution-history"><header><h4>Execution history</h4><span>{executions.length} run{executions.length === 1 ? "" : "s"}</span></header>{executions.length ? executions.map((execution: StoreCommandExecution) => <details className="command-execution" key={execution.id}><summary><span><StatusBadge status={execution.status} /><code>{execution.scriptName ?? "Saved script"} {execution.scriptVersion ? `v${execution.scriptVersion}` : ""} · {new Date(execution.startedAt).toLocaleString()}</code></span><span>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status === "running" ? "running" : "-"}</span></summary><div className="command-execution-body"><code>{execution.enrollmentId ? `Enrollment ${execution.enrollmentId}` : "Enrollment unavailable"}</code><code>{execution.script}</code>{execution.error && <div className="inline-alert">{execution.error}</div>}{execution.stdout && <div><strong>stdout</strong><pre>{execution.stdout}</pre></div>}{execution.stderr && <div><strong>stderr</strong><pre>{execution.stderr}</pre></div>}{!execution.stdout && !execution.stderr && !execution.error && <div className="quiet-empty">The script produced no output.</div>}</div></details>) : <div className="quiet-empty">No scripts have been executed for this store.</div>}</div>
  </section>;
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
      routes: publication.routes.map((route) => ({ key: route.id, path: route.path, serviceUrl: route.serviceUrl, kind: route.kind ?? "service" }))
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
