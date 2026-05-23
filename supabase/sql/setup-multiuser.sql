-- Multi-user isolation migration
-- Run in Supabase SQL editor after setup-trading.sql

-- 1. User settings table (one row per authenticated user)
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Auto paper trade
  auto_paper_trade     boolean DEFAULT false,
  auto_paper_min_conf  integer DEFAULT 70,
  -- Telegram
  telegram_token       text,
  telegram_chat_id     text,
  -- Risk management
  risk_max_positions         integer DEFAULT 5,
  risk_daily_loss_enabled    boolean DEFAULT false,
  risk_max_daily_loss_pips   numeric DEFAULT 100,
  risk_correlation_guard     boolean DEFAULT true,
  -- OANDA
  oanda_token       text,
  oanda_account     text,
  oanda_practice    boolean DEFAULT true,
  oanda_risk_pct    numeric DEFAULT 1,
  -- Misc
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own settings"
  ON user_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_user_settings_updated ON user_settings;
CREATE TRIGGER trg_user_settings_updated
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 2. Add user_id to pending_entries (nullable so existing rows survive)
ALTER TABLE pending_entries
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 3. Add user_id to open_positions
ALTER TABLE open_positions
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 4. Update RLS on pending_entries
--    Existing anon/service-role policies remain; add user-scoped read/write
DROP POLICY IF EXISTS "Users see own entries" ON pending_entries;
CREATE POLICY "Users see own entries"
  ON pending_entries FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users insert own entries" ON pending_entries;
CREATE POLICY "Users insert own entries"
  ON pending_entries FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own entries" ON pending_entries;
CREATE POLICY "Users delete own entries"
  ON pending_entries FOR DELETE
  USING (auth.uid() = user_id);

-- 5. Update RLS on open_positions
DROP POLICY IF EXISTS "Users see own positions" ON open_positions;
CREATE POLICY "Users see own positions"
  ON open_positions FOR SELECT
  USING (auth.uid() = user_id OR user_id IS NULL);

DROP POLICY IF EXISTS "Users close own positions" ON open_positions;
CREATE POLICY "Users close own positions"
  ON open_positions FOR UPDATE
  USING (auth.uid() = user_id);

-- 6. Indexes for per-user queries
CREATE INDEX IF NOT EXISTS idx_pending_entries_user ON pending_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_open_positions_user ON open_positions(user_id);

-- 7. weekly-digest pg_cron (Monday 07:00 UTC) — adjust URL to your project
-- SELECT cron.schedule(
--   'weekly-digest',
--   '0 7 * * 1',
--   $$SELECT net.http_post(
--       url := 'https://qlvbgkipkxtwaqwpcmuj.supabase.co/functions/v1/weekly-digest',
--       headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb
--   )$$
-- );

-- 8. morning-brief pg_cron (Mon–Fri 07:00 UTC)
-- SELECT cron.schedule(
--   'morning-brief',
--   '0 7 * * 1-5',
--   $$SELECT net.http_post(
--       url := 'https://qlvbgkipkxtwaqwpcmuj.supabase.co/functions/v1/morning-brief',
--       headers := '{"Authorization":"Bearer <SERVICE_ROLE_KEY>","Content-Type":"application/json"}'::jsonb,
--       body := '{}'::jsonb
--   )$$
-- );
