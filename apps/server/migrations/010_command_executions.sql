CREATE TABLE store_command_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  script text NOT NULL,
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 300000),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms integer,
  exit_code integer,
  stdout text NOT NULL DEFAULT '',
  stderr text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX store_command_executions_store_idx
  ON store_command_executions(store_id, created_at DESC);
