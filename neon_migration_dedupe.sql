
-- Migration: de-duplicate Schedule 4 inserts and capture client-submission ID
ALTER TABLE schedule4_inspections
  ADD COLUMN IF NOT EXISTS client_submission_id text,
  ADD COLUMN IF NOT EXISTS dedupe_hash text;

-- Unique index to prevent duplicate inserts for the same payload
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sched4_dedupe_hash
  ON schedule4_inspections(dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

-- Optional unique on client_submission_id if you send a UUID from the client
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sched4_client_submission_id
  ON schedule4_inspections(client_submission_id)
  WHERE client_submission_id IS NOT NULL;
