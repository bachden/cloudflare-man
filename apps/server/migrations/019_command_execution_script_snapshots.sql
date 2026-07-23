ALTER TABLE store_command_executions
  ADD COLUMN script_type text NOT NULL DEFAULT 'managed'
    CHECK (script_type IN ('managed', 'inline')),
  ADD COLUMN script_name text,
  ADD COLUMN script_platform text
    CHECK (script_platform IN ('windows', 'unix')),
  ADD COLUMN script_language text
    CHECK (script_language IN ('powershell', 'bash', 'sh')),
  ADD COLUMN script_version_number integer
    CHECK (script_version_number IS NULL OR script_version_number > 0);

UPDATE store_command_executions ce
   SET script_name = ms.name,
       script_platform = ms.platform,
       script_language = ms.language,
       script_version_number = sv.version
  FROM managed_script_versions sv
  JOIN managed_scripts ms ON ms.id = sv.script_id
 WHERE ce.script_version_id = sv.id;

UPDATE store_command_executions ce
   SET script_type = 'inline',
       script_name = 'inline',
       script_platform = CASE WHEN e.platform = 'windows' THEN 'windows' ELSE 'unix' END,
       script_language = CASE WHEN e.platform = 'windows' THEN 'powershell' ELSE 'bash' END
  FROM enrollments e
 WHERE ce.script_version_id IS NULL
   AND ce.enrollment_id = e.id;
