export type User = {
  id: string;
  username: string;
  mustChangePassword: boolean;
};

export type AppSettings = {
  publicBaseUrl: string;
  configured: boolean;
  mcp: {
    enabled: boolean;
    endpoint: string;
    tokenHint: string | null;
    rotatedAt: string | null;
    lastUsedAt: string | null;
  };
};

export type Zone = {
  id: string;
  name: string;
  cfZoneId: string | null;
  status: string;
  dnsRecordLimit: number;
  softStoreLimit: number;
  storeCount: number;
};

export type CloudflareAccount = {
  id: string;
  name: string;
  providerMode: "live" | "mock";
  cfAccountId: string | null;
  status: string;
  tunnelLimit: number;
  softTunnelLimit: number;
  supportEmail: string | null;
  rdpAllowedEmails: string[];
  storeCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  zones: Zone[];
};

export type StoreRoute = {
  id: string;
  path: string;
  serviceUrl: string;
  kind: "service" | "command_agent";
  wafEnabled: boolean;
  wafAllowedIps: string[];
  wafRulesetId: string | null;
  wafRuleId: string | null;
};

export type StorePublication = {
  id: string;
  suffix: string;
  hostname: string;
  status: string;
  lastError: string | null;
  routes: StoreRoute[];
};

export type Store = {
  id: string;
  tenantCode: string;
  storeCode: string;
  displayName: string;
  originUrl: string;
  hostname: string;
  tunnelId: string | null;
  tunnelName: string | null;
  tunnelStatus: string;
  onboardingStatus: string;
  latestEnrollmentStatus?: string | null;
  accountId: string;
  cfAccountId: string | null;
  accountName: string;
  zoneId: string;
  zoneName: string;
  lastConnectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  rdpStatus: string;
  rdpTargetIp: string | null;
  rdpUrl: string | null;
  rdpLastError: string | null;
  publications: StorePublication[];
  enrollments?: StoreEnrollment[];
  commandExecutions?: StoreCommandExecution[];
  commandAgent?: {
    enabled: boolean;
    hostname: string;
    path: string;
    endpoint: string;
    status: "pending" | "ready" | "failed";
    lastSeenAt: string | null;
    lastError: string | null;
  } | null;
};

export type StoreDeleteCheck = {
  id: "tunnel" | "enrollments" | "commands" | "cloudflare";
  label: string;
  ok: boolean;
  detail: string;
  resolution: string;
};

export type StoreDeletePreflight = {
  storeId: string;
  displayName: string;
  canDelete: boolean;
  checks: StoreDeleteCheck[];
  checkedAt: string;
};

export type StoreEnrollment = {
  id: string;
  computerName: string | null;
  isCurrent: boolean;
  deletedAt: string | null;
  status: string;
  platform: "windows" | "unix" | null;
  environment: "windows" | "linux" | "darwin" | "unix" | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  installedAt: string | null;
  lastError: string | null;
  unenrollStatus: "not_required" | "pending" | "unenrolled" | "failed";
  unenrollReason: "script" | "override" | null;
  unenrollRequestedAt: string | null;
  unenrolledAt: string | null;
  logCount: number;
  hostInfo: {
    osName?: string;
    osVersion?: string;
    osBuild?: string;
    architecture?: string;
    machineName?: string;
  };
  scripts: Array<{
    kind: "install" | "unenroll";
    platform: "windows" | "unix";
    status: "available" | "running" | "completed" | "failed" | "staled_ignored";
    startedAt: string | null;
    finishedAt: string | null;
    lastError: string | null;
  }>;
};

export type StoreCommandExecution = {
  id: string;
  enrollmentId: string | null;
  scriptType: "managed" | "inline";
  scriptId: string | null;
  scriptVersionId: string | null;
  savedScriptId: string | null;
  savedScriptVersionId: string | null;
  savedAt: string | null;
  scriptName: string | null;
  scriptVersion: number | null;
  platform: "windows" | "unix" | null;
  language: "powershell" | "bash" | "sh" | null;
  script: string;
  timeoutMs: number;
  status: "running" | "succeeded" | "failed" | "timed_out";
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  requestedBy: string | null;
};

export type ScriptCommandExecution = StoreCommandExecution & {
  storeId: string;
  storeDisplayName: string;
  tenantCode: string;
  storeCode: string;
  computerName: string | null;
  osName: string | null;
  environment: "windows" | "linux" | "darwin" | "unix" | null;
  enrollmentPlatform: "windows" | "unix" | null;
  anchorScriptVersionId: string;
};

export type ManagedScriptSummary = {
  id: string;
  name: string;
  platform: "windows" | "unix";
  language: "powershell" | "bash" | "sh";
  description: string;
  latestVersion: number | null;
  latestVersionId: string | null;
  executionStats: ExecutionStats;
  updatedAt: string;
  createdAt: string;
};

export type ExecutionStats = {
  total: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  running: number;
};

export type ManagedScript = ManagedScriptSummary & {
  versions: Array<{
    id: string;
    version: number;
    content: string;
    createdAt: string;
    createdBy: string | null;
  }>;
};

export type EnrollmentResult = {
  id: string;
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
  unenrollCommands?: Array<{
    enrollmentId: string;
    createdAt: string;
    expiresAt: string;
    urls: {
      shell: string;
      powershell: string;
    };
  }>;
};

export type UnenrollmentResult = {
  enrollmentId: string;
  createdAt: string;
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
};
