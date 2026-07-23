import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pool: (typeof import("../src/lib/database.js"))["pool"];
let sessionCookie = "";
let accountId = "";
let storeId = "";
let enrollmentToken = "";
let enrollmentId = "";
let scriptVersionId = "";

before(async () => {
  const database = await import("../src/lib/database.js");
  pool = database.pool;
  await database.runMigrations();
  await database.seedRootUser();
  await pool.query(`
    TRUNCATE audit_logs, store_command_executions, managed_script_versions, managed_scripts, app_settings, enrollments, stores, zones, cloudflare_accounts, sessions RESTART IDENTITY CASCADE
  `);
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

test("default root account can sign in", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "root", password: "12345678" }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().user.mustChangePassword, true);
  sessionCookie = response.headers["set-cookie"]!.split(";")[0]!;
});

test("updates the public base URL used by enrollment URLs", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/settings",
    headers: { cookie: sessionCookie },
    payload: { publicBaseUrl: "cfman.example.test" }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().settings.publicBaseUrl, "https://cfman.example.test");

  const allowedHost = await app.inject({ method: "GET", url: "/api/accounts", headers: { host: "cfman.example.test", cookie: sessionCookie } });
  assert.equal(allowedHost.statusCode, 200, allowedHost.body);
  const blockedHost = await app.inject({ method: "GET", url: "/api/accounts", headers: { host: "unexpected.example.test", cookie: sessionCookie } });
  assert.equal(blockedHost.statusCode, 421, blockedHost.body);
});

test("creates a mock account with its first zone", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Test Account A",
      providerMode: "mock",
      initialZoneName: "stores-a.example",
      softTunnelLimit: 750
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  accountId = response.json().id;
  assert.match(accountId, /^[0-9a-f-]{36}$/);
});

test("deletes an empty account and its zones", async () => {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/accounts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Disposable Account",
      providerMode: "mock",
      initialZoneName: "disposable.example",
      softTunnelLimit: 10
    }
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const disposableAccountId = createResponse.json().id;

  const response = await app.inject({
    method: "DELETE",
    url: `/api/accounts/${disposableAccountId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 204, response.body);
  const account = await pool.query("SELECT 1 FROM cloudflare_accounts WHERE id = $1", [disposableAccountId]);
  const zones = await pool.query("SELECT 1 FROM zones WHERE account_id = $1", [disposableAccountId]);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'account.deleted' AND entity_id = $1", [disposableAccountId]);
  assert.equal(account.rowCount, 0);
  assert.equal(zones.rowCount, 0);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.cloudflareResourcesDeleted, false);
});

test("validates an account-owned Cloudflare API token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.cloudflare.com/client/v4/accounts/cloudflare-account-id/tokens/verify");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer cloudflare-api-token");
    return new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: { id: "token-id", status: "active" }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/accounts/validate-token",
      headers: { cookie: sessionCookie },
      payload: { cfAccountId: "cloudflare-account-id", apiToken: "cloudflare-api-token" }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { valid: true, status: "active" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synchronizes the account pool", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/accounts/sync-all",
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().success, true);
  assert.equal(response.json().results[0].id, accountId);
});

test("configures RDP operator access", async () => {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/accounts/${accountId}/rdp-settings`,
    headers: { cookie: sessionCookie },
    payload: { rdpAllowedEmails: ["ops@dcorp.example"] }
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = await pool.query("SELECT rdp_allowed_emails FROM cloudflare_accounts WHERE id = $1", [accountId]);
  assert.deepEqual(result.rows[0].rdp_allowed_emails, ["ops@dcorp.example"]);
});

test("creates and versions a platform-specific managed script", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/scripts",
    headers: { cookie: sessionCookie },
    payload: {
      name: "Store readiness check",
      platform: "windows",
      language: "powershell",
      description: "Checks the active store host",
      content: "Write-Output 'ready v1'"
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.match(created.json().id, /^[0-9a-f-]{36}$/);
  const version = await app.inject({
    method: "POST",
    url: `/api/scripts/${created.json().id}/versions`,
    headers: { cookie: sessionCookie },
    payload: { content: "Write-Output 'ready v2'" }
  });
  assert.equal(version.statusCode, 201, version.body);
  assert.equal(version.json().version, 2);
  scriptVersionId = version.json().versionId;

  const list = await app.inject({ method: "GET", url: "/api/scripts?platform=windows&name=READINESS", headers: { cookie: sessionCookie } });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().scripts.length, 1);
  assert.equal(list.json().scripts[0].latestVersion, 2);
  assert.equal(list.json().scripts[0].latestVersionId, scriptVersionId);
  const noMatch = await app.inject({ method: "GET", url: "/api/scripts?platform=windows&name=missing", headers: { cookie: sessionCookie } });
  assert.equal(noMatch.statusCode, 200, noMatch.body);
  assert.equal(noMatch.json().scripts.length, 0);
  const detail = await app.inject({ method: "GET", url: `/api/scripts/${created.json().id}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(detail.json().script.versions.map((item: { version: number }) => item.version), [2, 1]);
});

test("allocates a store and issues bootstrap URLs", async () => {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/stores",
    headers: { cookie: sessionCookie },
    payload: {
      tenantCode: "HLC",
      storeCode: "0001",
      displayName: "Highlands Test Store",
      publications: [
        {
          suffix: "",
          routes: [
            { path: "/", serviceUrl: "http://localhost:8080" },
            { path: "/api", serviceUrl: "http://localhost:8081" }
          ]
        },
        {
          suffix: "admin",
          routes: [{ path: "/", serviceUrl: "http://192.168.10.20:9000" }]
        }
      ]
    }
  });
  assert.equal(createResponse.statusCode, 201, createResponse.body);
  const store = createResponse.json().store;
  storeId = store.id;
  assert.equal(store.accountId, accountId);
  assert.equal(store.hostname, "0001.stores-a.example");
  assert.equal(store.publications.length, 2);
  assert.equal(store.publications[0].routes.length, 2);

  const enrollmentResponse = await app.inject({
    method: "POST",
    url: `/api/stores/${storeId}/enrollments`,
    headers: { cookie: sessionCookie },
    payload: { expiresInHours: 24 }
  });
  assert.equal(enrollmentResponse.statusCode, 201, enrollmentResponse.body);
  const enrollment = enrollmentResponse.json();
  enrollmentId = enrollment.id;
  assert.match(enrollment.urls.shell, /^https:\/\/cfman\.example\.test\/e\//);
  const match = enrollment.urls.shell.match(/\/e\/([^/]+)\/install\.sh$/);
  assert.ok(match);
  enrollmentToken = match[1];

  const scriptResponse = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.sh` });
  assert.equal(scriptResponse.statusCode, 200);
  assert.match(scriptResponse.body, /cloudflared service install/);
  assert.match(scriptResponse.body, /0001\.stores-a\.example/);
  assert.match(scriptResponse.body, /install-id/);
  assert.match(scriptResponse.body, /status\\":\\"failed/);
  assert.match(scriptResponse.body, /https:\/\/cfman\.example\.test\/api\/public\/enrollments\/claim/);
  assert.match(scriptResponse.body, /api\/public\/enrollments\/logs/);
  assert.match(scriptResponse.body, /Cleanup and override it\? \[y\/N\]/);
  assert.match(scriptResponse.body, /overrideExisting/);
  assert.match(scriptResponse.body, /command-agent\.py/);
  assert.match(scriptResponse.body, /ThreadingHTTPServer/);
  assert.match(scriptResponse.body, /cloudflare-man-command-agent\.service/);
  assert.match(scriptResponse.body, /Restart=always/);
  assert.match(scriptResponse.body, /systemctl enable --now cloudflared\.service/);
  assert.match(scriptResponse.body, /osName/);
  assert.match(scriptResponse.body, /osVersion/);
  assert.match(scriptResponse.body, /machineName/);

  const windowsScript = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.ps1` });
  assert.equal(windowsScript.statusCode, 200);
  assert.match(windowsScript.body, /fDenyTSConnections/);
  assert.match(windowsScript.body, /RemoteDesktop\*/);
  assert.match(windowsScript.body, /rdpTargetIp/);
  assert.match(windowsScript.body, /HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server/);
  assert.match(windowsScript.body, /WinStations\\RDP-Tcp/);
  assert.match(windowsScript.body, /https:\/\/cfman\.example\.test\/api\/public\/enrollments\/report/);
  assert.match(windowsScript.body, /Send-InstallLog/);
  assert.match(windowsScript.body, /Read-Host "Cleanup and override/);
  assert.match(windowsScript.body, /overrideExisting/);
  assert.match(windowsScript.body, /CloudflareManCommandAgent/);
  assert.match(windowsScript.body, /New-ScheduledTaskAction/);
  assert.match(windowsScript.body, /X-Cloudflare-Man-Agent-Token/);
  assert.match(windowsScript.body, /sc\.exe failure cloudflared/);
  assert.match(windowsScript.body, /RestartCount 999/);
  assert.match(windowsScript.body, /Get-CimInstance Win32_OperatingSystem/);
  assert.match(windowsScript.body, /platform = "windows"/);
});

test("paginates and refreshes the visible store list", async () => {
  const list = await app.inject({
    method: "GET",
    url: "/api/stores?page=1&pageSize=10",
    headers: { cookie: sessionCookie }
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().stores.length, 1);
  assert.deepEqual(list.json().pagination, { page: 1, pageSize: 10, total: 1, totalPages: 1 });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  try {
    const refresh = await app.inject({
      method: "POST",
      url: "/api/stores/refresh",
      headers: { cookie: sessionCookie },
      payload: { storeIds: [storeId] }
    });
    assert.equal(refresh.statusCode, 200, refresh.body);
    assert.deepEqual(
      { success: refresh.json().success, refreshed: refresh.json().refreshed, failed: refresh.json().failed },
      { success: true, refreshed: 1, failed: 0 }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stores structured installer logs", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/logs",
    payload: {
      token: enrollmentToken,
      events: [
        { level: "info", step: "preflight", message: "Installer started" },
        { level: "warn", step: "rdp", messageBase64: Buffer.from("RDP warning").toString("base64") }
      ]
    }
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().accepted, 2);
  const logs = await pool.query("SELECT level, step, message FROM enrollment_logs WHERE enrollment_id = $1 ORDER BY id", [enrollmentId]);
  assert.deepEqual(logs.rows, [
    { level: "info", step: "preflight", message: "Installer started" },
    { level: "warn", step: "rdp", message: "RDP warning" }
  ]);
});

test("keeps installer preflight failures retryable", async () => {
  const report = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/report",
    payload: { token: enrollmentToken, platform: "windows", status: "failed", error: "Run PowerShell as Administrator." }
  });
  assert.equal(report.statusCode, 200, report.body);
  const retryable = await pool.query("SELECT status, last_error FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.equal(retryable.rows[0].status, "url_issued");
  assert.equal(retryable.rows[0].last_error, "Run PowerShell as Administrator.");

  await pool.query("UPDATE enrollments SET status = 'failed' WHERE id = $1", [enrollmentId]);
  const legacyRetry = await app.inject({ method: "GET", url: `/e/${enrollmentToken}/install.ps1` });
  assert.equal(legacyRetry.statusCode, 200, legacyRetry.body);
});

test("does not delete an account that still has stores", async () => {
  const response = await app.inject({
    method: "DELETE",
    url: `/api/accounts/${accountId}`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /assigned to 1 store/);
  const account = await pool.query("SELECT 1 FROM cloudflare_accounts WHERE id = $1", [accountId]);
  assert.equal(account.rowCount, 1);
});

test("claim is atomic and provisions a tunnel once", async () => {
  const claimResponse = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-a" }
  });
  assert.equal(claimResponse.statusCode, 200, claimResponse.body);
  assert.match(claimResponse.json().tunnelToken, /^mock-/);
  assert.match(claimResponse.json().agentToken, /^[A-Za-z0-9_-]{40,}$/);

  const retryClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64" }
  });
  assert.equal(retryClaim.statusCode, 409);

  const sameInstallerRetry = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-a" }
  });
  assert.equal(sameInstallerRetry.statusCode, 200, sameInstallerRetry.body);
  assert.match(sameInstallerRetry.json().tunnelToken, /^mock-/);

  const approvedOverride = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/claim",
    payload: { token: enrollmentToken, platform: "windows", architecture: "amd64", installId: "installer-b", overrideExisting: true }
  });
  assert.equal(approvedOverride.statusCode, 200, approvedOverride.body);
  const overridden = await pool.query("SELECT install_id FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.equal(overridden.rows[0].install_id, "installer-b");
  const claimedScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'install' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(claimedScripts.rows, [
    { platform: "unix", status: "staled_ignored" },
    { platform: "windows", status: "running" }
  ]);
});

test("updates all ingress routes on an existing tunnel", async () => {
  const response = await app.inject({
    method: "PUT",
    url: `/api/stores/${storeId}/connectivity`,
    headers: { cookie: sessionCookie },
    payload: {
      publications: [
        { suffix: "", routes: [{ path: "/", serviceUrl: "http://localhost:8080" }] },
        {
          suffix: "pos",
          routes: [
            { path: "/api", serviceUrl: "http://localhost:8081" },
            { path: "/admin", serviceUrl: "http://localhost:8082" }
          ]
        },
        {
          suffix: "ops",
          routes: [{ kind: "command_agent", path: "/agent", serviceUrl: "" }]
        }
      ]
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().applied, true);
  const publications = await pool.query("SELECT suffix, hostname, status FROM store_publications WHERE store_id = $1 ORDER BY created_at", [storeId]);
  const routes = await pool.query("SELECT path, service_url FROM store_routes WHERE publication_id IN (SELECT id FROM store_publications WHERE store_id = $1) ORDER BY path", [storeId]);
  assert.deepEqual(publications.rows.map((publication) => publication.suffix), ["", "pos", "ops"]);
  assert.equal(publications.rows[1].hostname, "0001-pos.stores-a.example");
  assert.ok(publications.rows.every((publication) => publication.status === "active"));
  assert.deepEqual(routes.rows.map((route) => route.path), ["/", "/admin", "/agent", "/api"]);
  const agentRoute = await pool.query("SELECT route_kind, service_url FROM store_routes WHERE path = '/agent'");
  assert.deepEqual(agentRoute.rows[0], { route_kind: "command_agent", service_url: "http://127.0.0.1:47831" });
});

test("installer report activates a mock store", async () => {
  const report = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/report",
    payload: {
      token: enrollmentToken,
      platform: "windows",
      status: "installed",
      version: "cloudflared test",
      rdpEnabled: true,
      rdpTargetIp: "192.168.10.25",
      rdpPort: 3389,
      agentReady: true,
      osName: "Microsoft Windows 11 Pro",
      osVersion: "10.0.26100",
      osBuild: "26100",
      architecture: "amd64",
      machineName: "STORE-WIN-01"
    }
  });
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().rdp.ready, true);
  const result = await pool.query("SELECT onboarding_status, tunnel_status, rdp_status, rdp_target_ip::text, rdp_url FROM stores WHERE id = $1", [storeId]);
  assert.equal(result.rows[0].onboarding_status, "active");
  assert.equal(result.rows[0].tunnel_status, "healthy");
  assert.equal(result.rows[0].rdp_status, "ready");
  assert.equal(result.rows[0].rdp_target_ip, "192.168.10.25/32");
  assert.match(result.rows[0].rdp_url, /^https:\/\/rdp\.stores-a\.example\/rdp\//);
  const enrollmentInfo = await pool.query("SELECT host_info FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.deepEqual(enrollmentInfo.rows[0].host_info, {
    osName: "Microsoft Windows 11 Pro",
    osVersion: "10.0.26100",
    osBuild: "26100",
    architecture: "amd64",
    machineName: "STORE-WIN-01"
  });
  const enrollmentDetail = await app.inject({ method: "GET", url: `/api/stores/${storeId}`, headers: { cookie: sessionCookie } });
  assert.equal(enrollmentDetail.statusCode, 200, enrollmentDetail.body);
  assert.equal(enrollmentDetail.json().store.enrollments[0].environment, "windows");
  const installedScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'install' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(installedScripts.rows, [
    { platform: "unix", status: "staled_ignored" },
    { platform: "windows", status: "completed" }
  ]);

  const retry = await app.inject({
    method: "POST",
    url: `/api/stores/${storeId}/rdp/retry`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().ready, true);
});

test("executes a script through the configured store command agent", async () => {
  const detail = await app.inject({ method: "GET", url: `/api/stores/${storeId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().store.commandAgent.endpoint, "https://0001-ops.stores-a.example/agent/exec");
  assert.equal(detail.json().store.commandAgent.status, "ready");

  const originalFetch = globalThis.fetch;
  let executionCall = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://0001-ops.stores-a.example/agent/exec");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("X-Cloudflare-Man-Agent-Token") ?? "", /^[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(JSON.parse(String(init?.body)), { script: "Write-Output 'ready v2'", timeoutMs: 30000 });
    executionCall += 1;
    return new Response(JSON.stringify(executionCall === 1
      ? { success: true, exitCode: 0, stdout: "ready\n", stderr: "", durationMs: 25 }
      : { success: false, exitCode: 2, stdout: "partial\n", stderr: "failed\n", durationMs: 12 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/stores/${storeId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId, timeoutMs: 30000 }
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual({
      endpoint: response.json().endpoint,
      success: response.json().success,
      exitCode: response.json().exitCode,
      stdout: response.json().stdout,
      stderr: response.json().stderr,
      durationMs: response.json().durationMs
    }, {
      endpoint: "https://0001-ops.stores-a.example/agent/exec",
      success: true,
      exitCode: 0,
      stdout: "ready\n",
      stderr: "",
      durationMs: 25
    });
    assert.match(response.json().executionId, /^[0-9a-f-]{36}$/);
    assert.equal(response.json().enrollmentId, enrollmentId);
    assert.equal(response.json().scriptVersionId, scriptVersionId);
    assert.equal(response.json().scriptName, "Store readiness check");
    assert.equal(response.json().version, 2);
    const failed = await app.inject({
      method: "POST",
      url: `/api/stores/${storeId}/commands/execute`,
      headers: { cookie: sessionCookie },
      payload: { scriptVersionId, timeoutMs: 30000 }
    });
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(failed.json().success, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'store.command_executed' AND entity_id = $1", [storeId]);
  assert.equal(audit.rowCount, 2);
  assert.equal(audit.rows[0].details.success, true);
  const executions = await pool.query("SELECT enrollment_id, script_version_id, status, elapsed_ms, stdout, stderr FROM store_command_executions WHERE store_id = $1 ORDER BY created_at", [storeId]);
  assert.equal(executions.rows.length, 2);
  assert.deepEqual({ status: executions.rows[0].status, stdout: executions.rows[0].stdout, stderr: executions.rows[0].stderr }, { status: "succeeded", stdout: "ready\n", stderr: "" });
  assert.equal(typeof executions.rows[0].elapsed_ms, "number");
  assert.deepEqual({ status: executions.rows[1].status, stdout: executions.rows[1].stdout, stderr: executions.rows[1].stderr }, { status: "failed", stdout: "partial\n", stderr: "failed\n" });
  assert.equal(typeof executions.rows[1].elapsed_ms, "number");
  assert.ok(executions.rows.every((execution) => execution.enrollment_id === enrollmentId));
  assert.ok(executions.rows.every((execution) => execution.script_version_id === scriptVersionId));
});

test("tracks enrollment history and issues cleanup for a running tunnel", async () => {
  const response = await app.inject({
    method: "POST",
    url: `/api/stores/${storeId}/enrollments`,
    headers: { cookie: sessionCookie },
    payload: { expiresInHours: 24 }
  });
  assert.equal(response.statusCode, 201, response.body);
  const issued = response.json();
  assert.equal(issued.unenrollCommands.length, 1);
  assert.equal(issued.unenrollCommands[0].enrollmentId, enrollmentId);
  assert.match(issued.unenrollCommands[0].urls.shell, /\/unenroll\.sh$/);

  const cleanupToken = issued.unenrollCommands[0].urls.shell.match(/\/e\/([^/]+)\/unenroll\.sh$/)?.[1];
  assert.ok(cleanupToken);
  const cleanupScript = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.sh` });
  assert.equal(cleanupScript.statusCode, 200, cleanupScript.body);
  assert.match(cleanupScript.body, /cloudflared service uninstall/);
  const cleanupPowerShell = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.ps1` });
  assert.equal(cleanupPowerShell.statusCode, 200, cleanupPowerShell.body);
  assert.match(cleanupPowerShell.body, /Run PowerShell as Administrator/);

  const cleanupClaim = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/claim",
    payload: { token: cleanupToken, platform: "unix" }
  });
  assert.equal(cleanupClaim.statusCode, 200, cleanupClaim.body);
  const staleCleanupPowerShell = await app.inject({ method: "GET", url: `/e/${cleanupToken}/unenroll.ps1` });
  assert.equal(staleCleanupPowerShell.statusCode, 410, staleCleanupPowerShell.body);

  const detail = await app.inject({ method: "GET", url: `/api/stores/${storeId}`, headers: { cookie: sessionCookie } });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().store.enrollments.length, 2);
  assert.equal(detail.json().store.enrollments[1].unenrollStatus, "pending");

  const cleanupLog = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/logs",
    payload: { token: cleanupToken, events: [{ level: "info", step: "cleanup", message: "Service removed" }] }
  });
  assert.equal(cleanupLog.statusCode, 202, cleanupLog.body);
  const cleanupReport = await app.inject({
    method: "POST",
    url: "/api/public/enrollments/unenroll/report",
    payload: { token: cleanupToken, platform: "unix", status: "unenrolled" }
  });
  assert.equal(cleanupReport.statusCode, 200, cleanupReport.body);
  const oldEnrollment = await pool.query("SELECT unenrolled_at, unenroll_last_error FROM enrollments WHERE id = $1", [enrollmentId]);
  assert.ok(oldEnrollment.rows[0].unenrolled_at);
  assert.equal(oldEnrollment.rows[0].unenroll_last_error, null);
  const cleanupScripts = await pool.query("SELECT platform, status FROM enrollment_scripts WHERE enrollment_id = $1 AND script_kind = 'unenroll' ORDER BY platform", [enrollmentId]);
  assert.deepEqual(cleanupScripts.rows, [
    { platform: "unix", status: "completed" },
    { platform: "windows", status: "staled_ignored" }
  ]);

  const logs = await app.inject({
    method: "GET",
    url: `/api/stores/${storeId}/enrollments/${enrollmentId}/logs`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(logs.statusCode, 200, logs.body);
  assert.equal(logs.json().logs.length, 3);
});

test("preflights and force-deletes a store with explicit name confirmation", async () => {
  await pool.query("UPDATE stores SET tunnel_status = 'healthy' WHERE id = $1", [storeId]);
  const preflight = await app.inject({
    method: "GET",
    url: `/api/stores/${storeId}/delete-preflight`,
    headers: { cookie: sessionCookie }
  });
  assert.equal(preflight.statusCode, 200, preflight.body);
  assert.equal(preflight.json().canDelete, false);
  assert.deepEqual(preflight.json().checks.map((check: { id: string; ok: boolean }) => ({ id: check.id, ok: check.ok })), [
    { id: "tunnel", ok: false },
    { id: "enrollments", ok: true },
    { id: "commands", ok: true },
    { id: "cloudflare", ok: true }
  ]);
  assert.match(preflight.json().checks[0].resolution, /unenrollment|cloudflared/i);

  const blocked = await app.inject({
    method: "DELETE",
    url: `/api/stores/${storeId}`,
    headers: { cookie: sessionCookie },
    payload: { force: false }
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().requiresNameConfirmation, true);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/stores/${storeId}`,
    headers: { cookie: sessionCookie },
    payload: { force: true, confirmName: "Highlands Test Store" }
  });
  assert.equal(deleted.statusCode, 204, deleted.body);
  const store = await pool.query("SELECT 1 FROM stores WHERE id = $1", [storeId]);
  assert.equal(store.rowCount, 0);
  const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'store.deleted' AND entity_id = $1", [storeId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].details.forced, true);
});
