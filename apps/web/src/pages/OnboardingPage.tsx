import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Network, Store as StoreIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { ConnectivityEditor, connectivityPayload, createCommandAgentDraftPublication, validatePublications, type DraftPublication } from "../components/ConnectivityEditor";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { EnrollmentCommands } from "../components/StoreDrawer";
import { SearchableSelect } from "../components/SearchableSelect";
import type { CloudflareAccount, EnrollmentResult, Store } from "../types";

export function OnboardingPage() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<{ store: Store; enrollment: EnrollmentResult } | null>(null);
  const [error, setError] = useState("");
  const [storeCode, setStoreCode] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [publications, setPublications] = useState<DraftPublication[]>([createCommandAgentDraftPublication()]);
  const { data: accountData } = useQuery({ queryKey: ["accounts"], queryFn: () => api.get<{ accounts: CloudflareAccount[] }>("/api/accounts") });
  const mutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const created = await api.post<{ store: Store }>("/api/stores", body);
      const enrollment = await api.post<EnrollmentResult>(`/api/stores/${created.store.id}/enrollments`, { expiresInHours: 24 });
      return { store: created.store, enrollment };
    },
    onSuccess: async (data) => { setResult(data); await queryClient.invalidateQueries(); toast.success("Store ready for installation"); },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to onboard store")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!zoneId) {
      setError("Select an account and zone for this tunnel");
      return;
    }
    const connectivityError = validatePublications(publications);
    if (connectivityError) {
      setError(connectivityError);
      return;
    }
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      tenantCode: form.get("tenantCode"),
      storeCode,
      displayName: form.get("displayName"),
      zoneId,
      publications: connectivityPayload(publications)
    });
  };
  if (result) return <OnboardingResult result={result} onReset={() => setResult(null)} />;
  const hasCapacity = accountData?.accounts.some((account) => account.status === "active" && account.zones.some((zone) => zone.status === "active" && zone.storeCount < zone.softStoreLimit));
  const zoneOptions = [
    { value: "", label: "Select account / zone" },
    ...(accountData?.accounts.flatMap((account) => account.zones
      .filter((zone) => account.status === "active" && zone.status === "active")
      .map((zone) => ({ value: zone.id, label: `${account.name} / ${zone.name} · ${zone.storeCount}/${zone.softStoreLimit}` }))) ?? [])
  ];
  const selectedZone = accountData?.accounts.flatMap((account) => account.zones).find((zone) => zone.id === zoneId);
  return (
    <div className="page onboarding-page">
      <PageHeader title="Onboard new store" eyebrow="Enrollment" />
      <div className="stepper"><div className="step active"><span>1</span><strong>Store</strong></div><i /><div className="step"><span>2</span><strong>Install</strong></div><i /><div className="step"><span>3</span><strong>Connect</strong></div></div>
      <form className="onboarding-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        {!hasCapacity && <div className="inline-alert">Add an active account and zone before onboarding a store.</div>}
        <section className="form-section"><header><span><StoreIcon size={18} /></span><div><h2>Store identity</h2></div></header><div className="field-grid"><label className="field"><span className="field-label">Tenant code <FieldHelp text="A stable code assigned by DCorp for the customer or tenant. It groups stores operationally but is not part of the generated subdomain." /></span><input name="tenantCode" placeholder="TENANT" required /></label><label className="field"><span className="field-label">Store ID <FieldHelp text="The stable identifier used as the base subdomain name. It must be unique within the selected zone and should not change after onboarding." /></span><input name="storeCode" value={storeCode} onChange={(event) => setStoreCode(event.target.value)} placeholder="001" required /></label></div><label className="field"><span className="field-label">Display name <FieldHelp text="A human-readable name shown only in Cloudflare Man. Use the name operators use to recognize this location." /></span><input name="displayName" placeholder="Store 1" required /></label></section>
        <section className="form-section"><header><span><Network size={18} /></span><div><h2>Connectivity</h2></div></header><div className="field"><span className="field-label">Account and zone assignment <FieldHelp text="The selected account owns the store tunnel, and every subdomain below is created in this zone. Type to filter by account or zone name." /></span><SearchableSelect name="zoneId" options={zoneOptions} ariaLabel="Account and zone assignment" emptyMessage="No matching account or zone" onValueChange={setZoneId} /></div><ConnectivityEditor storeId={storeCode} zoneName={selectedZone?.name} publications={publications} onChange={setPublications} /></section>
        <div className="onboarding-actions"><button className="button button-primary" type="submit" disabled={!hasCapacity || !zoneId || mutation.isPending}>{mutation.isPending ? "Creating enrollment..." : "Create enrollment"}</button></div>
      </form>
    </div>
  );
}

function OnboardingResult({ result, onReset }: { result: { store: Store; enrollment: EnrollmentResult }; onReset: () => void }) {
  return <div className="page onboarding-page"><PageHeader title="Installation ready" eyebrow="Enrollment issued" actions={<button className="button button-secondary" onClick={onReset}><ArrowLeft size={15} />Another store</button>} /><div className="success-banner"><span><Check size={22} /></span><div><strong>{result.store.displayName}</strong><code>{result.store.hostname}</code></div></div><section className="install-surface"><header><h2>Run at the store</h2><span>{result.store.tenantCode} / {result.store.storeCode}</span></header><EnrollmentCommands result={result.enrollment} /></section><div className="connection-track"><div className="done"><i><Check size={13} /></i><span>Store reserved</span></div><div className="current"><i>2</i><span>Awaiting installer</span></div><div><i>3</i><span>Connector online</span></div><div><i>4</i><span>Endpoint verified</span></div></div></div>;
}
