ALTER TABLE enrollments
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX enrollments_store_deleted_idx
  ON enrollments(store_id, deleted_at, created_at DESC);
