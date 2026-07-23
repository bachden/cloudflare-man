ALTER TABLE store_command_executions
  DROP CONSTRAINT store_command_executions_saved_script_pair_check,
  ADD CONSTRAINT store_command_executions_saved_script_pair_check CHECK (
    (saved_script_id IS NULL AND saved_script_version_id IS NULL)
    OR
    (saved_script_id IS NOT NULL AND saved_script_version_id IS NOT NULL AND saved_at IS NOT NULL)
  );
