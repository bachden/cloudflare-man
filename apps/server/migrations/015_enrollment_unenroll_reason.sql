ALTER TABLE enrollments
  ADD COLUMN unenroll_reason text
    CHECK (unenroll_reason IN ('script', 'override'));
