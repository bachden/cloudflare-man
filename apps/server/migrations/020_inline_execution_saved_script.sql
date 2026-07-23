ALTER TABLE store_command_executions
  ADD COLUMN saved_script_id uuid REFERENCES managed_scripts(id) ON DELETE SET NULL,
  ADD COLUMN saved_script_version_id uuid REFERENCES managed_script_versions(id) ON DELETE SET NULL,
  ADD COLUMN saved_at timestamptz,
  ADD CONSTRAINT store_command_executions_saved_script_pair_check CHECK (
    (saved_script_id IS NULL AND saved_script_version_id IS NULL)
    OR
    (saved_script_id IS NOT NULL AND saved_script_version_id IS NOT NULL AND saved_at IS NOT NULL)
  );

CREATE INDEX store_command_executions_saved_script_idx
  ON store_command_executions(saved_script_id)
  WHERE saved_script_id IS NOT NULL;
