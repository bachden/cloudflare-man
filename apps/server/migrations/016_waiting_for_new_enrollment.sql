ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS stores_onboarding_status_check;

ALTER TABLE stores
  ADD CONSTRAINT stores_onboarding_status_check
  CHECK (onboarding_status IN (
    'draft', 'url_issued', 'waiting_for_new_enrollment', 'claimed', 'provisioning',
    'connector_online', 'verified', 'active', 'expired', 'failed', 'revoked'
  ));
