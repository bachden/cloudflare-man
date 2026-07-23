ALTER TABLE enrollments
  ADD COLUMN unenroll_token_hash char(64),
  ADD COLUMN unenroll_token_expires_at timestamptz,
  ADD COLUMN unenroll_requested_at timestamptz,
  ADD COLUMN unenrolled_at timestamptz,
  ADD COLUMN unenroll_last_error text;

CREATE UNIQUE INDEX enrollments_unenroll_token_hash_idx
  ON enrollments(unenroll_token_hash)
  WHERE unenroll_token_hash IS NOT NULL;

CREATE INDEX enrollments_unenroll_status_idx
  ON enrollments(store_id, unenroll_requested_at, unenrolled_at);
