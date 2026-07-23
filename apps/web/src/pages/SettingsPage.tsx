import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, KeyRound, LogOut, Save, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../api";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import type { AppSettings, User } from "../types";

export function SettingsPage({ user, onLogout, onPasswordChanged }: { user: User; onLogout: () => void; onPasswordChanged: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const { data: settingsData, isLoading: settingsLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<{ settings: AppSettings }>("/api/settings")
  });
  const updateSettings = useMutation({
    mutationFn: (body: Pick<AppSettings, "publicBaseUrl">) => api.put<{ settings: AppSettings }>("/api/settings", body),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      setSettingsError("");
      toast.success("Public base URL updated");
    },
    onError: (requestError) => setSettingsError(requestError instanceof ApiError ? requestError.message : "Unable to update public base URL")
  });
  const changePassword = useMutation({
    mutationFn: (body: unknown) => api.post("/api/auth/change-password", body),
    onSuccess: () => { toast.success("Password changed"); onPasswordChanged(); setError(""); },
    onError: (requestError) => setError(requestError instanceof ApiError ? requestError.message : "Unable to change password")
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const currentPassword = form.get("currentPassword")?.toString() ?? "";
    const newPassword = form.get("newPassword")?.toString() ?? "";
    const confirmPassword = form.get("confirmPassword")?.toString() ?? "";
    if (newPassword !== confirmPassword) { setError("New passwords do not match"); return; }
    changePassword.mutate({ currentPassword, newPassword });
  };
  const submitSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    updateSettings.mutate({ publicBaseUrl: form.get("publicBaseUrl")?.toString() ?? "" });
  };
  const logout = async () => { await api.post("/api/auth/logout"); queryClient.clear(); onLogout(); };
  return <div className="page settings-page"><PageHeader title="Settings" eyebrow="System and security" /><section className="settings-section"><header><span><Globe2 size={19} /></span><div><h2>Public access</h2></div></header><form className="settings-form" key={settingsData?.settings.publicBaseUrl} onSubmit={submitSettings}>{settingsError && <div className="form-error">{settingsError}</div>}<label className="field"><span className="field-label">Public base URL <FieldHelp text="The HTTPS origin reachable from store machines. Enrollment commands and installer callback URLs use this value. Enter a full origin without a path." /></span><input name="publicBaseUrl" defaultValue={settingsData?.settings.publicBaseUrl ?? ""} placeholder="https://cloudflare-man.example.com" disabled={settingsLoading} required /></label><button className="button button-primary" disabled={settingsLoading || updateSettings.isPending}><Save size={15} />{updateSettings.isPending ? "Saving..." : "Save URL"}</button></form></section><section className="settings-section"><header><span><ShieldCheck size={19} /></span><div><h2>Administrator account</h2></div></header><dl className="account-profile"><div><dt>Username</dt><dd>{user.username}</dd></div><div><dt>Role</dt><dd>Administrator</dd></div><div><dt>Password status</dt><dd>{user.mustChangePassword ? <span className="warning-text">Change required</span> : "Current"}</dd></div></dl></section><section className="settings-section"><header><span><KeyRound size={19} /></span><div><h2>Change password</h2></div></header><form className="password-form" onSubmit={submit}>{error && <div className="form-error">{error}</div>}<label className="field"><span className="field-label">Current password <FieldHelp text="The password currently used to sign in to this Cloudflare Man administrator account." /></span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label className="field"><span className="field-label">New password <FieldHelp text="The new local administrator password. It must contain at least 10 characters and is unrelated to your Cloudflare credentials." /></span><input name="newPassword" type="password" autoComplete="new-password" minLength={10} required /></label><label className="field"><span className="field-label">Confirm new password <FieldHelp text="Enter the new password again to prevent an accidental typo before it replaces the current password." /></span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} required /></label><button className="button button-primary" disabled={changePassword.isPending}>{changePassword.isPending ? "Updating..." : "Update password"}</button></form></section><section className="settings-section danger-section"><div><h2>Current session</h2><span>Signed in as {user.username}</span></div><button className="button button-danger" onClick={() => void logout()}><LogOut size={16} />Sign out</button></section></div>;
}
