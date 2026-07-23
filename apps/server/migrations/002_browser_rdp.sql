ALTER TABLE cloudflare_accounts
  ADD COLUMN rdp_allowed_emails text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN rdp_access_policy_id text;

ALTER TABLE zones
  ADD COLUMN rdp_hostname text,
  ADD COLUMN rdp_dns_record_id text,
  ADD COLUMN rdp_access_app_id text;

ALTER TABLE stores
  ADD COLUMN rdp_status text NOT NULL DEFAULT 'pending'
    CHECK (rdp_status IN ('disabled', 'pending', 'enabled', 'provisioning', 'ready', 'failed')),
  ADD COLUMN rdp_target_ip inet,
  ADD COLUMN rdp_target_hostname text,
  ADD COLUMN rdp_port integer NOT NULL DEFAULT 3389 CHECK (rdp_port BETWEEN 1 AND 65535),
  ADD COLUMN rdp_vnet_id text,
  ADD COLUMN rdp_route_id text,
  ADD COLUMN rdp_target_id text,
  ADD COLUMN rdp_url text,
  ADD COLUMN rdp_last_error text;

CREATE INDEX stores_rdp_status_idx ON stores(rdp_status);
