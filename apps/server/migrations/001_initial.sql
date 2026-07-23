CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text
);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS cloudflare_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  provider_mode text NOT NULL DEFAULT 'live' CHECK (provider_mode IN ('live', 'mock')),
  cf_account_id text UNIQUE,
  api_token_encrypted text,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('active', 'unverified', 'invalid', 'disabled')),
  tunnel_limit integer NOT NULL DEFAULT 1000 CHECK (tunnel_limit > 0),
  soft_tunnel_limit integer NOT NULL DEFAULT 750 CHECK (soft_tunnel_limit > 0),
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (soft_tunnel_limit <= tunnel_limit),
  CHECK (provider_mode = 'mock' OR (cf_account_id IS NOT NULL AND api_token_encrypted IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES cloudflare_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  cf_zone_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'invalid', 'disabled')),
  dns_record_limit integer NOT NULL DEFAULT 200 CHECK (dns_record_limit > 0),
  soft_store_limit integer NOT NULL DEFAULT 150 CHECK (soft_store_limit > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, name),
  UNIQUE(account_id, cf_zone_id),
  CHECK (soft_store_limit <= dns_record_limit)
);

CREATE TABLE IF NOT EXISTS stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_code text NOT NULL,
  store_code text NOT NULL,
  display_name text NOT NULL,
  origin_url text NOT NULL DEFAULT 'http://localhost:8080',
  account_id uuid NOT NULL REFERENCES cloudflare_accounts(id),
  zone_id uuid NOT NULL REFERENCES zones(id),
  hostname text NOT NULL UNIQUE,
  tunnel_id text,
  tunnel_name text,
  dns_record_id text,
  tunnel_status text NOT NULL DEFAULT 'not_created' CHECK (tunnel_status IN ('not_created', 'inactive', 'healthy', 'degraded', 'down', 'unknown')),
  onboarding_status text NOT NULL DEFAULT 'draft' CHECK (onboarding_status IN ('draft', 'url_issued', 'claimed', 'provisioning', 'connector_online', 'verified', 'active', 'expired', 'failed', 'revoked')),
  cloudflared_version text,
  last_connected_at timestamptz,
  last_verified_at timestamptz,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_code, store_code)
);

CREATE INDEX IF NOT EXISTS stores_account_id_idx ON stores(account_id);
CREATE INDEX IF NOT EXISTS stores_zone_id_idx ON stores(zone_id);
CREATE INDEX IF NOT EXISTS stores_tunnel_status_idx ON stores(tunnel_status);
CREATE INDEX IF NOT EXISTS stores_onboarding_status_idx ON stores(onboarding_status);

CREATE TABLE IF NOT EXISTS enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'url_issued' CHECK (status IN ('url_issued', 'claimed', 'provisioning', 'ready', 'installed', 'expired', 'failed', 'revoked')),
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claimed_by text,
  platform text,
  install_id text,
  installed_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enrollments_store_id_idx ON enrollments(store_id);
CREATE INDEX IF NOT EXISTS enrollments_expires_at_idx ON enrollments(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type, entity_id);

