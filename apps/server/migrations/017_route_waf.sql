ALTER TABLE store_routes
  ADD COLUMN IF NOT EXISTS waf_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS waf_allowed_ips text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS waf_ruleset_id text,
  ADD COLUMN IF NOT EXISTS waf_rule_id text;
