import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, FilePlus2, RefreshCw, Save, Search, TerminalSquare, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../api";
import { CopyButton } from "../components/CopyButton";
import { ExecutionStatsSummary } from "../components/ExecutionStatsSummary";
import { FieldHelp } from "../components/FieldHelp";
import { HostPlatformIcon } from "../components/HostPlatformIcon";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { SearchableSelect } from "../components/SearchableSelect";
import { ScriptEditor } from "../components/ScriptEditor";
import { StatusBadge } from "../components/StatusBadge";
import type { ExecutionStats, ManagedScript, ManagedScriptSummary, ScriptCommandExecution, Store } from "../types";
import { StoreDrawer, type StoreDrawerTab } from "./StoresPage";

const defaultContent = {
  windows: "Write-Output \"Store: $env:COMPUTERNAME\"\n",
  unix: "printf 'Store: %s\\n' \"$(hostname)\"\n"
};

const platformFilterOptions = [
  { value: "", label: "All platforms" },
  { value: "windows", label: "Windows" },
  { value: "unix", label: "Unix" }
];

type ScriptExecutionPage = {
  scriptId: string;
  version: number | null;
  executions: ScriptCommandExecution[];
  summary: ExecutionStats;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

type ScriptListPage = {
  scripts: ManagedScriptSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export function ScriptsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedScriptId = searchParams.get("scriptId");
  const linkedVersion = Number(searchParams.get("version"));
  const [nameFilter, setNameFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"" | "windows" | "unix">("");
  const [scriptPage, setScriptPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(linkedScriptId);
  const [draft, setDraft] = useState(false);
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<"windows" | "unix">("windows");
  const [language, setLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState(defaultContent.windows);
  const [originalContent, setOriginalContent] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [executionPage, setExecutionPage] = useState(1);
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null);
  const [drawerStore, setDrawerStore] = useState<Store | null>(null);
  const [drawerTab, setDrawerTab] = useState<StoreDrawerTab>("connect");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const scriptPageSize = 12;
  const scriptParams = new URLSearchParams({ page: String(scriptPage), pageSize: String(scriptPageSize) });
  if (nameFilter.trim()) scriptParams.set("name", nameFilter.trim());
  if (platformFilter) scriptParams.set("platform", platformFilter);
  const { data, isLoading } = useQuery({
    queryKey: ["scripts", nameFilter, platformFilter, scriptPage, scriptPageSize],
    queryFn: () => api.get<ScriptListPage>(`/api/scripts?${scriptParams.toString()}`)
  });
  const { data: detailData } = useQuery({
    queryKey: ["script-detail", selectedId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  const scripts = data?.scripts ?? [];
  const scriptPagination = data?.pagination;
  const detail = detailData?.script;
  const selectedVersionData = useMemo(() => detail?.versions.find((version) => version.version === selectedVersion) ?? detail?.versions[0], [detail, selectedVersion]);
  const executionPageSize = 10;
  const { data: executionData, isFetching: executionsFetching } = useQuery({
    queryKey: ["script-executions", selectedId, selectedVersion, executionPage, executionPageSize],
    queryFn: () => api.get<ScriptExecutionPage>(`/api/scripts/${selectedId}/executions?version=${selectedVersion}&page=${executionPage}&pageSize=${executionPageSize}`),
    enabled: Boolean(selectedId && selectedVersion && !draft),
    refetchInterval: (query) => query.state.data?.executions.some((execution) => execution.status === "running") ? 2000 : false
  });

  useEffect(() => {
    setExecutionPage(1);
    setExpandedExecutionId(null);
  }, [selectedId, selectedVersion]);

  useEffect(() => setScriptPage(1), [nameFilter, platformFilter]);

  useEffect(() => {
    if (!linkedScriptId) return;
    setDraft(false);
    setSelectedId(linkedScriptId);
  }, [linkedScriptId]);

  useEffect(() => {
    if (!detail || draft) return;
    const requestedVersion = linkedScriptId === detail.id && Number.isInteger(linkedVersion)
      ? detail.versions.find((version) => version.version === linkedVersion)
      : undefined;
    const initialVersion = requestedVersion ?? detail.versions[0];
    setName(detail.name);
    setPlatform(detail.platform);
    setLanguage(detail.language);
    setDescription(detail.description);
    setSelectedVersion(initialVersion?.version ?? null);
    setContent(initialVersion?.content ?? "");
    setOriginalContent(initialVersion?.content ?? "");
  }, [detail, draft, linkedScriptId, linkedVersion]);

  useEffect(() => {
    if (draft) setContent(defaultContent[platform]);
  }, [draft, platform]);

  useEffect(() => {
    if (!draft && selectedVersionData) {
      setContent(selectedVersionData.content);
      setOriginalContent(selectedVersionData.content);
    }
  }, [draft, selectedVersionData]);

  const openNew = () => {
    setSearchParams({}, { replace: true });
    setSelectedId(null);
    setDraft(true);
    setName("");
    setPlatform("windows");
    setLanguage("powershell");
    setDescription("");
    setContent(defaultContent.windows);
    setOriginalContent("");
    setSelectedVersion(null);
  };
  const selectScript = (script: ManagedScriptSummary) => {
    setSearchParams({ scriptId: script.id }, { replace: true });
    setDraft(false);
    setSelectedId(script.id);
  };
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/scripts", { name, platform, language, description, content }),
    onSuccess: async (result) => {
      setDraft(false);
      setSelectedId(result.id);
      setSearchParams({ scriptId: result.id }, { replace: true });
      await queryClient.invalidateQueries({ queryKey: ["scripts"] });
      toast.success("Script created");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to create script")
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!selectedId) throw new Error("Select a script first");
      await api.patch(`/api/scripts/${selectedId}`, { name, language, description });
      if (content !== originalContent) await api.post(`/api/scripts/${selectedId}/versions`, { content });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", selectedId] })
      ]);
      toast.success(content !== originalContent ? "Script version saved" : "Script details saved");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save script")
  });
  const deleteScript = useMutation({
    mutationFn: () => api.delete<{ success: boolean; scriptId: string; scriptName: string; deletedExecutionCount: number }>(`/api/scripts/${selectedId}`),
    onSuccess: async (result) => {
      setDeleteOpen(false);
      setSelectedId(null);
      setSelectedVersion(null);
      setExpandedExecutionId(null);
      setDraft(false);
      setScriptPage(1);
      setSearchParams({}, { replace: true });
      queryClient.removeQueries({ queryKey: ["script-detail", result.scriptId] });
      queryClient.removeQueries({ queryKey: ["script-executions", result.scriptId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["store-detail"] })
      ]);
      toast.success(`${result.scriptName} deleted with ${result.deletedExecutionCount} execution record${result.deletedExecutionCount === 1 ? "" : "s"}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete script")
  });
  const refresh = useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["scripts"], type: "active" }),
        queryClient.refetchQueries({ queryKey: ["script-detail"], type: "active" })
      ]);
    },
    onSuccess: () => toast.success("Script library refreshed"),
    onError: () => toast.error("Unable to refresh script library")
  });
  const refreshExecutions = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["script-executions", selectedId, selectedVersion], type: "active" }),
    onError: () => toast.error("Unable to refresh script execution history")
  });
  const openStoreDrawer = useMutation({
    mutationFn: (storeId: string) => api.get<{ store: Store }>(`/api/stores/${storeId}`),
    onSuccess: ({ store }) => {
      setDrawerTab("connect");
      setDrawerStore(store);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to open store")
  });
  const languageOptions = platform === "windows" ? [{ value: "powershell", label: "PowerShell" }] : [{ value: "bash", label: "Bash" }, { value: "sh", label: "POSIX sh" }];
  const active = Boolean(draft || selectedId);
  const executions = executionData?.executions ?? [];
  const executionPagination = executionData?.pagination;
  const executionSummary = executionData?.summary ?? { total: 0, succeeded: 0, failed: 0, timedOut: 0, running: 0 };
  return <><div className="page">
    <PageHeader title="Script library" eyebrow="Versioned store automation" actions={<><button className="button button-secondary" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button><button className="button button-primary" type="button" onClick={openNew}><FilePlus2 size={16} />New script</button></>} />
    <div className="scripts-layout">
      <section className="panel script-list-panel">
        <div className="script-list-toolbar"><label className="search-box"><Search size={15} /><input value={nameFilter} onChange={(event) => setNameFilter(event.target.value)} placeholder="Search script names" /></label><div className="script-platform-filter"><SearchableSelect name="platformFilter" options={platformFilterOptions} ariaLabel="Filter scripts by platform" emptyMessage="No matching platforms" onValueChange={(value) => setPlatformFilter(value as typeof platformFilter)} /></div><span>{scriptPagination?.total ?? 0} script{scriptPagination?.total === 1 ? "" : "s"}</span></div>
        {isLoading ? <div className="quiet-empty">Loading scripts...</div> : scripts.length ? <div className="script-list">{scripts.map((script) => <button className={`script-list-item ${selectedId === script.id && !draft ? "active" : ""}`} key={script.id} type="button" onClick={() => selectScript(script)}><span className="script-list-icon"><HostPlatformIcon platform={script.platform} size={16} /></span><span><strong>{script.name}</strong><span className="script-list-meta"><small>{script.versionCount} version{script.versionCount === 1 ? "" : "s"}</small><ExecutionStatsSummary stats={script.executionStats} compact /></span></span></button>)}</div> : <div className="quiet-empty">No scripts saved yet.</div>}
        {scriptPagination && scriptPagination.total > 0 && <div className="script-list-pagination"><button className="icon-button" type="button" title="Previous script page" aria-label="Previous script page" disabled={scriptPagination.page <= 1} onClick={() => setScriptPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} /></button><span>Page {scriptPagination.page} of {scriptPagination.totalPages}</span><button className="icon-button" type="button" title="Next script page" aria-label="Next script page" disabled={scriptPagination.page >= scriptPagination.totalPages} onClick={() => setScriptPage((page) => page + 1)}><ChevronRight size={15} /></button></div>}
      </section>
      <section className="panel script-editor-panel">
        {!active ? <div className="script-empty-state"><TerminalSquare size={26} /><strong>Select a script or create one</strong></div> : <>
          <header className="script-editor-header"><div><h2>{draft ? "New script" : name}</h2><span>{draft ? "Version 1" : `Version ${selectedVersion ?? detail?.latestVersion ?? "-"}`}</span></div>{!draft && detail && <select value={selectedVersion ?? detail.versions[0]?.version ?? ""} onChange={(event) => { const version = Number(event.target.value); setSelectedVersion(version); setSearchParams({ scriptId: detail.id, version: String(version) }, { replace: true }); }} aria-label="Script version">{detail.versions.map((version) => <option value={version.version} key={version.id}>Version {version.version}</option>)}</select>}</header>
          <div className="script-metadata-grid"><label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a store. Names must be unique within the same platform." /></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Inventory refresh" /></label><label className="field"><span className="field-label">Platform <FieldHelp text="The host family this script can run on. Windows scripts use PowerShell; Unix scripts can use Bash or POSIX sh. The platform cannot change after creation." /></span><select value={platform} disabled={!draft} onChange={(event) => { const next = event.target.value as "windows" | "unix"; setPlatform(next); setLanguage(next === "windows" ? "powershell" : "bash"); }}><option value="windows">Windows</option><option value="unix">Unix</option></select></label><label className="field"><span className="field-label">Language <FieldHelp text="Controls syntax highlighting and identifies the shell expected on the enrolled host." /></span><select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{languageOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="field"><span className="field-label">Description <FieldHelp text="Optional operator-facing context about the script's purpose, prerequisites, or expected effect." /></span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description" /></label></div>
          <ScriptEditor value={content} language={language} readOnly={!draft && selectedVersionData?.version !== detail?.latestVersion} onChange={setContent} />
          <div className="form-actions script-editor-actions">{!draft && <button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete script</button>}<span className="script-editor-hint">{draft ? "Creates version 1" : content !== originalContent ? `Creates version ${(detail?.latestVersion ?? 0) + 1}` : "No content changes"}</span><button className="button button-primary" type="button" disabled={!name.trim() || !content.trim() || create.isPending || save.isPending || deleteScript.isPending} onClick={() => draft ? create.mutate() : save.mutate()}><Save size={15} />{draft ? "Create script" : "Save changes"}</button></div>
          {!draft && selectedId && selectedVersion && <section className="script-execution-history"><header><div><h3>Execution history</h3><span>Script {name} · Version {selectedVersion}</span></div><div className="command-history-head-actions"><ExecutionStatsSummary stats={executionSummary} /><span>{executionPagination?.total ?? 0} run{executionPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshExecutions.isPending || executionsFetching} onClick={() => refreshExecutions.mutate()}><RefreshCw size={14} className={refreshExecutions.isPending || executionsFetching ? "spin-icon" : undefined} /></button></div></header>{executions.length ? <div className="script-execution-list">{executions.map((execution) => {
            const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : "Running";
            const environment = scriptExecutionEnvironment(execution);
            const executionLanguage = execution.language ?? (execution.platform === "windows" ? "powershell" : "bash");
            return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={expandedExecutionId === execution.id} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(execution.id); else if (expandedExecutionId === execution.id) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} label={statusLabel} /><button className="script-execution-store-link" type="button" disabled={openStoreDrawer.isPending && openStoreDrawer.variables === execution.storeId} onClick={(event) => { event.preventDefault(); event.stopPropagation(); openStoreDrawer.mutate(execution.storeId); }}>{execution.storeDisplayName}</button><code className="command-execution-store-code">{execution.tenantCode} / {execution.storeCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(execution.startedAt).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status === "running" ? "running" : "-"}</code></span></summary>{expandedExecutionId === execution.id && <div className="command-execution-body"><ScriptEditor value={execution.script} language={executionLanguage} height="200px" readOnly />{execution.error && <div className="inline-alert">{execution.error}</div>}{execution.stdout && <div className="command-output-block"><header><strong>stdout</strong><CopyButton value={execution.stdout} label="Copy stdout" iconOnly /></header><pre>{execution.stdout}</pre></div>}{execution.stderr && <div className="command-output-block"><header><strong>stderr</strong><CopyButton value={execution.stderr} label="Copy stderr" iconOnly /></header><pre>{execution.stderr}</pre></div>}{!execution.stdout && !execution.stderr && !execution.error && <div className="quiet-empty">The script produced no output.</div>}</div>}</details>;
          })}</div> : <div className="quiet-empty">This script version has not been executed.</div>}{executionPagination && executionPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={executionPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {executionPagination.page} of {executionPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={executionPagination.page >= executionPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</section>}
        </>}
      </section>
    </div>
  </div><Modal open={deleteOpen} title={`Delete script · ${name}`} onClose={() => setDeleteOpen(false)}><div className="delete-confirmation"><div className="inline-alert"><AlertTriangle size={15} />This permanently deletes the saved script, every version, and all related execution history. This action cannot be undone.</div><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => deleteScript.mutate()}><Trash2 size={15} />{deleteScript.isPending ? "Deleting..." : "Delete permanently"}</button></div></div></Modal><StoreDrawer store={drawerStore} tab={drawerTab} onTabChange={setDrawerTab} onClose={() => setDrawerStore(null)} /></>;
}

function scriptExecutionEnvironment(execution: ScriptCommandExecution): string {
  switch (execution.environment ?? execution.enrollmentPlatform) {
    case "windows": return "Windows";
    case "linux": return "Linux";
    case "darwin": return "macOS";
    case "unix": return "Unix";
    default: return "Not detected";
  }
}
