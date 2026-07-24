import type { FastifyInstance, FastifyReply } from "fastify";
import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "../config.js";
import { getPublicBaseUrl } from "../lib/app-settings.js";
import { pool, withTransaction } from "../lib/database.js";
import { deprovisionStore, provisionStore, withStoreCloudflareLock } from "../lib/provisioning.js";
import { provisionBrowserRdp } from "../lib/rdp.js";
import { hashToken } from "../lib/security.js";
import { scheduleStoreVerification } from "../lib/store-verification.js";
import { ensureCommandAgentToken } from "../lib/command-agent.js";

const tokenParams = z.object({ token: z.string().min(30).max(200) });
const claimSchema = z.object({
  token: z.string().min(30).max(200),
  platform: z.enum(["windows", "linux", "darwin", "unix"]),
  architecture: z.string().max(40).optional(),
  machineName: z.string().max(200).optional(),
  osName: z.string().max(200).optional(),
  osVersion: z.string().max(100).optional(),
  osBuild: z.string().max(100).optional(),
  installId: z.string().max(200).optional(),
  overrideExisting: z.boolean().default(false)
});
const reportSchema = z.object({
  token: z.string().min(30).max(200),
  platform: z.enum(["windows", "unix"]).optional(),
  status: z.enum(["installed", "failed"]),
  version: z.string().max(80).optional(),
  error: z.string().max(2000).optional(),
  rdpEnabled: z.boolean().optional(),
  rdpTargetIp: z.string().refine((value) => isIP(value) === 4, "RDP target must be an IPv4 address").optional(),
  rdpPort: z.number().int().min(1).max(65535).optional(),
  rdpError: z.string().max(2000).optional(),
  agentReady: z.boolean().optional(),
  agentError: z.string().max(2000).optional(),
  osName: z.string().max(200).optional(),
  osVersion: z.string().max(100).optional(),
  osBuild: z.string().max(100).optional(),
  architecture: z.string().max(40).optional(),
  machineName: z.string().max(200).optional()
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
const unenrollReportSchema = z.object({
  token: z.string().min(30).max(200),
  platform: z.enum(["windows", "unix"]),
  status: z.enum(["unenrolled", "failed"]),
  error: z.string().max(2000).optional()
});

async function findEnrollment(token: string) {
  const result = await pool.query(
    `SELECT e.id, e.store_id, e.status, e.expires_at, e.install_id, e.claimed_at, e.claimed_by, e.platform,
            e.deleted_at,
            e.host_info, s.hostname
       FROM enrollments e JOIN stores s ON s.id = e.store_id
      WHERE e.token_hash = $1 AND e.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return result.rows[0];
}

async function findUnenrollment(token: string) {
  const result = await pool.query(
    `SELECT e.id, e.store_id, e.status, e.unenroll_token_expires_at, e.unenrolled_at, e.deleted_at, s.hostname
       FROM enrollments e JOIN stores s ON s.id = e.store_id
      WHERE e.unenroll_token_hash = $1 AND e.deleted_at IS NULL`,
    [hashToken(token)]
  );
  return result.rows[0];
}

async function findEnrollmentScript(enrollmentId: string, scriptKind: "install" | "unenroll", platform: "windows" | "unix") {
  const result = await pool.query(
    `SELECT status, started_at, finished_at, last_error
       FROM enrollment_scripts
      WHERE enrollment_id = $1 AND script_kind = $2 AND platform = $3`,
    [enrollmentId, scriptKind, platform]
  );
  return result.rows[0];
}

function normalizeScriptPlatform(platform: string | null | undefined): "windows" | "unix" | null {
  if (!platform) return null;
  return platform === "windows" ? "windows" : "unix";
}

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, private");
  reply.header("X-Robots-Tag", "noindex, nofollow");
  reply.header("Referrer-Policy", "no-referrer");
}

async function commandAgentToken(storeId: string): Promise<string> {
  return ensureCommandAgentToken(pool, storeId);
}

export function unixAgentProgram(agentToken: string): string {
  return `#!/usr/bin/env python3
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "${agentToken}"
MAX_SCRIPT_BYTES = 65536
PORT = 47831

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/health") and self.headers.get("X-Cloudflare-Man-Agent-Token") == TOKEN:
            self.respond(200, {"ready": True})
        elif self.path.endswith("/health"):
            self.respond(401, {"error": "Invalid command agent token"})
        else:
            self.respond(404, {"error": "Not found"})

    def do_POST(self):
        if self.headers.get("X-Cloudflare-Man-Agent-Token") != TOKEN:
            self.respond(401, {"error": "Invalid command agent token"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_SCRIPT_BYTES + 4096:
                self.respond(413, {"error": "Request is too large"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            script = payload.get("script")
            timeout_ms = int(payload.get("timeoutMs", 60000))
            if not isinstance(script, str) or not script.strip():
                self.respond(400, {"error": "A script is required"})
                return
            if len(script.encode("utf-8")) > MAX_SCRIPT_BYTES:
                self.respond(413, {"error": "Script is too large"})
                return
            timeout_ms = max(1000, min(timeout_ms, 300000))
            started = time.monotonic()
            try:
                process = subprocess.run(
                    ["/bin/sh", "-lc", script],
                    capture_output=True,
                    text=True,
                    timeout=timeout_ms / 1000,
                    check=False
                )
                payload = {
                    "success": process.returncode == 0,
                    "exitCode": process.returncode,
                    "stdout": process.stdout[-20000:],
                    "stderr": process.stderr[-20000:],
                    "durationMs": round((time.monotonic() - started) * 1000)
                }
            except subprocess.TimeoutExpired as error:
                payload = {
                    "success": False,
                    "exitCode": None,
                    "stdout": (error.stdout or "")[-20000:] if isinstance(error.stdout, str) else "",
                    "stderr": (error.stderr or "")[-20000:] if isinstance(error.stderr, str) else "",
                    "durationMs": round((time.monotonic() - started) * 1000),
                    "error": "Script timed out"
                }
            self.respond(200, payload)
        except Exception as error:
            self.respond(400, {"error": str(error)[:2000]})

ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
`;
}

export function windowsAgentProgram(agentToken: string): string {
  return `$ErrorActionPreference = "Stop"
$Token = "${agentToken}"
$Port = 47831
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/")
$Listener.Start()

function Send-JsonResponse($Context, [int]$StatusCode, $Payload) {
  $json = $Payload | ConvertTo-Json -Compress -Depth 5
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $StatusCode
  $Context.Response.ContentType = "application/json"
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.Close()
}

while ($true) {
  $context = $Listener.GetContext()
  try {
    $path = $context.Request.Url.AbsolutePath
    if ($context.Request.HttpMethod -eq "GET" -and $path.EndsWith("/health") -and $context.Request.Headers["X-Cloudflare-Man-Agent-Token"] -eq $Token) {
      Send-JsonResponse $context 200 @{ ready = $true }
      continue
    }
    if ($context.Request.HttpMethod -eq "GET" -and $path.EndsWith("/health")) {
      Send-JsonResponse $context 401 @{ error = "Invalid command agent token" }
      continue
    }
    if ($context.Request.HttpMethod -ne "POST") {
      Send-JsonResponse $context 404 @{ error = "Not found" }
      continue
    }
    if ($context.Request.Headers["X-Cloudflare-Man-Agent-Token"] -ne $Token) {
      Send-JsonResponse $context 401 @{ error = "Invalid command agent token" }
      continue
    }
    $reader = New-Object IO.StreamReader($context.Request.InputStream, $context.Request.ContentEncoding)
    $body = $reader.ReadToEnd()
    $reader.Close()
    if ($body.Length -gt 70000) { Send-JsonResponse $context 413 @{ error = "Request is too large" }; continue }
    $request = $body | ConvertFrom-Json
    $script = [string]$request.script
    if ([string]::IsNullOrWhiteSpace($script)) { Send-JsonResponse $context 400 @{ error = "A script is required" }; continue }
    if ($script.Length -gt 65536) { Send-JsonResponse $context 413 @{ error = "Script is too large" }; continue }
    $timeoutMs = [Math]::Min([Math]::Max([int]$request.timeoutMs, 1000), 300000)
    $started = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell.exe"
    $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($timeoutMs)) {
      $process.Kill()
      $process.WaitForExit()
      $stdout = $stdoutTask.Result
      $stderr = $stderrTask.Result
      Send-JsonResponse $context 200 @{ success = $false; exitCode = $null; stdout = $stdout.Substring(0, [Math]::Min($stdout.Length, 20000)); stderr = $stderr.Substring(0, [Math]::Min($stderr.Length, 20000)); durationMs = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started); error = "Script timed out" }
      continue
    }
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    Send-JsonResponse $context 200 @{ success = ($process.ExitCode -eq 0); exitCode = $process.ExitCode; stdout = $stdout.Substring(0, [Math]::Min($stdout.Length, 20000)); stderr = $stderr.Substring(0, [Math]::Min($stderr.Length, 20000)); durationMs = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $started) }
  } catch {
    try { Send-JsonResponse $context 400 @{ error = $_.Exception.Message } } catch { }
  }
}
`;
}

export function shellScript(token: string, hostname: string, publicBaseUrl: string, agentToken: string): string {
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
AGENT_TOKEN='${agentToken}'
REPORT_SENT=0
TEMP_DIR=""
OS_DISPLAY_NAME="unknown"
OS_VERSION="unknown"
OS_BUILD="unknown"
MACHINE_ARCH="unknown"
MACHINE_NAME="unknown"

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
      --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"status\\":\\"failed\\",\\"platform\\":\\"unix\\",\\"error\\":\\"installer exited with code $exit_code\\",\\"osName\\":\\"$OS_DISPLAY_NAME\\",\\"osVersion\\":\\"$OS_VERSION\\",\\"osBuild\\":\\"$OS_BUILD\\",\\"architecture\\":\\"$MACHINE_ARCH\\",\\"machineName\\":\\"$MACHINE_NAME\\"}" >/dev/null || true
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
OS_VERSION="$(uname -r)"
OS_BUILD="$OS_VERSION"
if [ "$OS_NAME" = "darwin" ]; then
  OS_DISPLAY_NAME="macOS"
  OS_VERSION="$(sw_vers -productVersion 2>/dev/null || printf '%s' "$OS_VERSION")"
  OS_BUILD="$(sw_vers -buildVersion 2>/dev/null || printf '%s' "$OS_BUILD")"
elif [ "$OS_NAME" = "linux" ]; then
  OS_DISPLAY_NAME="Linux"
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    OS_DISPLAY_NAME="\${PRETTY_NAME:-Linux}"
    OS_VERSION="\${VERSION_ID:-$OS_VERSION}"
    OS_BUILD="\${BUILD_ID:-$OS_BUILD}"
  fi
else
  OS_DISPLAY_NAME="$OS_NAME"
fi
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
      if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now cloudflare-man-command-agent.service >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/cloudflare-man-command-agent.service
        systemctl daemon-reload >/dev/null 2>&1 || true
      fi
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
        rm -f /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist
      fi
      pkill -f "cloudflare-man/command-agent.py" >/dev/null 2>&1 || true
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
chmod 700 "$STATE_DIR"
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
CLAIM_BODY="$(printf '{\\"token\\":\\"%s\\",\\"platform\\":\\"%s\\",\\"architecture\\":\\"%s\\",\\"machineName\\":\\"%s\\",\\"osName\\":\\"%s\\",\\"osVersion\\":\\"%s\\",\\"osBuild\\":\\"%s\\",\\"installId\\":\\"%s\\",\\"overrideExisting\\":%s}' "$ENROLLMENT_TOKEN" "$OS_NAME" "$MACHINE_ARCH" "$MACHINE_NAME" "$OS_DISPLAY_NAME" "$OS_VERSION" "$OS_BUILD" "$INSTALL_ID" "$OVERRIDE_EXISTING")"
CLAIM_RESPONSE_FILE="$(mktemp)"
CLAIM_CURL_ERROR=0
CLAIM_STATUS="$(curl --silent --show-error --retry 3 --retry-all-errors --output "$CLAIM_RESPONSE_FILE" --write-out '%{http_code}' -X POST "$CLAIM_URL" -H 'Content-Type: application/json' -H 'Accept: text/plain' --data "$CLAIM_BODY")" || CLAIM_CURL_ERROR=$?
CLAIM_RESPONSE="$(cat "$CLAIM_RESPONSE_FILE")"
rm -f "$CLAIM_RESPONSE_FILE"
if [ "$CLAIM_CURL_ERROR" -ne 0 ] || [ "$CLAIM_STATUS" -lt 200 ] || [ "$CLAIM_STATUS" -ge 300 ]; then
  CLAIM_ERROR="Enrollment claim failed with HTTP $CLAIM_STATUS"
  if [ -n "$CLAIM_RESPONSE" ]; then CLAIM_ERROR="$CLAIM_ERROR: $CLAIM_RESPONSE"; fi
  log_message "error" "claim" "$CLAIM_ERROR"
  exit 1
fi
TUNNEL_TOKEN="$(printf '%s\\n' "$CLAIM_RESPONSE" | sed -n '1p')"
CLAIM_AGENT_TOKEN="$(printf '%s\\n' "$CLAIM_RESPONSE" | sed -n '2p')"
[ -n "$CLAIM_AGENT_TOKEN" ] && AGENT_TOKEN="$CLAIM_AGENT_TOKEN"
log_message "info" "claim" "Enrollment claimed successfully"
log_message "info" "service" "Installing the cloudflared service"
if ! SERVICE_OUTPUT="$(cloudflared service install "$TUNNEL_TOKEN" 2>&1)"; then
  log_message "error" "service" "$SERVICE_OUTPUT"
  exit 1
fi
if [ -n "$SERVICE_OUTPUT" ]; then log_message "info" "service" "$SERVICE_OUTPUT"; fi
if [ "$OS_NAME" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p /etc/systemd/system/cloudflared.service.d
  cat > /etc/systemd/system/cloudflared.service.d/10-cloudflare-man-restart.conf <<EOF
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=5
EOF
  systemctl daemon-reload
  systemctl enable --now cloudflared.service
  systemctl restart cloudflared.service
elif [ "$OS_NAME" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
  CLOUDFLARED_PLIST="/Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
  if [ ! -f "$CLOUDFLARED_PLIST" ] || ! command -v plutil >/dev/null 2>&1; then
    log_message "error" "service" "The cloudflared launchd service was not created"
    exit 1
  fi
  plutil -replace RunAtLoad -bool true "$CLOUDFLARED_PLIST" || plutil -insert RunAtLoad -bool true "$CLOUDFLARED_PLIST"
  plutil -replace KeepAlive -bool true "$CLOUDFLARED_PLIST" || plutil -insert KeepAlive -bool true "$CLOUDFLARED_PLIST"
  launchctl bootout system/com.cloudflare.cloudflared >/dev/null 2>&1 || true
  launchctl bootstrap system "$CLOUDFLARED_PLIST"
  launchctl enable system/com.cloudflare.cloudflared
else
  log_message "error" "service" "A supported service manager (systemd or launchd) is required"
  exit 1
fi
VERSION="$(cloudflared --version | head -n 1)"
AGENT_READY=false
AGENT_ERROR=""
AGENT_SCRIPT="$STATE_DIR/command-agent.py"
if ! command -v python3 >/dev/null 2>&1; then
  AGENT_ERROR="python3 is required to run the cloudflare-man command agent"
  log_message "error" "command-agent" "$AGENT_ERROR"
  exit 1
fi
PYTHON_BIN="$(command -v python3)"
log_message "info" "command-agent" "Installing the local command agent"
cat > "$AGENT_SCRIPT" <<'PYTHON'
${unixAgentProgram(agentToken)}
PYTHON
chmod 700 "$AGENT_SCRIPT"
if [ "$OS_NAME" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/cloudflare-man-command-agent.service <<EOF
[Unit]
Description=cloudflare-man command agent
After=network.target
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=$PYTHON_BIN $AGENT_SCRIPT
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now cloudflare-man-command-agent.service
elif [ "$OS_NAME" = "darwin" ] && command -v launchctl >/dev/null 2>&1; then
  cat > /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.cloudflare-man.command-agent</string>
<key>ProgramArguments</key><array><string>$PYTHON_BIN</string><string>$AGENT_SCRIPT</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/var/log/cloudflare-man-command-agent.log</string>
<key>StandardErrorPath</key><string>/var/log/cloudflare-man-command-agent.error.log</string>
</dict></plist>
EOF
  launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
  launchctl bootstrap system /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist
  launchctl enable system/dev.cloudflare-man.command-agent
else
  log_message "error" "command-agent" "A supported service manager (systemd or launchd) is required"
  exit 1
fi
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --silent --show-error --fail --max-time 2 -H "X-Cloudflare-Man-Agent-Token: $AGENT_TOKEN" http://127.0.0.1:47831/health >/dev/null 2>&1; then AGENT_READY=true; break; fi
  sleep 1
done
if [ "$AGENT_READY" != true ]; then
  AGENT_ERROR="The local command agent did not become ready"
  log_message "error" "command-agent" "$AGENT_ERROR"
  exit 1
fi
log_message "info" "command-agent" "Local command agent is ready"
log_message "info" "report" "Reporting successful installation"
curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$REPORT_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$ENROLLMENT_TOKEN\\",\\"status\\":\\"installed\\",\\"platform\\":\\"unix\\",\\"version\\":\\"$VERSION\\",\\"agentReady\\":$AGENT_READY,\\"osName\\":\\"$OS_DISPLAY_NAME\\",\\"osVersion\\":\\"$OS_VERSION\\",\\"osBuild\\":\\"$OS_BUILD\\",\\"architecture\\":\\"$MACHINE_ARCH\\",\\"machineName\\":\\"$MACHINE_NAME\\"}" >/dev/null
REPORT_SENT=1
printf '%s' "$ASSIGNED_HOSTNAME" > "$HOSTNAME_FILE"
chmod 600 "$HOSTNAME_FILE"
log_message "info" "complete" "Store tunnel installed successfully for $ASSIGNED_HOSTNAME"

echo "Store tunnel installed: $ASSIGNED_HOSTNAME"
`;
}

export function powerShellScript(token: string, hostname: string, publicBaseUrl: string, agentToken: string): string {
  return `$ErrorActionPreference = "Stop"
$EnrollmentToken = "${token}"
$CloudflaredVersion = "${config.CLOUDFLARED_VERSION}"
$ClaimUrl = "${publicBaseUrl}/api/public/enrollments/claim"
$ReportUrl = "${publicBaseUrl}/api/public/enrollments/report"
$AssignedHostname = "${hostname}"
$AgentToken = "${agentToken}"
$ReportSent = $false
$LogUrl = "${publicBaseUrl}/api/public/enrollments/logs"
$architecture = "unknown"
$osName = "unknown"
$osVersion = "unknown"
$osBuild = "unknown"
$machineName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { "unknown" }

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

function Get-HttpErrorMessage {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  $message = $ErrorRecord.Exception.Message
  try {
    $response = $ErrorRecord.Exception.Response
    $body = $null
    if ($response -and $response.Content) {
      $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    } elseif ($response) {
      $stream = $response.GetResponseStream()
      if ($stream) {
        $reader = New-Object System.IO.StreamReader($stream)
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
      }
    }
    if ($body) {
      $payload = $body | ConvertFrom-Json
      if ($payload.error) { return [string]$payload.error }
      return $body
    }
  } catch { }
  return $message
}

try {
Send-InstallLog -Level "info" -Step "preflight" -Message "Starting cloudflare-man enrollment for $AssignedHostname"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Send-InstallLog -Level "error" -Step "preflight" -Message "Run PowerShell as Administrator."
  throw "Run PowerShell as Administrator."
}

$architecture = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$osInfo = Get-CimInstance Win32_OperatingSystem
$osName = [string]$osInfo.Caption
$osVersion = [string]$osInfo.Version
$osBuild = [string]$osInfo.BuildNumber
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
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # cloudflared writes informational messages to stderr. PowerShell 5.1
      # turns native stderr into ErrorRecord objects when the global policy is Stop.
      $ErrorActionPreference = "Continue"
      $cleanupOutput = @(& $binary service uninstall 2>&1)
      $cleanupExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $cleanupOutput) { Send-InstallLog -Level "info" -Step "cleanup" -Message $line.ToString() }
    if ($cleanupExitCode -ne 0) {
      $remainingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
      if ($remainingService) {
        Send-InstallLog -Level "warn" -Step "cleanup" -Message "cloudflared uninstall exited with code $cleanupExitCode; removing the remaining service"
        Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
      }
    }
  } elseif ($existingService) {
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
  }
  Stop-ScheduledTask -TaskName "CloudflareManCommandAgent" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "CloudflareManCommandAgent" -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*cloudflare-man*command-agent.ps1*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  if (Test-Path $stateDirectory) { Remove-Item $stateDirectory -Recurse -Force }
  $overrideExisting = $true
}
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
& icacls.exe $stateDirectory /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
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
  machineName = $machineName
  osName = $osName
  osVersion = $osVersion
  osBuild = $osBuild
  installId = $installId
  overrideExisting = $overrideExisting
} | ConvertTo-Json
try {
  $claim = Invoke-RestMethod -Method Post -Uri $ClaimUrl -ContentType "application/json" -Body $claimBody
} catch {
  $claimError = Get-HttpErrorMessage -ErrorRecord $_
  Send-InstallLog -Level "error" -Step "claim" -Message $claimError
  throw $claimError
}
Send-InstallLog -Level "info" -Step "claim" -Message "Enrollment claimed successfully"

Send-InstallLog -Level "info" -Step "service" -Message "Installing the cloudflared service"
$serviceOutput = & $binary service install $claim.tunnelToken 2>&1
$serviceExitCode = $LASTEXITCODE
foreach ($line in $serviceOutput) { Send-InstallLog -Level "info" -Step "service" -Message $line.ToString() }
if ($serviceExitCode -ne 0) { throw "cloudflared service installation failed with exit code $serviceExitCode." }
Set-Service -Name "cloudflared" -StartupType Automatic
& sc.exe failure cloudflared reset= 86400 actions= restart/5000/restart/10000/restart/60000 | Out-Null
Start-Service -Name "cloudflared" -ErrorAction SilentlyContinue

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

$agentReady = $false
$agentError = $null
try {
  Send-InstallLog -Level "info" -Step "command-agent" -Message "Installing the local command agent"
  $agentScript = Join-Path $stateDirectory "command-agent.ps1"
  $agentProgram = @'
${windowsAgentProgram(agentToken)}
'@
  Set-Content -Path $agentScript -Value $agentProgram -Encoding UTF8
  $taskName = "CloudflareManCommandAgent"
  $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \`"$agentScript\`""
  $taskTrigger = New-ScheduledTaskTrigger -AtStartup
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $health = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:47831/health" -Headers @{ "X-Cloudflare-Man-Agent-Token" = $AgentToken } -TimeoutSec 2
      if ($health.ready) { $agentReady = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $agentReady) { throw "The local command agent did not become ready" }
  Send-InstallLog -Level "info" -Step "command-agent" -Message "Local command agent is ready"
} catch {
  $agentError = $_.Exception.Message
  Send-InstallLog -Level "error" -Step "command-agent" -Message $agentError
  throw
}

$reportPayload = @{
  token = $EnrollmentToken
  platform = "windows"
  status = "installed"
  version = (& $binary --version | Select-Object -First 1)
  rdpEnabled = $rdpEnabled
  rdpPort = 3389
  agentReady = $agentReady
  osName = $osName
  osVersion = $osVersion
  osBuild = $osBuild
  architecture = $architecture
  machineName = $machineName
}
if ($rdpTargetIp) { $reportPayload.rdpTargetIp = $rdpTargetIp }
if ($rdpError) { $reportPayload.rdpError = $rdpError }
if ($agentError) { $reportPayload.agentError = $agentError }
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
      $failureBody = @{ token = $EnrollmentToken; platform = "windows"; status = "failed"; error = $_.Exception.Message; osName = $osName; osVersion = $osVersion; osBuild = $osBuild; architecture = $architecture; machineName = $machineName } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $failureBody | Out-Null
    } catch { }
  }
  throw
}
`;
}

function shellUnenrollScript(token: string, hostname: string, publicBaseUrl: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/report`;
  const logUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/logs`;
  return `#!/usr/bin/env bash
set -euo pipefail

UNENROLL_TOKEN='${token}'
CLAIM_URL='${claimUrl}'
REPORT_URL='${reportUrl}'
LOG_URL='${logUrl}'
REPORT_SENT=0

send_log() {
  level="$1"
  message="$(printf '%s' "$3" | cut -c1-3500)"
  encoded_message="$(printf '%s' "$message" | base64 | tr -d '\\r\\n')"
  curl --silent --show-error --fail --max-time 10 -X POST "$LOG_URL" -H 'Content-Type: application/json' --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"events\\":[{\\"level\\":\\"$level\\",\\"step\\":\\"cleanup\\",\\"messageBase64\\":\\"$encoded_message\\"}]}" >/dev/null 2>&1 || true
}

report_failure() {
  exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ "$REPORT_SENT" -eq 0 ]; then
    curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$REPORT_URL" \\
      -H 'Content-Type: application/json' \\
      --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"platform\\":\\"unix\\",\\"status\\":\\"failed\\",\\"error\\":\\"cleanup exited with code $exit_code\\"}" >/dev/null || true
  fi
  exit "$exit_code"
}
trap report_failure EXIT
echo "Unenrolling cloudflare-man instance for ${hostname}"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this command as root (sudo)." >&2
  exit 1
fi
curl --silent --show-error --fail --retry 2 --retry-all-errors -X POST "$CLAIM_URL" \\
  -H 'Content-Type: application/json' \\
  --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"platform\\":\\"unix\\"}" >/dev/null
send_log "info" "cleanup" "Unenrollment script claimed for unix"
send_log "info" "cleanup" "Stopping and removing the cloudflared service"
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared service uninstall >/dev/null 2>&1 || true
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now cloudflare-man-command-agent.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cloudflare-man-command-agent.service
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout system/dev.cloudflare-man.command-agent >/dev/null 2>&1 || true
  rm -f /Library/LaunchDaemons/dev.cloudflare-man.command-agent.plist
fi
rm -rf "/var/lib/cloudflare-man" "/Library/Application Support/cloudflare-man"
curl --silent --show-error --fail --retry 3 --retry-all-errors -X POST "$REPORT_URL" \\
  -H 'Content-Type: application/json' \\
  --data "{\\"token\\":\\"$UNENROLL_TOKEN\\",\\"platform\\":\\"unix\\",\\"status\\":\\"unenrolled\\"}" >/dev/null
REPORT_SENT=1
echo "Cloudflare tunnel instance unenrolled successfully."
`;
}

function powerShellUnenrollScript(token: string, hostname: string, publicBaseUrl: string): string {
  const claimUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/claim`;
  const reportUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/report`;
  const logUrl = `${publicBaseUrl}/api/public/enrollments/unenroll/logs`;
  return `$ErrorActionPreference = "Stop"
$UnenrollToken = "${token}"
$ClaimUrl = "${claimUrl}"
$ReportUrl = "${reportUrl}"
$LogUrl = "${logUrl}"
$ReportSent = $false

function Send-CleanupLog {
  param([string]$Level, [string]$Message)
  Write-Host "[cleanup] $Message"
  try {
    $body = @{ token = $UnenrollToken; events = @(@{ level = $Level; step = "cleanup"; message = $Message }) } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri $LogUrl -ContentType "application/json" -Body $body -TimeoutSec 10 | Out-Null
  } catch { }
}

try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run PowerShell as Administrator." }
  Invoke-RestMethod -Method Post -Uri $ClaimUrl -ContentType "application/json" -Body (@{ token = $UnenrollToken; platform = "windows" } | ConvertTo-Json) | Out-Null
  Send-CleanupLog -Level "info" -Message "Unenrollment script claimed for windows"
  Send-CleanupLog -Level "info" -Message "Stopping and removing the cloudflared service for ${hostname}"
  $binary = Join-Path $env:ProgramFiles "cloudflared\\cloudflared.exe"
  if (Test-Path $binary) {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      # cloudflared writes INF messages to stderr even when uninstall succeeds.
      # Capture native output without promoting it to a terminating PowerShell error.
      $ErrorActionPreference = "Continue"
      $uninstallOutput = @(& $binary service uninstall 2>&1)
      $uninstallExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    foreach ($line in $uninstallOutput) { Send-CleanupLog -Level "info" -Message $line.ToString() }
    if ($uninstallExitCode -ne 0) {
      $remainingService = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
      if ($remainingService) {
        Send-CleanupLog -Level "warn" -Message "cloudflared uninstall exited with code $uninstallExitCode; removing the remaining service"
        Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
        Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
      } else {
        Send-CleanupLog -Level "warn" -Message "cloudflared uninstall exited with code $uninstallExitCode, but the service is already absent"
      }
    }
  }
  Stop-ScheduledTask -TaskName "CloudflareManCommandAgent" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "CloudflareManCommandAgent" -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*cloudflare-man*command-agent.ps1*" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null }
  $service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
  if ($service) {
    Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath (Join-Path $env:SystemRoot "System32\\sc.exe") -ArgumentList "delete", "cloudflared" -Wait -NoNewWindow
  }
  $stateDirectory = Join-Path $env:ProgramData "cloudflare-man"
  if (Test-Path $stateDirectory) { Remove-Item $stateDirectory -Recurse -Force }
  $body = @{ token = $UnenrollToken; platform = "windows"; status = "unenrolled" } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $body | Out-Null
  $ReportSent = $true
  Write-Host "Cloudflare tunnel instance unenrolled successfully."
} catch {
  Send-CleanupLog -Level "error" -Message $_.Exception.Message
  if (-not $ReportSent) {
    try {
      $body = @{ token = $UnenrollToken; platform = "windows"; status = "failed"; error = $_.Exception.Message } | ConvertTo-Json
      Invoke-RestMethod -Method Post -Uri $ReportUrl -ContentType "application/json" -Body $body | Out-Null
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
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "install", "unix") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This unix installer is staled - ignored because the Windows installer already started.\n");
    }
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(shellScript(token, enrollment.hostname, await getPublicBaseUrl(), await commandAgentToken(enrollment.store_id)));
  });

  app.get("/e/:token/install.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findEnrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "install", "windows") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This Windows installer is staled - ignored because the Unix installer already started.\n");
    }
    if (!enrollment || !["url_issued", "failed"].includes(enrollment.status) || new Date(enrollment.expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Enrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/plain; charset=utf-8").send(powerShellScript(token, enrollment.hostname, await getPublicBaseUrl(), await commandAgentToken(enrollment.store_id)));
  });

  app.get("/e/:token/unenroll.sh", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findUnenrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "unenroll", "unix") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This unix unenrollment script is staled - ignored because the Windows script already started.\n");
    }
    if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Unenrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/x-shellscript; charset=utf-8").send(shellUnenrollScript(token, enrollment.hostname, await getPublicBaseUrl()));
  });

  app.get("/e/:token/unenroll.ps1", async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const enrollment = await findUnenrollment(token);
    const script = enrollment ? await findEnrollmentScript(enrollment.id, "unenroll", "windows") : null;
    if (script?.status === "staled_ignored") {
      return reply.code(410).type("text/plain").send("This Windows unenrollment script is staled - ignored because the Unix script already started.\n");
    }
    if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) {
      return reply.code(404).type("text/plain").send("Unenrollment URL is invalid or expired.\n");
    }
    noStore(reply);
    return reply.type("text/plain; charset=utf-8").send(powerShellUnenrollScript(token, enrollment.hostname, await getPublicBaseUrl()));
  });

  app.post("/api/public/enrollments/claim", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = claimSchema.parse(request.body);
    const tokenHash = hashToken(body.token);
    const claimed = await pool.query(
      `UPDATE enrollments
          SET status = 'provisioning', claimed_at = now(), platform = $1, claimed_by = $2,
              install_id = $3,
              host_info = host_info || jsonb_strip_nulls(jsonb_build_object(
                'osName', $6::text, 'osVersion', $7::text, 'osBuild', $8::text,
                'architecture', $9::text, 'machineName', $10::text
              )),
              updated_at = now()
        WHERE token_hash = $4
          AND status IN ('url_issued', 'failed', 'provisioning', 'ready')
          AND deleted_at IS NULL
          AND expires_at > now()
          AND (claimed_at IS NULL OR install_id = $3 OR $5 = true)
      RETURNING id, store_id`,
      [body.platform, body.machineName ?? request.ip, body.installId ?? null, tokenHash, body.overrideExisting, body.osName ?? null, body.osVersion ?? null, body.osBuild ?? null, body.architecture ?? null, body.machineName ?? null]
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

    const scriptPlatform = normalizeScriptPlatform(body.platform)!;
    await pool.query(
      `UPDATE enrollment_scripts
          SET status = CASE WHEN platform = $1 THEN 'running' ELSE 'staled_ignored' END,
              started_at = CASE WHEN platform = $1 THEN COALESCE(started_at, now()) ELSE started_at END,
              finished_at = CASE WHEN platform = $1 THEN null ELSE finished_at END,
              last_error = CASE WHEN platform = $1 THEN null ELSE last_error END,
              updated_at = now()
        WHERE enrollment_id = $2 AND script_kind = 'install'`,
      [scriptPlatform, enrollment.id]
    );

    try {
      const provision = async (lockClient?: PoolClient) => {
        if (body.overrideExisting) {
          const previousEnrollments = await pool.query(
            `SELECT id
               FROM enrollments
              WHERE store_id = $1
                AND id <> $2
                AND status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND unenrolled_at IS NULL
                AND deleted_at IS NULL
              ORDER BY COALESCE(installed_at, claimed_at, created_at) DESC`,
            [enrollment.store_id, enrollment.id]
          );
          if (previousEnrollments.rowCount) {
            // Hold the store lock until the replacement tunnel is provisioned,
            // preventing a late cleanup report from deleting the new tunnel.
            await deprovisionStore(enrollment.store_id, "override", lockClient);
          }
          await pool.query(
            `UPDATE enrollments
                SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()),
                    unenroll_reason = 'override', unenroll_token_hash = null,
                    unenroll_token_expires_at = null, unenroll_requested_at = null,
                    unenroll_last_error = null, updated_at = now()
              WHERE store_id = $1
                AND id <> $2
                AND status IN ('claimed', 'provisioning', 'ready', 'installed')
                AND unenrolled_at IS NULL
                AND deleted_at IS NULL`,
            [enrollment.store_id, enrollment.id]
          );
          await pool.query(
            `UPDATE enrollment_scripts
                SET status = 'staled_ignored', finished_at = COALESCE(finished_at, now()),
                    last_error = 'Skipped because a new enrollment overrode this instance', updated_at = now()
              WHERE script_kind = 'unenroll'
                AND enrollment_id IN (
                  SELECT id FROM enrollments
                   WHERE store_id = $2 AND id <> $1 AND unenroll_reason = 'override'
                )`,
            [enrollment.id, enrollment.store_id]
          );
        }
        return provisionStore(enrollment.store_id);
      };
      const provisioned = body.overrideExisting
        ? await withStoreCloudflareLock(enrollment.store_id, provision)
        : await provision();
      const agentToken = await commandAgentToken(enrollment.store_id);
      await pool.query("UPDATE enrollments SET status = 'ready', last_error = null, updated_at = now() WHERE id = $1", [enrollment.id]);
      if (request.headers.accept?.includes("text/plain")) {
        noStore(reply);
        return reply.type("text/plain").send(`${provisioned.tunnelToken}\n${agentToken}`);
      }
      noStore(reply);
      return { ...provisioned, agentToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provisioning failed";
      await pool.query("UPDATE enrollments SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2", [message, enrollment.id]);
      await pool.query(
        `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata)
         VALUES ($1, 'error', 'claim', $2, '{"source":"server"}'::jsonb)`,
        [enrollment.id, message.slice(0, 4000)]
      );
      await pool.query(
        `UPDATE enrollment_scripts
            SET status = 'failed', finished_at = now(), last_error = $1, updated_at = now()
          WHERE enrollment_id = $2 AND script_kind = 'install' AND platform = $3`,
        [message, enrollment.id, scriptPlatform]
      );
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

  app.post("/api/public/enrollments/unenroll/logs", {
    config: { rateLimit: { max: 100, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = logSchema.parse(request.body);
    const enrollment = await findUnenrollment(body.token);
    if (!enrollment || enrollment.unenrolled_at) return reply.code(404).send({ error: "Unenrollment not found" });
    await withTransaction(async (client) => {
      for (const event of body.events) {
        const decodedMessage = event.messageBase64
          ? Buffer.from(event.messageBase64, "base64").toString("utf8").slice(0, 4000)
          : event.message!;
        await client.query(
          `INSERT INTO enrollment_logs(enrollment_id, level, step, message, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [enrollment.id, event.level, event.step ?? "cleanup", decodedMessage, JSON.stringify(event.metadata ?? {})]
        );
      }
    });
    return reply.code(202).send({ accepted: body.events.length });
  });

  app.post("/api/public/enrollments/unenroll/claim", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = z.object({
      token: z.string().min(30).max(200),
      platform: z.enum(["windows", "unix"])
    }).parse(request.body);
    const result = await withTransaction(async (client) => {
      const enrollmentResult = await client.query(
        `SELECT id, unenrolled_at, unenroll_token_expires_at
           FROM enrollments
          WHERE unenroll_token_hash = $1
          FOR UPDATE`,
        [hashToken(body.token)]
      );
      const enrollment = enrollmentResult.rows[0];
      if (!enrollment || enrollment.unenrolled_at || !enrollment.unenroll_token_expires_at || new Date(enrollment.unenroll_token_expires_at) <= new Date()) return null;
      await client.query(
        `UPDATE enrollment_scripts
            SET status = CASE WHEN platform = $1 THEN 'running' ELSE 'staled_ignored' END,
                started_at = CASE WHEN platform = $1 THEN COALESCE(started_at, now()) ELSE started_at END,
                finished_at = CASE WHEN platform = $1 THEN null ELSE finished_at END,
                last_error = CASE WHEN platform = $1 THEN null ELSE last_error END,
                updated_at = now()
          WHERE enrollment_id = $2 AND script_kind = 'unenroll'`,
        [body.platform, enrollment.id]
      );
      return enrollment.id as string;
    });
    if (!result) return reply.code(409).send({ error: "Unenrollment URL is invalid, expired, or already completed" });
    return { success: true, enrollmentId: result, platform: body.platform };
  });

  app.post("/api/public/enrollments/unenroll/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = unenrollReportSchema.parse(request.body);
    const enrollment = await findUnenrollment(body.token);
    if (!enrollment) return reply.code(404).send({ error: "Unenrollment not found" });
    if (body.status === "failed") {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE enrollments SET unenroll_last_error = $1, updated_at = now() WHERE id = $2`,
          [body.error ?? "Unenrollment failed", enrollment.id]
        );
        await client.query(
          `UPDATE enrollment_scripts
              SET status = 'failed', finished_at = now(), last_error = $1, updated_at = now()
            WHERE enrollment_id = $2 AND script_kind = 'unenroll' AND platform = $3`,
          [body.error ?? "Unenrollment failed", enrollment.id, body.platform]
        );
      });
      return { success: false };
    }
    try {
      const completed = await withStoreCloudflareLock(enrollment.store_id, async (lockClient) => {
        const stillCurrent = await pool.query(
          `SELECT 1
             FROM enrollments
            WHERE id = $1 AND store_id = $2 AND unenroll_token_hash = $3
              AND unenrolled_at IS NULL AND deleted_at IS NULL
              AND unenroll_token_expires_at > now()`,
          [enrollment.id, enrollment.store_id, hashToken(body.token)]
        );
        if (!stillCurrent.rowCount) return false;
        // The local script has already stopped its services. The server now
        // removes DNS, WAF, RDP and tunnel resources before success is stored.
        await deprovisionStore(enrollment.store_id, "unenroll", lockClient);
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE enrollments
                SET status = 'unenrolled', unenrolled_at = COALESCE(unenrolled_at, now()), unenroll_reason = 'script', unenroll_last_error = null, updated_at = now()
              WHERE id = $1`,
            [enrollment.id]
          );
          await client.query(
            `UPDATE enrollment_scripts
                SET status = 'completed', finished_at = now(), last_error = null, updated_at = now()
              WHERE enrollment_id = $1 AND script_kind = 'unenroll' AND platform = $2`,
            [enrollment.id, body.platform]
          );
        });
        return true;
      });
      if (!completed) return reply.code(409).send({ success: false, error: "Unenrollment was superseded by a newer enrollment" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cloudflare cleanup failed";
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE enrollments SET unenroll_last_error = $1, updated_at = now() WHERE id = $2`,
          [message, enrollment.id]
        );
        await client.query(
          `UPDATE enrollment_scripts
              SET status = 'failed', finished_at = now(), last_error = $1, updated_at = now()
            WHERE enrollment_id = $2 AND script_kind = 'unenroll' AND platform = $3`,
          [message, enrollment.id, body.platform]
        );
      });
      return reply.code(502).send({ success: false, error: message });
    }
    return { success: true };
  });

  app.post("/api/public/enrollments/report", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const body = reportSchema.parse(request.body);
    const enrollment = await findEnrollment(body.token);
    if (!enrollment || enrollment.status === "revoked") return reply.code(404).send({ error: "Enrollment not found" });
    const success = body.status === "installed";
    const reportPlatform = body.platform ?? normalizeScriptPlatform(enrollment.platform);
    if (body.platform && enrollment.platform && reportPlatform !== normalizeScriptPlatform(enrollment.platform)) {
      return reply.code(409).send({ error: "The report platform does not match the claimed installer" });
    }
    if (success && !["provisioning", "ready", "installed"].includes(enrollment.status)) {
      return reply.code(409).send({ error: "Enrollment has not been provisioned" });
    }
    const retryablePreflightFailure = !success && enrollment.status === "url_issued" && !enrollment.claimed_at;
    let scheduleVerification = false;
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE enrollments SET status = $1, installed_at = CASE WHEN $2 THEN now() ELSE installed_at END,
         last_error = $3, host_info = host_info || $5::jsonb, updated_at = now() WHERE id = $4`,
        [
          success ? "installed" : retryablePreflightFailure ? "url_issued" : "failed",
          success,
          body.error ?? null,
          enrollment.id,
          JSON.stringify(Object.fromEntries(Object.entries({
            osName: body.osName,
            osVersion: body.osVersion,
            osBuild: body.osBuild,
            architecture: body.architecture,
            machineName: body.machineName
          }).filter(([, value]) => value !== undefined)))
        ]
      );
      if (reportPlatform) {
        await client.query(
          `UPDATE enrollment_scripts
              SET status = $1, finished_at = now(), last_error = $2, updated_at = now()
            WHERE enrollment_id = $3 AND script_kind = 'install' AND platform = $4`,
          [success ? "completed" : "failed", body.error ?? null, enrollment.id, reportPlatform]
        );
      }
      if (body.agentReady !== undefined || body.agentError) {
        await client.query(
          `UPDATE store_command_agents
              SET status = $1, last_seen_at = CASE WHEN $2 THEN now() ELSE last_seen_at END,
                  last_error = $3, updated_at = now()
            WHERE store_id = $4`,
          [body.agentReady ? "ready" : "failed", body.agentReady ?? false, body.agentError ?? null, enrollment.store_id]
        );
      }
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
