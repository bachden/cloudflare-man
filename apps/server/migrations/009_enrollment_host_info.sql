ALTER TABLE enrollments
  ADD COLUMN host_info jsonb NOT NULL DEFAULT '{}'::jsonb;
