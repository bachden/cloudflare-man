export type User = {
  id: string;
  username: string;
  mustChangePassword: boolean;
};

export type AppSettings = {
  publicBaseUrl: string;
  configured: boolean;
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
  accountId: string;
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
};

export type EnrollmentResult = {
  id: string;
  expiresAt: string;
  urls: {
    shell: string;
    powershell: string;
  };
};
