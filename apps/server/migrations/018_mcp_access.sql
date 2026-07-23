CREATE TABLE mcp_access (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  token_hash text,
  token_hint text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  rotated_at timestamptz,
  last_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mcp_access(singleton, enabled)
VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;
