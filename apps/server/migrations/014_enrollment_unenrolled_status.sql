ALTER TABLE enrollments
  DROP CONSTRAINT IF EXISTS enrollments_status_check;

ALTER TABLE enrollments
  ADD CONSTRAINT enrollments_status_check
  CHECK (status IN ('url_issued', 'claimed', 'provisioning', 'ready', 'installed', 'unenrolled', 'expired', 'failed', 'revoked'));
