-- ============================================================
-- Sharpe — Trading tables + pg_cron setup
-- Run once in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/qlvbgkipkxtwaqwpcmuj/sql
-- ============================================================

-- Signals waiting for price to reach entry zone
create table if not exists public.pending_entries (
  id          bigserial primary key,
  symbol      text        not null,
  timeframe   text        not null,
  direction   text        not null,
  entry_price numeric     not null,
  stop_loss   numeric     not null,
  tp1         numeric     not null,
  tp2         numeric,
  confidence  int,
  pattern     text,
  atr_pips    numeric,
  inst_mult   numeric,
  inst_dec    int,
  inst_unit   text,
  inst_type   text,
  mode        text        not null default 'paper',  -- paper | live
  status      text        not null default 'pending', -- pending | filled | expired | cancelled
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Active and closed positions (paper + live)
create table if not exists public.open_positions (
  id              bigserial primary key,
  entry_id        bigint references public.pending_entries(id) on delete set null,
  symbol          text        not null,
  timeframe       text,
  direction       text        not null,
  entry_price     numeric     not null,
  stop_loss       numeric     not null,
  tp1             numeric     not null,
  tp2             numeric,
  confidence      int,
  pattern         text,
  inst_mult       numeric,
  inst_dec        int,
  inst_unit       text,
  inst_type       text,
  mode            text        not null default 'paper',
  broker_order_id text,
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  close_price     numeric,
  close_reason    text,       -- tp1 | tp2 | stop | manual
  pnl_pips        numeric,
  status          text        not null default 'open'   -- open | closed
);

-- Allow the anon/authenticated roles to read and insert
alter table public.pending_entries enable row level security;
alter table public.open_positions  enable row level security;

create policy "public read pending_entries"  on public.pending_entries for select using (true);
create policy "public insert pending_entries" on public.pending_entries for insert with check (true);
create policy "public read open_positions"    on public.open_positions  for select using (true);

-- ── pg_cron: call price-monitor every 5 minutes ──────────────────
-- Requires pg_net extension (enabled by default on Supabase)
select cron.schedule(
  'sharpe-price-monitor',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://qlvbgkipkxtwaqwpcmuj.supabase.co/functions/v1/price-monitor',
    headers := '{"Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsdmJna2lwa3h0d2Fxd3BjbXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMTY3MjcsImV4cCI6MjA5NDU5MjcyN30.iATkgXOfVYDJp1meE2igoJ33mVD3tJiNww4hyR4hRDs","Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  ) as request_id
  $$
);

-- ── Store server-side Binance keys (for live crypto execution) ────
-- Fill in your keys then run:
insert into public.site_config (key, value) values
  ('bn_api_key',   'YOUR_BINANCE_API_KEY'),
  ('bn_secret',    'YOUR_BINANCE_SECRET'),
  ('bn_testnet',   'true'),   -- change to 'false' for live
  ('bn_risk_usdt', '50')      -- USDT to risk per trade
on conflict (key) do update set value = excluded.value;
