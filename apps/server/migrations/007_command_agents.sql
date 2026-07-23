ALTER TABLE store_routes
  ADD COLUMN route_kind text NOT NULL DEFAULT 'service'
    CHECK (route_kind IN ('service', 'command_agent'));

CREATE INDEX store_routes_command_agent_idx
  ON store_routes(publication_id)
  WHERE route_kind = 'command_agent';

CREATE TABLE store_command_agents (
  store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  token_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
