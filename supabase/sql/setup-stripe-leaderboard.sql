-- Stripe + Leaderboard + Email migration
-- Run in Supabase SQL editor after setup-multiuser.sql

-- 1. Add Stripe customer ID to profiles
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer ON profiles(stripe_customer_id);

-- 2. Extend user_settings with email alert + leaderboard fields
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS resend_key    text,
  ADD COLUMN IF NOT EXISTS alert_email   text,
  ADD COLUMN IF NOT EXISTS public_profile boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_name  text;

-- 3. Leaderboard view (only opted-in users, aggregated closed positions)
CREATE OR REPLACE VIEW public.leaderboard AS
SELECT
  us.user_id,
  COALESCE(us.display_name, 'Anonymous') AS display_name,
  COUNT(op.id)::int                       AS total_trades,
  SUM(CASE WHEN (op.pnl_pips > 0) THEN 1 ELSE 0 END)::int AS wins,
  SUM(CASE WHEN (op.pnl_pips < 0) THEN 1 ELSE 0 END)::int AS losses,
  ROUND(
    CASE WHEN COUNT(op.id) > 0
      THEN SUM(CASE WHEN (op.pnl_pips > 0) THEN 1 ELSE 0 END)::numeric / COUNT(op.id) * 100
      ELSE 0 END, 1
  )                                        AS win_rate,
  ROUND(COALESCE(SUM(op.pnl_pips), 0), 1) AS net_pips,
  (SELECT symbol FROM open_positions op2
   WHERE op2.user_id = us.user_id AND op2.status = 'closed' AND op2.pnl_pips > 0
   ORDER BY op2.pnl_pips DESC LIMIT 1)    AS best_pair
FROM user_settings us
LEFT JOIN open_positions op
  ON op.user_id = us.user_id AND op.status = 'closed'
WHERE us.public_profile = true
GROUP BY us.user_id, us.display_name
ORDER BY net_pips DESC;

-- 4. Allow anon + authenticated to read the leaderboard view
GRANT SELECT ON public.leaderboard TO anon, authenticated;

-- 5. Stripe site_config placeholders (fill in via Admin)
INSERT INTO site_config (key, value) VALUES
  ('stripe_pk',                       ''),
  ('stripe_sk',                       ''),
  ('stripe_webhook_secret',           ''),
  ('stripe_price_essential_monthly',  ''),
  ('stripe_price_essential_annual',   ''),
  ('stripe_price_pro_monthly',        ''),
  ('stripe_price_pro_annual',         ''),
  ('tg_public_token',                 ''),
  ('tg_public_channel_id',            '')
ON CONFLICT (key) DO NOTHING;
