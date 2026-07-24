ALTER TABLE enrollments
  ADD COLUMN diagnose_token_hash char(64),
  ADD COLUMN diagnose_token_expires_at timestamptz;

CREATE UNIQUE INDEX enrollments_diagnose_token_hash_idx
  ON enrollments(diagnose_token_hash)
  WHERE diagnose_token_hash IS NOT NULL;
