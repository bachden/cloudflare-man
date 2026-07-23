CREATE TABLE enrollment_scripts (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  script_kind text NOT NULL CHECK (script_kind IN ('install', 'unenroll')),
  platform text NOT NULL CHECK (platform IN ('windows', 'unix')),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'running', 'completed', 'failed', 'staled_ignored')),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, script_kind, platform)
);

CREATE INDEX enrollment_scripts_status_idx
  ON enrollment_scripts(enrollment_id, script_kind, status);

INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status, started_at, finished_at, last_error)
SELECT e.id,
       'install',
       platform.platform,
       CASE
         WHEN e.claimed_at IS NOT NULL AND ((platform.platform = 'windows' AND e.platform = 'windows') OR (platform.platform = 'unix' AND e.platform IN ('linux', 'darwin', 'unix')))
           THEN CASE
             WHEN e.status = 'installed' THEN 'completed'
             WHEN e.status = 'failed' THEN 'failed'
             ELSE 'running'
           END
         WHEN e.claimed_at IS NOT NULL THEN 'staled_ignored'
         ELSE 'available'
       END,
       CASE WHEN e.claimed_at IS NOT NULL AND ((platform.platform = 'windows' AND e.platform = 'windows') OR (platform.platform = 'unix' AND e.platform IN ('linux', 'darwin', 'unix'))) THEN e.claimed_at ELSE null END,
       CASE WHEN e.claimed_at IS NOT NULL AND ((platform.platform = 'windows' AND e.platform = 'windows') OR (platform.platform = 'unix' AND e.platform IN ('linux', 'darwin', 'unix'))) AND e.status IN ('installed', 'failed') THEN e.installed_at ELSE null END,
       CASE WHEN e.claimed_at IS NOT NULL AND ((platform.platform = 'windows' AND e.platform = 'windows') OR (platform.platform = 'unix' AND e.platform IN ('linux', 'darwin', 'unix'))) THEN e.last_error ELSE null END
  FROM enrollments e
 CROSS JOIN (VALUES ('windows'), ('unix')) AS platform(platform)
ON CONFLICT (enrollment_id, script_kind, platform) DO NOTHING;

INSERT INTO enrollment_scripts(enrollment_id, script_kind, platform, status)
SELECT e.id, 'unenroll', platform.platform, 'available'
  FROM enrollments e
 CROSS JOIN (VALUES ('windows'), ('unix')) AS platform(platform)
 WHERE e.unenroll_token_hash IS NOT NULL
ON CONFLICT (enrollment_id, script_kind, platform) DO NOTHING;
