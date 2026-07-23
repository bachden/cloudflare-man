import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Code2, FilePlus2, RefreshCw, Save, Search, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { SearchableSelect } from "../components/SearchableSelect";
import { ScriptEditor } from "../components/ScriptEditor";
import { StatusBadge } from "../components/StatusBadge";
import type { ManagedScript, ManagedScriptSummary } from "../types";

const defaultContent = {
  windows: "Write-Output \"Store: $env:COMPUTERNAME\"\n",
  unix: "printf 'Store: %s\\n' \"$(hostname)\"\n"
};

const platformFilterOptions = [
  { value: "", label: "All platforms" },
  { value: "windows", label: "Windows" },
  { value: "unix", label: "Unix" }
];

export function ScriptsPage() {
  const queryClient = useQueryClient();
  const [nameFilter, setNameFilter] = useState("");
  const [platformFilter, setPlatformFilter] = useState<"" | "windows" | "unix">("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<"windows" | "unix">("windows");
  const [language, setLanguage] = useState<"powershell" | "bash" | "sh">("powershell");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState(defaultContent.windows);
  const [originalContent, setOriginalContent] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const scriptParams = new URLSearchParams();
  if (nameFilter.trim()) scriptParams.set("name", nameFilter.trim());
  if (platformFilter) scriptParams.set("platform", platformFilter);
  const { data, isLoading } = useQuery({
    queryKey: ["scripts", nameFilter, platformFilter],
    queryFn: () => api.get<{ scripts: ManagedScriptSummary[] }>(`/api/scripts${scriptParams.size ? `?${scriptParams.toString()}` : ""}`)
  });
  const { data: detailData } = useQuery({
    queryKey: ["script-detail", selectedId],
    queryFn: () => api.get<{ script: ManagedScript }>(`/api/scripts/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  const scripts = data?.scripts ?? [];
  const detail = detailData?.script;
  const selectedVersionData = useMemo(() => detail?.versions.find((version) => version.version === selectedVersion) ?? detail?.versions[0], [detail, selectedVersion]);

  useEffect(() => {
    if (!detail || draft) return;
    setName(detail.name);
    setPlatform(detail.platform);
    setLanguage(detail.language);
    setDescription(detail.description);
    setSelectedVersion(detail.versions[0]?.version ?? null);
    setContent(detail.versions[0]?.content ?? "");
    setOriginalContent(detail.versions[0]?.content ?? "");
  }, [detail, draft]);

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
    setDraft(false);
    setSelectedId(script.id);
  };
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/api/scripts", { name, platform, language, description, content }),
    onSuccess: async (result) => {
      setDraft(false);
      setSelectedId(result.id);
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
  const languageOptions = platform === "windows" ? [{ value: "powershell", label: "PowerShell" }] : [{ value: "bash", label: "Bash" }, { value: "sh", label: "POSIX sh" }];
  const active = Boolean(draft || selectedId);
  return <div className="page">
    <PageHeader title="Script library" eyebrow="Versioned store automation" actions={<><button className="button button-secondary" type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={15} className={refresh.isPending ? "spin-icon" : undefined} />{refresh.isPending ? "Refreshing..." : "Refresh"}</button><button className="button button-primary" type="button" onClick={openNew}><FilePlus2 size={16} />New script</button></>} />
    <div className="scripts-layout">
      <section className="panel script-list-panel">
        <div className="script-list-toolbar"><label className="search-box"><Search size={15} /><input value={nameFilter} onChange={(event) => setNameFilter(event.target.value)} placeholder="Search script names" /></label><div className="script-platform-filter"><SearchableSelect name="platformFilter" options={platformFilterOptions} ariaLabel="Filter scripts by platform" emptyMessage="No matching platforms" onValueChange={(value) => setPlatformFilter(value as typeof platformFilter)} /></div><span>{scripts.length} script{scripts.length === 1 ? "" : "s"}</span></div>
        {isLoading ? <div className="quiet-empty">Loading scripts...</div> : scripts.length ? <div className="script-list">{scripts.map((script) => <button className={`script-list-item ${selectedId === script.id && !draft ? "active" : ""}`} key={script.id} type="button" onClick={() => selectScript(script)}><span className="script-list-icon"><Code2 size={15} /></span><span><strong>{script.name}</strong><small>{script.platform} · v{script.latestVersion ?? "-"}</small></span><StatusBadge status={script.platform === "windows" ? "windows" : "unix"} /></button>)}</div> : <div className="quiet-empty">No scripts saved yet.</div>}
      </section>
      <section className="panel script-editor-panel">
        {!active ? <div className="script-empty-state"><TerminalSquare size={26} /><strong>Select a script or create one</strong></div> : <>
          <header className="script-editor-header"><div><h2>{draft ? "New script" : name}</h2><span>{draft ? "Version 1" : `Version ${selectedVersion ?? detail?.latestVersion ?? "-"}`}</span></div>{!draft && detail && <select value={selectedVersion ?? detail.versions[0]?.version ?? ""} onChange={(event) => setSelectedVersion(Number(event.target.value))} aria-label="Script version">{detail.versions.map((version) => <option value={version.version} key={version.id}>Version {version.version}</option>)}</select>}</header>
          <div className="script-metadata-grid"><label className="field"><span className="field-label">Name <FieldHelp text="The reusable script name shown when an operator selects a script for a store. Names must be unique within the same platform." /></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Inventory refresh" /></label><label className="field"><span className="field-label">Platform <FieldHelp text="The host family this script can run on. Windows scripts use PowerShell; Unix scripts can use Bash or POSIX sh. The platform cannot change after creation." /></span><select value={platform} disabled={!draft} onChange={(event) => { const next = event.target.value as "windows" | "unix"; setPlatform(next); setLanguage(next === "windows" ? "powershell" : "bash"); }}><option value="windows">Windows</option><option value="unix">Unix</option></select></label><label className="field"><span className="field-label">Language <FieldHelp text="Controls syntax highlighting and identifies the shell expected on the enrolled host." /></span><select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{languageOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="field"><span className="field-label">Description <FieldHelp text="Optional operator-facing context about the script's purpose, prerequisites, or expected effect." /></span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description" /></label></div>
          <ScriptEditor value={content} language={language} readOnly={!draft && selectedVersionData?.version !== detail?.latestVersion} onChange={setContent} />
          <div className="form-actions"><span className="script-editor-hint">{draft ? "Creates version 1" : content !== originalContent ? `Creates version ${(detail?.latestVersion ?? 0) + 1}` : "No content changes"}</span><button className="button button-primary" type="button" disabled={!name.trim() || !content.trim() || create.isPending || save.isPending} onClick={() => draft ? create.mutate() : save.mutate()}><Save size={15} />{draft ? "Create script" : "Save changes"}</button></div>
        </>}
      </section>
    </div>
  </div>;
}
