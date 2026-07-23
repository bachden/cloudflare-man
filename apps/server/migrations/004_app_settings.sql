CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

