import type { FastifyInstance, FastifyReply } from "fastify";
import { isIP } from "node:net";
import { z } from "zod";
import { config } from "../config.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { pool, withTransaction } from "../lib/database.js";
import { provisionStore } from "../lib/provisioning.js";
import { provisionBrowserRdp } from "../lib/rdp.js";
import { hashToken } from "../lib/security.js";
import { scheduleStoreVerification } from "../lib/store-verification.js";

const tokenParams = z.object({ token: z.string().min(30).max(200) });
const claimSchema = z.object({
  token: z.string().min(30).max(200),
  platform: z.enum(["windows", "linux", "darwin", "unix"]),
  architecture: z.string().max(40).optional(),
  machineName: z.string().max(200).optional(),
  installId: z.string().max(200).optional(),
  overrideExisting: z.boolean().default(false)
});
const reportSchema = z.object({
  token: z.string().min(30).max(200),
  status: z.enum(["installed", "failed"]),
  version: z.string().max(80).optional(),
  error: z.string().max(2000).optional(),
  rdpEnabled: z.boolean().optional(),
  rdpTargetIp: z.string().refine((value) => isIP(value) === 4, "RDP target must be an IPv4 address").optional(),
  rdpPort: z.number().int().min(1).max(65535).optional(),
  rdpError: z.string().max(2000).optional()
});
const logSchema = z.object({
  token: z.string().min(30).max(200),
  events: z.array(z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    step: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(4000).optional(),
    messageBase64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(6000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  }).refine((event) => event.message || event.messageBase64, "A log message is required")).min(1).max(50)
});

async function findEnrollment(token: string) {
  const result = await pool.query(
    `SELECT e.id, e.store_id, e.status, e.expires_at, e.install_id, e.claimed_at, e.claimed_by, e.platform, s.hostname
       FROM enrollments e JOIN stores s ON s.id = e.store_id
      WHERE e.token_hash = $1`,
    [hashToken(token)]
  );
  return result.rows[0];
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, private");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
}

function shellScript(token: string, hostname: string, publicBaseUrl: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/report`;
  return `#!/usr/bin/env bash
set -euo pipefail

ENROLLMENT_TOKEN='${token}'
CLOUDFLARED_VERSION='${config.CLOUDFLARED_VERSION}'
CLAIM_URL='${claimUrl}'
REPORT_URL='${reportUrl}'
LOG_URL='${publicBaseUrl}/api/public/enrollments/logs'
ASSIGNED_HOSTNAME='${hostname}'
REPORT_SENT=0
TEMP_DIR=""

send_log() {
  level="$1"
  step="$2"
  message="$(printf '%s' "$3" | cut -c1-3500)"
  encoded_message="$(printf '%s' "$message" | base64 | tr -d '\r\n')"
  curl --silent --show-error --fail --max-time 10 -X POST "$LOG_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"events\\":[{\\"level\\":\\"$level\\",\\"step\\":\\"$step\\",\\"messageBase64\\":\\"$encoded_message\\"}]}" >/dev/null 2>&1 || true
}

log_message() {
  printf '[%s] %s\n' "$2" "$3"
  send_log "$1" "$2" "$3"
}

report_failure() {
  exit_code=$?
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then rm -rf "$TEMP_DIR"; fi
  if [ "$exit_code" -ne 0 ] && [ "$REPORT_SENT" -eq 0 ]; then
    send_log "error" "installer" "Installer exited with code $exit_code"
    curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$REPORT_URL" \\
      -H 'Content-Type: application/json' \\
      --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"status\\":\\"failed\\",\\"error\\":\\"installer exited with code $exit_code\\"}" >/dev/null || true
  fi
  exit "$exit_code"
}
trap report_failure EXIT
log_message "info" "preflight" "Starting cloudflare-man enrollment for $ASSIGNED_HOSTNAME"

if [ "$(id -u)" -ne 0 ]; then
  log_message "error" "preflight" "Run this installer as root with sudo"
  echo "Run this installer as root (sudo)." >&2
  exit 1
fi

OS_NAME="$(uname -s | tr '[:upper:]' '[:lower:]')"
MACHINE_ARCH="$(uname -m)"
MACHINE_NAME="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-200)"
[ -n "$MACHINE_NAME" ] || MACHINE_NAME="unknown"
case "$MACHINE_ARCH" in
  x86_64|amd64) CF_ARCH="amd64" ;;
  arm64|aarch64) CF_ARCH="arm64" ;;
  *) echo "Unsupported architecture: $MACHINE_ARCH" >&2; exit 1 ;;
esac

if [ "$OS_NAME" = "linux" ]; then
  STATE_DIR="/var/lib/cloudflare-man"
else
  STATE_DIR="/Library/Application Support/cloudflare-man"
fi
INSTALL_ID_FILE="$STATE_DIR/install-id"
HOSTNAME_FILE="$STATE_DIR/assigned-hostname"
OVERRIDE_EXISTING=false
EXISTING_ENROLLMENT=0
if [ -s "$INSTALL_ID_FILE" ] || pgrep -x cloudflared >/dev/null 2>&1 \\
  || [ -f /etc/systemd/system/cloudflared.service ] \\
  || [ -f /Library/LaunchDaemons/com.cloudflare.cloudflared.plist ]; then
  EXISTING_ENROLLMENT=1
fi
if [ "$EXISTING_ENROLLMENT" -eq 1 ]; then
  PREVIOUS_HOSTNAME=""
  if [ -s "$HOSTNAME_FILE" ]; then PREVIOUS_HOSTNAME="$(cat "$HOSTNAME_FILE")"; fi
  if [ -n "$PREVIOUS_HOSTNAME" ]; then
    log_message "warn" "existing-enrollment" "Existing enrollment detected for $PREVIOUS_HOSTNAME"
  else
    log_message "warn" "existing-enrollment" "Existing cloudflare-man enrollment or cloudflared service detected"
  fi
  if [ ! -r /dev/tty ]; then
    log_message "error" "existing-enrollment" "Interactive confirmation is required to cleanup and override"
    REPORT_SENT=1
    exit 1
  fi
  printf 'An existing store enrollment was detected. Cleanup and override it? [y/N] ' > /dev/tty
  IFS= read -r CONFIRM_OVERRIDE < /dev/tty
  case "$CONFIRM_OVERRIDE" in
    y|Y|yes|YES)
      log_message "info" "cleanup" "User approved cleanup and override"
      if command -v cloudflared >/dev/null 2>&1; then
        CLEANUP_OUTPUT="$(cloudflared service uninstall 2>&1 || true)"
        if [ -n "$CLEANUP_OUTPUT" ]; then log_message "info" "cleanup" "$CLEANUP_OUTPUT"; fi
      fi
      rm -rf "$STATE_DIR"
      OVERRIDE_EXISTING=true
      ;;
    *)
      log_message "warn" "cleanup" "User declined cleanup; enrollment cancelled"
      REPORT_SENT=1
      exit 0
      ;;
  esac
fi
mkdir -p "$STATE_DIR"
INSTALL_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || printf '%s-%s' "$(date +%s)" "$$")"
printf '%s' "$INSTALL_ID" > "$INSTALL_ID_FILE"
chmod 600 "$INSTALL_ID_FILE"
log_message "info" "preflight" "Local enrollment state is ready"

if ! command -v cloudflared >/dev/null 2>&1; then
  TEMP_DIR="$(mktemp -d)"
  log_message "info" "download" "Downloading cloudflared $CLOUDFLARED_VERSION for $OS_NAME/$CF_ARCH"
  if [ "$OS_NAME" = "darwin" ]; then
    ARCHIVE="$TEMP_DIR/cloudflared.tgz"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-darwin-$CF_ARCH.tgz" -o "$ARCHIVE"
    tar -xzf "$ARCHIVE" -C "$TEMP_DIR"
    install -m 0755 "$TEMP_DIR/cloudflared" /usr/local/bin/cloudflared
  elif [ "$OS_NAME" = "linux" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$CF_ARCH" -o "$TEMP_DIR/cloudflared"
    install -m 0755 "$TEMP_DIR/cloudflared" /usr/local/bin/cloudflared
  else
    echo "Unsupported operating system: $OS_NAME" >&2
    exit 1
  fi
  log_message "info" "download" "cloudflared installed successfully"
fi

log_message "info" "claim" "Claiming enrollment and provisioning the Cloudflare tunnel"
CLAIM_BODY="$(printf '{\\"token\\":\\"%s\\",\\"platform\\":\\"%s\\",\\"architecture\\":\\"%s\\",\\"machineName\\":\\"%s\\",\\"installId\\":\\"%s\\",\\"overrideExisting\\":%s}' "$ENROLLMENT_TOKEN" "$OS_NAME" "$MACHINE_ARCH" "$MACHINE_NAME" "$INSTALL_ID" "$OVERRIDE_EXISTING")"
TUNNEL_TOKEN="$(curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$CLAIM_URL" -H 'Content-Type: application/json' -H 'Accept: text/plain' --data "$CLAIM_BODY")"
log_message "info" "claim" "Enrollment claimed successfully"
log_message "info" "service" "Installing the cloudflared service"
if ! SERVICE_OUTPUT="$(cloudflared service install "$TUNNEL_TOKEN" 2>&1)"; then
  log_message "error" "service" "$SERVICE_OUTPUT"
  exit 1
fi
if [ -n "$SERVICE_OUTPUT" ]; then log_message "info" "service" "$SERVICE_OUTPUT"; fi
VERSION="$(cloudflared --version | head -n 1)"
log_message "info" "report" "Reporting successful installation"
curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$REPORT_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"status\\":\\"installed\\",\\"version\\":\\"$VERSION\\"}" >/dev/null
REPORT_SENT=1
printf '%s' "$ASSIGNED_HOSTNAME" > "$HOSTNAME_FILE"
chmod 600 "$HOSTNAME_FILE"
log_message "info" "complete" "Store tunnel installed successfully for $ASSIGNED_HOSTNAME"

echo "Store tunnel installed: $ASSIGNED_HOSTNAME"
`;
}

function powerShellScript(token: string, hostname: string, publicBaseUrl: string): string {
  return `$ErrorActionPreference = "Stop"
$EnrollmentToken = "${token}"
$CloudflaredVersion = "${config.CLOUDFLARED_VERSION}"
$ClaimUrl = "${publicBaseUrl}/api/public/enrollments/claim"
$ReportUrl = "${publicBaseUrl}/api/public/enrollments/report"
$AssignedHostname = "${hostname}"
$ReportSent = $false
$LogUrl = "${publicBaseUrl}/api/public/enrollments/logs"

function Send-InstallLog {
  param(
    [ValidateSet("debug", "info", "warn", "error")][string]$Level,
    [string]$Step,
    [string]$Message
  )
  if ($Message.Length -gt 3500) { $Message = $Message.Substring(0, 3500) }
  Write-Host "[$Step] $Message"
  try {
    $encodedMessage = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Message))
    $logBody = @{
      token = $EnrollmentToken
      events = @(@{ level = $Level; step = $Step; messageBase64 = $encodedMessage })
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri $LogUrl -ContentType "application/json" -Body $logBody -TimeoutSec 10 | Out-Null
  } catch {
    Write-Warning "Unable to send installation log: $($_.Exception.Message)"
  }
}

try {
Send-InstallLog -Level "info" -Step "preflight" -Message "Starting cloudflare-man enrollment for $AssignedHostname"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Send-InstallLog -Level "error" -Step "preflight" -Message "Run PowerShell as Administrator."
  throw "Run PowerShell as Administrator."
}

$architecture = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$installDirectory = Join-Path $env:ProgramFiles "cloudflared"
$binary = Join-Path $installDirectory "cloudflared.exe"
$stateDirectory = Join-Path $env:ProgramData "cloudflare-man"
$installIdFile = Join-Path $stateDirectory "install-id"
$hostnameFile = Join-Path $stateDirectory "assigned-hostname"
$overrideExisting = $false
$existingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
$existingEnrollment = (Test-Path $installIdFile) -or ($null -ne $existingService)
if ($existingEnrollment) {
  $existingLabel = "an existing cloudflare-man enrollment or cloudflared service"
  if (Test-Path $hostnameFile) {
    $previousHostname = (Get-Content $hostnameFile -Raw).Trim()
    if ($previousHostname) { $existingLabel = "the existing enrollment for $previousHostname" }
  }
  Send-InstallLog -Level "warn" -Step "existing-enrollment" -Message "Detected $existingLabel"
  $confirmation = Read-Host "Cleanup and override $existingLabel? [y/N]"
  if ($confirmation -notmatch "^(y|yes)$") {
    Send-InstallLog -Level "warn" -Step "cleanup" -Message "User declined cleanup; enrollment cancelled"
    $ReportSent = $true
    return
  }
  Send-InstallLog -Level "info" -Step "cleanup" -Message "User approved cleanup and override"
  if (Test-Path $binary) {
    $cleanupOutput = & $binary service uninstall 2>&1
    foreach ($line in $cleanupOutput) { Send-InstallLog -Level "info" -Step "cleanup" -Message $line.ToString() }
  } elseif ($existingService) {
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    & sc.exe delete cloudflared | Out-Null
  }
  if (Test-Path $stateDirectory) { Remove-Item $stateDirectory -Recurse -Force }
  $overrideExisting = $true
}
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$installId = [guid]::NewGuid().ToString()
Set-Content -Path $installIdFile -Value $installId -NoNewline
Send-InstallLog -Level "info" -Step "preflight" -Message "Local enrollment state is ready"

if (-not (Test-Path $binary)) {
  Send-InstallLog -Level "info" -Step "download" -Message "Downloading cloudflared $CloudflaredVersion for windows/$architecture"
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-$architecture.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $binary -UseBasicParsing
  $signature = Get-AuthenticodeSignature $binary
  if ($signature.Status -ne "Valid") {
    Remove-Item $binary -Force
    throw "The cloudflared executable has an invalid Authenticode signature."
  }
  Send-InstallLog -Level "info" -Step "download" -Message "cloudflared downloaded and signature verified"
}

Send-InstallLog -Level "info" -Step "claim" -Message "Claiming enrollment and provisioning the Cloudflare tunnel"
$claimBody = @{
  token = $EnrollmentToken
  platform = "windows"
  architecture = $architecture
  machineName = $env:COMPUTERNAME
  installId = $installId
  overrideExisting = $overrideExisting
} | ConvertTo-Json
$claim = Invoke-RestMethod -Method Post -Uri $ClaimUrl -ContentType "application/json" -Body $claimBody
Send-InstallLog -Level "info" -Step "claim" -Message "Enrollment claimed successfully"

Send-InstallLog -Level "info" -Step "service" -Message "Installing the cloudflared service"
$serviceOutput = & $binary service install $claim.tunnelToken 2>&1
$serviceExitCode = $LASTEXITCODE
foreach ($line in $serviceOutput) { Send-InstallLog -Level "info" -Step "service" -Message $line.ToString() }
if ($serviceExitCode -ne 0) { throw "cloudflared service installation failed with exit code $serviceExitCode." }

$rdpEnabled = $false
$rdpTargetIp = $null
$rdpError = $null
try {
  Send-InstallLog -Level "info" -Step "rdp" -Message "Enabling Windows Remote Desktop"
  $terminalServer = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server"
  $rdpTcp = Join-Path $terminalServer "WinStations\\RDP-Tcp"
  Set-ItemProperty -Path $terminalServer -Name "fDenyTSConnections" -Value 0
  Set-ItemProperty -Path $rdpTcp -Name "SecurityLayer" -Value 1
  Set-ItemProperty -Path $rdpTcp -Name "UserAuthentication" -Value 1
  Get-NetFirewallRule -Name "RemoteDesktop*" -ErrorAction Stop | Enable-NetFirewallRule
  Set-Service -Name "TermService" -StartupType Automatic
  Start-Service -Name "TermService"
  $rdpTargetIp = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -and -not $_.StartsWith("169.254.") } |
    Select-Object -First 1
  if (-not $rdpTargetIp) { throw "Unable to determine the store LAN IPv4 address." }
  $listenerReady = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue) { $listenerReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $listenerReady) { throw "Windows Remote Desktop did not start listening on port 3389." }
  $rdpEnabled = $true
  Send-InstallLog -Level "info" -Step "rdp" -Message ("Windows Remote Desktop is listening on {0}:3389" -f $rdpTargetIp)
} catch {
  $rdpError = $_.Exception.Message
  Send-InstallLog -Level "warn" -Step "rdp" -Message $rdpError
}

$reportPayload = @{
  token = $EnrollmentToken
  status = "installed"
  version = (& $binary --version | Select-Object -First 1)
  rdpEnabled = $rdpEnabled
  rdpPort = 3389
}
if ($rdpTargetIp) { $reportPayload.rdpTargetIp = $rdpTargetIp }
if ($rdpError) { $reportPayload.rdpError = $rdpError }
$reportBody = $reportPayload | ConvertTo-Json
Send-InstallLog -Level "info" -Step "report" -Message "Reporting successful installation"
$report = Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $reportBody
$ReportSent = $true
if ($report.rdp -and -not $report.rdp.ready) {
  Send-InstallLog -Level "warn" -Step "rdp" -Message "Browser RDP provisioning failed: $($report.rdp.error)"
  Write-Warning "Browser RDP provisioning failed: $($report.rdp.error)"
}
Set-Content -Path $hostnameFile -Value $AssignedHostname -NoNewline
Send-InstallLog -Level "info" -Step "complete" -Message "Store tunnel installed successfully for $AssignedHostname"
Write-Host "Store tunnel installed: $AssignedHostname"
} catch {
  Send-InstallLog -Level "error" -Step "installer" -Message $_.Exception.Message
  if (-not $ReportSent) {
    try {
      $failureBody = @{ token = $EnrollmentToken; status = "failed"; error = $_.Exception.Message } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $failureBody | Out-Null
    } catch { }
  }
  throw
}
`;
}

export async function enrollmentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/e/:token/install.sh", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findEnrollment(token);
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(shellScript(token, enrollment.hostname, await getPublicBaseUrl()));
  });

  app.get("/e/:token/install.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findEnrollment(token);
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/plain; charset=utf-8").send(powerShellScript(token, enrollment.hostname, await getPublicBaseUrl()));
  });

  app.post("/api/public/enrollments/claim", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = claimSchema.parse(request.body);
    const tokenHash = hashToken(body.token);
    const claimed = await pool.query(
      `UPDATE enrollments
          SET status = 'provisioning', claimed_at = now(), platform = $1, claimed_by = $2,
              install_id = $3, updated_at = now()
        WHERE token_hash = $4
          AND status IN ('url_issued', 'failed', 'provisioning', 'ready')
          AND expires_at > now()
          AND (claimed_at IS NULL OR install_id = $3 OR $5 = true)
      RETURNING id, store_id`,
      [body.platform, body.machineName ?? request.ip, body.installId ?? null, tokenHash, body.overrideExisting]
    );
    let enrollment = claimed.rows[0];
    if (!enrollment) {
      const expired = await pool.query(
        `UPDATE enrollments SET status = 'expired', updated_at = now()
          WHERE token_hash = $1 AND status IN ('url_issued', 'failed') AND expires_at <= now()
        RETURNING store_id`,
        [tokenHash]
      );
      if (expired.rows[0]) {
        await pool.query("UPDATE stores SET onboarding_status = 'expired', updated_at = now() WHERE id = $1", [expired.rows[0].store_id]);
        return reply.code(410).send({ error: "Enrollment has expired" });
      }
      const existing = await findEnrollment(body.token);
      const sameInstaller = existing?.install_id && body.installId && existing.install_id === body.installId;
      if (!existing || !sameInstaller || !["provisioning", "ready", "failed"].includes(existing.status)) {
        return reply.code(409).send({ error: "Enrollment is invalid or already claimed" });
      }
      enrollment = existing;
      if (existing.status === "failed") {
        await pool.query("UPDATE enrollments SET status = 'provisioning', last_error = null, updated_at = now() WHERE id = $1", [existing.id]);
      }
    }

    try {
      const provisioned = await provisionStore(enrollment.store_id);
      await pool.query("UPDATE enrollments SET status = 'ready', last_error = null, updated_at = now() WHERE id = $1", [enrollment.id]);
      if (request.headers.accept?.includes("text/plain")) {
        noStore(reply);
        return reply.type("text/plain").send(provisioned.tunnelToken);
      }
      noStore(reply);
      return provisioned;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provisioning failed";
      await pool.query("UPDATE enrollments SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2", [message, enrollment.id]);
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/api/public/enrollments/logs", {
    config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = logSchema.parse(request.body);
    const enrollment = await findEnrollment(body.token);
    if (!enrollment || enrollment.status === "revoked") return reply.code(404).send({ error: "Enrollment not found" });
    await withTransaction(async (client) => {
      for (const event of body.events) {
        const decodedMessage = event.messageBase64
          ? Buffer.from(event.messageBase64, "base64").toString("utf8").slice(0, 4000)
          : event.message!;
        await client.query(
          `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [enrollment.id, event.level, event.step ?? null, decodedMessage, JSON.stringify(event.metadata ?? {})]
        );
      }
    });
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.post("/api/public/enrollments/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = reportSchema.parse(request.body);
    const enrollment = await findEnrollment(body.token);
    if (!enrollment || enrollment.status === "revoked") return reply.code(404).send({ error: "Enrollment not found" });
    const success = body.status === "installed";
    if (success && !["provisioning", "ready", "installed"].includes(enrollment.status)) {
      return reply.code(409).send({ error: "Enrollment has not been provisioned" });
    }
    const retryablePreflightFailure = !success && enrollment.status === "url_issued" && !enrollment.claimed_at;
    let scheduleVerification = false;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE enrollments SET status = $1, installed_at = CASE WHEN $2 THEN now() ELSE installed_at END,
         last_error = $3, updated_at = now() WHERE id = $4`,
        [success ? "installed" : retryablePreflightFailure ? "url_issued" : "failed", success, body.error ?? null, enrollment.id]
      );
      const provider = await client.query(
        `SELECT a.provider_mode FROM stores s JOIN cloudflare_accounts a ON a.id = s.account_id WHERE s.id = $1`,
        [enrollment.store_id]
      );
      const isMock = provider.rows[0]?.provider_mode === "mock";
      scheduleVerification = success && !isMock;
      await client.query(
        `UPDATE stores SET onboarding_status = $1, tunnel_status = CASE WHEN $2 THEN 'healthy' ELSE tunnel_status END,
         cloudflared_version = $3, last_connected_at = CASE WHEN $2 THEN now() ELSE last_connected_at END,
         last_verified_at = CASE WHEN $2 THEN now() ELSE last_verified_at END, last_error = $4,
         rdp_status = CASE
           WHEN NOT $5 THEN rdp_status
           WHEN $6 <> 'windows' THEN 'disabled'
           WHEN $7 THEN 'enabled'
           ELSE 'failed'
         END,
         rdp_target_ip = COALESCE($8::inet, rdp_target_ip), rdp_port = COALESCE($9, rdp_port),
         rdp_last_error = $10, updated_at = now()
         WHERE id = $11`,
        [
          success ? (isMock ? "active" : "connector_online") : retryablePreflightFailure ? "url_issued" : "failed",
          success && isMock,
          body.version ?? null,
          body.error ?? null,
          success,
          enrollment.platform ?? "unknown",
          body.rdpEnabled ?? false,
          body.rdpTargetIp ?? null,
          body.rdpPort ?? null,
          body.rdpError ?? null,
          enrollment.store_id
        ]
      );
    });
    let rdp: Awaited<ReturnType<typeof provisionBrowserRdp>> | undefined;
    if (success && enrollment.platform === "windows") {
      rdp = body.rdpEnabled && body.rdpTargetIp
        ? await provisionBrowserRdp(enrollment.store_id)
        : { ready: false, error: body.rdpError ?? "Windows Remote Desktop was not enabled" };
    }
    if (scheduleVerification) scheduleStoreVerification(enrollment.store_id);
    return { success: true, ...(rdp ? { rdp } : {}) };
  });
}
