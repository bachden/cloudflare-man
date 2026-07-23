UPDATE store_command_executions
   SET script_type = 'managed',
       script_version_id = saved_script_version_id,
       script_version_number = COALESCE(script_version_number, 1)
 WHERE script_type = 'inline'
   AND saved_script_id IS NOT NULL
   AND saved_script_version_id IS NOT NULL;
