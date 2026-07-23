CREATE TABLE enrollment_logs (
  id bigserial PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  step text,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX enrollment_logs_enrollment_id_idx ON enrollment_logs(enrollment_id, id);
CREATE INDEX enrollment_logs_created_at_idx ON enrollment_logs(created_at DESC);

