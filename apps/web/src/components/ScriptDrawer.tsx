import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import type { ExecutionStats, ManagedScript, ScriptCommandExecution } from "../types";
import { CopyButton } from "./CopyButton";
import { useDrawers } from "./DrawerContext";
import { ExecutionStatsSummary } from "./ExecutionStatsSummary";
import { FieldHelp } from "./FieldHelp";
import { HostPlatformIcon } from "./HostPlatformIcon";
import { Modal } from "./Modal";
import { ScriptEditor } from "./ScriptEditor";
import { SideDrawer } from "./SideDrawer";
import { StatusBadge } from "./StatusBadge";

export function scriptRunStatus(stats: ExecutionStats): string {
  if (stats.running > 0) return "running";
  if (stats.total === 0) return "never_run";
  if (stats.failed > 0 || stats.timedOut > 0) return "failed";
  return "succeeded";
}

type ScriptExecutionPage = {
  scriptId: string;
  version: number | null;
  executions: ScriptCommandExecution[];
  summary: ExecutionStats;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
};

export function ScriptDrawer({ scriptId, version, onClose, zIndex }: { scriptId: string | null; version: number | null; onClose: () => void; zIndex?: number | undefined }) {
  const queryClient = useQueryClient();
  const { openStoreDrawer } = useDrawers();
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [executionPage, setExecutionPage] = useState(1);
  const [expandedExecutionId, setExpandedExecutionId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data: detailData } = useQuery({
    queryKey: ["script-detail", scriptId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${scriptId}`),
    enabled: Boolean(scriptId)
  });
  const detail = detailData?.script;
  const selectedVersionData = useMemo(() => detail?.versions.find((entry) => entry.version === selectedVersion) ?? detail?.versions[0], [detail, selectedVersion]);

  const executionPageSize = 10;
  const { data: executionData, isFetching: executionsFetching } = useQuery({
    queryKey: ["script-executions", scriptId, selectedVersion, executionPage, executionPageSize],
    queryFn: () => api.get<ScriptExecutionPage>(`/api/scripts/${scriptId}/executions?version=${selectedVersion}&page=${executionPage}&pageSize=${executionPageSize}`),
    enabled: Boolean(scriptId && selectedVersion),
    refetchInterval: (query) => query.state.data?.executions.some((execution) => execution.status === "running") ? 2000 : false
  });

  useEffect(() => {
    setExecutionPage(1);
    setExpandedExecutionId(null);
  }, [scriptId, selectedVersion]);

  useEffect(() => {
    if (!detail) return;
    const requestedVersion = Number.isInteger(version) ? detail.versions.find((entry) => entry.version === version) : undefined;
    const initialVersion = requestedVersion ?? detail.versions[0];
    setName(detail.name);
    setLanguage(detail.language);
    setDescription(detail.description);
    setSelectedVersion(initialVersion?.version ?? null);
    setContent(initialVersion?.content ?? "");
    setOriginalContent(initialVersion?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  useEffect(() => {
    if (selectedVersionData) {
      setContent(selectedVersionData.content);
      setOriginalContent(selectedVersionData.content);
    }
  }, [selectedVersionData]);

  const save = useMutation({
    mutationFn: async () => {
      if (!scriptId) throw new Error("No script selected");
      await api.patch(`/api/scripts/${scriptId}`, { name, language, description });
      if (content !== originalContent) return api.post<{ id: string; version: number }>(`/api/scripts/${scriptId}/versions`, { content });
      return null;
    },
    onSuccess: async (created) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["script-detail", scriptId] })
      ]);
      if (created) {
        setSelectedVersion(created.version);
        toast.success("Script version saved");
      } else {
        toast.success("Script details saved");
      }
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to save script")
  });
  const deleteScript = useMutation({
    mutationFn: () => api.delete<{ success: boolean; scriptId: string; scriptName: string; deletedExecutionCount: number }>(`/api/scripts/${scriptId}`),
    onSuccess: async (result) => {
      setDeleteOpen(false);
      queryClient.removeQueries({ queryKey: ["script-detail", result.scriptId] });
      queryClient.removeQueries({ queryKey: ["script-executions", result.scriptId] });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["scripts"] }),
        queryClient.invalidateQueries({ queryKey: ["command-executions"] }),
        queryClient.invalidateQueries({ queryKey: ["store-detail"] })
      ]);
      toast.success(`${result.scriptName} deleted with ${result.deletedExecutionCount} execution record${result.deletedExecutionCount === 1 ? "" : "s"}`);
      onClose();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Unable to delete script")
  });
  const refreshExecutions = useMutation({
    mutationFn: () => queryClient.refetchQueries({ queryKey: ["script-executions", scriptId, selectedVersion], type: "active" }),
    onError: () => toast.error("Unable to refresh script execution history")
  });

  const executions = executionData?.executions ?? [];
  const executionPagination = executionData?.pagination;
  const executionSummary = executionData?.summary ?? { total: 0, succeeded: 0, failed: 0, timedOut: 0, running: 0 };

  return <>
    <SideDrawer open={Boolean(scriptId)} zIndex={zIndex} title={<div className="drawer-heading">{detail ? <HostPlatformIcon platform={detail.platform} size={18} /> : null}<strong>{detail?.name ?? "Script details"}</strong>{detail && <StatusBadge status={scriptRunStatus(detail.executionStats)} />}</div>} onClose={onClose}>
      {detail && <div className="store-drawer-tab">
        <div className="script-metadata-grid"><label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a store. Names must be unique within the same platform." /></span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span className="field-label">Platform</span><select value={detail.platform} disabled><option value="windows">Windows</option><option value="unix">Unix</option></select></label><label className="field"><span className="field-label">Language <FieldHelp text="Controls syntax highlighting and identifies the shell expected on the enrolled host." /></span><select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{detail.platform === "windows" ? <option value="powershell">PowerShell</option> : <><option value="bash">Bash</option><option value="sh">POSIX sh</option></>}</select></label><label className="field"><span className="field-label">Description <FieldHelp text="Optional operator-facing context about the script's purpose, prerequisites, or expected effect." /></span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description" /></label></div>
        {detail.versions.length > 0 && <section className="script-version-history">
          <div className="script-version-timeline">{detail.versions.map((entry) => <button key={entry.id} type="button" title={`Version ${entry.version} · ${entry.createdBy ?? "system"} · ${new Date(entry.createdAt).toLocaleString()}`} className={`script-version-item ${entry.version === selectedVersion ? "active" : ""}`} onClick={() => setSelectedVersion(entry.version)}>
            <span className="script-version-dot" />
            <span className="script-version-meta">
              <strong>Version {entry.version}{entry.version === detail.latestVersion && <span className="script-version-latest-tag">Latest</span>}</strong>
              <span>{entry.createdBy ?? "system"} · {new Date(entry.createdAt).toLocaleString()}</span>
            </span>
          </button>)}</div>
        </section>}
        <ScriptEditor value={content} language={language} readOnly={selectedVersionData?.version !== detail.latestVersion} onChange={setContent} />
        <div className="form-actions script-editor-actions"><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => setDeleteOpen(true)}><Trash2 size={15} />Delete script</button><span className="script-editor-hint">{content !== originalContent ? `Creates version ${(detail.latestVersion ?? 0) + 1}` : "No content changes"}</span><button className="button button-primary" type="button" disabled={!name.trim() || !content.trim() || save.isPending || deleteScript.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving..." : "Save changes"}</button></div>
        {selectedVersion && <section className="script-execution-history"><header><div><h3>Execution history</h3><span>Version {selectedVersion}</span></div><div className="command-history-head-actions"><ExecutionStatsSummary stats={executionSummary} /><span>{executionPagination?.total ?? 0} run{executionPagination?.total === 1 ? "" : "s"}</span><button className="icon-button" type="button" title="Refresh execution history" aria-label="Refresh execution history" disabled={refreshExecutions.isPending || executionsFetching} onClick={() => refreshExecutions.mutate()}><RefreshCw size={14} className={refreshExecutions.isPending || executionsFetching ? "spin-icon" : undefined} /></button></div></header>{executions.length ? <div className="script-execution-list">{executions.map((execution) => {
          const statusLabel = execution.status === "succeeded" ? "Succeeded" : execution.status === "failed" ? "Error" : execution.status === "timed_out" ? "Timeout" : "Running";
          const environment = scriptExecutionEnvironment(execution);
          const executionLanguage = execution.language ?? (execution.platform === "windows" ? "powershell" : "bash");
          return <details className={`command-execution command-execution-${execution.status}`} key={execution.id} open={expandedExecutionId === execution.id} onToggle={(event) => { if (event.currentTarget.open) setExpandedExecutionId(execution.id); else if (expandedExecutionId === execution.id) setExpandedExecutionId(null); }}><summary><span className="command-execution-summary-main"><StatusBadge status={execution.status} label={statusLabel} /><button className="script-execution-store-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); openStoreDrawer(execution.storeId, "connect"); }}>{execution.storeDisplayName}</button><code className="command-execution-store-code">{execution.tenantCode} / {execution.storeCode}</code><span className="host-identity" title={environment}><HostPlatformIcon environment={execution.environment} platform={execution.enrollmentPlatform} osName={execution.osName} /><code>{execution.computerName ?? "N/A"}</code></span></span><span className="command-execution-timing"><time>{new Date(execution.startedAt).toLocaleString()}</time><code>{execution.elapsedMs !== null ? `${execution.elapsedMs} ms` : execution.status === "running" ? "running" : "-"}</code></span></summary>{expandedExecutionId === execution.id && <div className="command-execution-body"><ScriptEditor value={execution.script} language={executionLanguage} height="200px" readOnly />{execution.error && <div className="inline-alert">{execution.error}</div>}{execution.stdout && <div className="command-output-block"><header><strong>stdout</strong><CopyButton value={execution.stdout} label="Copy stdout" iconOnly /></header><pre>{execution.stdout}</pre></div>}{execution.stderr && <div className="command-output-block"><header><strong>stderr</strong><CopyButton value={execution.stderr} label="Copy stderr" iconOnly /></header><pre>{execution.stderr}</pre></div>}{!execution.stdout && !execution.stderr && !execution.error && <div className="quiet-empty">The script produced no output.</div>}</div>}</details>;
        })}</div> : <div className="quiet-empty">This script version has not been executed.</div>}{executionPagination && executionPagination.totalPages > 1 && <div className="command-history-pagination"><button className="icon-button" type="button" title="Previous execution page" aria-label="Previous execution page" disabled={executionPagination.page <= 1} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => Math.max(1, page - 1)); }}><ChevronLeft size={15} /></button><span>Page {executionPagination.page} of {executionPagination.totalPages}</span><button className="icon-button" type="button" title="Next execution page" aria-label="Next execution page" disabled={executionPagination.page >= executionPagination.totalPages} onClick={() => { setExpandedExecutionId(null); setExecutionPage((page) => page + 1); }}><ChevronRight size={15} /></button></div>}</section>}
      </div>}
    </SideDrawer>
    <Modal open={deleteOpen} title={`Delete script · ${name}`} onClose={() => setDeleteOpen(false)}><div className="delete-confirmation"><div className="inline-alert"><AlertTriangle size={15} />This permanently deletes the saved script, every version, and all related execution history. This action cannot be undone.</div><div className="form-actions"><button className="button button-secondary" type="button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteScript.isPending} onClick={() => deleteScript.mutate()}><Trash2 size={15} />{deleteScript.isPending ? "Deleting..." : "Delete permanently"}</button></div></div></Modal>
  </>;
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
