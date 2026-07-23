CREATE TABLE managed_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('windows', 'unix')),
  language text NOT NULL CHECK (language IN ('powershell', 'bash', 'sh')),
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name, platform)
);

CREATE TABLE managed_script_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id uuid NOT NULL REFERENCES managed_scripts(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(script_id, version)
);

CREATE INDEX managed_scripts_platform_idx ON managed_scripts(platform, updated_at DESC);
CREATE INDEX managed_script_versions_script_idx ON managed_script_versions(script_id, version DESC);

ALTER TABLE store_command_executions
  ADD COLUMN enrollment_id uuid REFERENCES enrollments(id) ON DELETE SET NULL,
  ADD COLUMN script_version_id uuid REFERENCES managed_script_versions(id) ON DELETE SET NULL;

CREATE INDEX store_command_executions_enrollment_idx
  ON store_command_executions(enrollment_id, created_at DESC);
