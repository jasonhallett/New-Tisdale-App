-- Add default fields to technicians profile
ALTER TABLE technicians
  ADD COLUMN IF NOT EXISTS default_carrier text,
  ADD COLUMN IF NOT EXISTS default_station_address text;
