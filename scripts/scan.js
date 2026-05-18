/**
 * Sharpe Signal Scanner — runs server-side via GitHub Actions
 *
 * Required GitHub secrets:
 *   TWELVE_DATA_KEY       — free key from twelvedata.com (800 credits/day)
 *   SUPABASE_URL          — https://qlvbgkipkxtwaqwpcmuj.supabase.co
 *   SUPABASE_SERVICE_KEY  — service_role key (never expose in browser)
 *
 * Required Supabase table (run once in SQL editor):
 *
 *   create table if not exists public.signals (
 *     id            bigserial primary key,
 *     batch_id      text not null,
 *     symbol        text not null,
 *     timeframe     text not null,
 *     scanned_at    timestamptz not null default now(),
 *     inst_type     text,
 *     inst_unit     text,
 *     inst_mult     numeric,
 *     inst_dec      int,
 *     price         numeric,
 *     price_change  numeric,
 *     trend         text,
 *     rsi           numeric,
 *     atr_pips      numeric,
 *     direction     text,
 *     confidence    int,
 *     pattern       text,
 *     entry         numeric,
 *     stop_loss     numeric,
 *     tp1           numeric,
 *     tp2           numeric,
 *     rr            numeric,
 *     risk_pips     numeric,
 *     structure     text,
 *     at_key_level  boolean,
 *     nearest_level numeric,
 *     vol_ratio     numeric,
 *     vol_declining boolean,
 *     reasons       jsonb
 *   );
 *
 *   alter table public.signals enable row level security;
 *   create policy "signals_read_all" on public.signals for select using (true);
 *   create index if not exists signals_batch_idx on public.signals(batch_id);
 *   create index if not exists signals_tf_time_idx on public.signals(timeframe, scanned_at desc);
 */

import { createClient } from '@supabase/supabase-js';

// ── Environment ──────────────────────────────────────────────────
const TD_KEY       = process.env.TWELVE_DATA_KEY;
const SUPA_URL     = process.env.SUPABASE_URL;
const SUPA_KEY     = process.env.SUPABASE_SERVICE_KEY;

if (!TD_KEY || !SUPA_URL || !SUPA_KEY) {
  console.error('Missing required env vars: TWELVE_DATA_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Instruments ──────────────────────────────────────────────────
const INSTRUMENTS = [
  // Forex — Major
  { symbol: 'EUR/USD', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 1.0870 },
  { symbol: 'GBP/USD', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 1.2720 },
  { symbol: 'USD/JPY', type: 'Forex',     mult: 100,   dec: 3, unit: 'pips', base: 151.40 },
  { symbol: 'AUD/USD', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 0.6430 },
  { symbol: 'USD/CAD', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 1.3580 },
  { symbol: 'NZD/USD', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 0.5960 },
  { symbol: 'USD/CHF', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 0.8960 },
  // Forex — Crosses
  { symbol: 'EUR/GBP', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 0.8560 },
  { symbol: 'EUR/JPY', type: 'Forex',     mult: 100,   dec: 3, unit: 'pips', base: 163.20 },
  { symbol: 'GBP/JPY', type: 'Forex',     mult: 100,   dec: 3, unit: 'pips', base: 192.40 },
  { symbol: 'EUR/CHF', type: 'Forex',     mult: 10000, dec: 5, unit: 'pips', base: 0.9710 },
  { symbol: 'AUD/JPY', type: 'Forex',     mult: 100,   dec: 3, unit: 'pips', base: 97.20  },
  // Commodities
  { symbol: 'XAU/USD', type: 'Commodity', mult: 1,     dec: 2, unit: 'pts',  base: 3280.0 },
  { symbol: 'XAG/USD', type: 'Commodity', mult: 100,   dec: 4, unit: 'pts',  base: 32.50  },
  { symbol: 'WTI/USD', type: 'Commodity', mult: 1,     dec: 2, unit: 'pts',  base: 78.50  },
  // Crypto
  { symbol: 'BTC/USD', type: 'Crypto',    mult: 1,     dec: 2, unit: 'pts',  base: 67000  },
  { symbol: 'ETH/USD', type: 'Crypto',    mult: 1,     dec: 2, unit: 'pts',  base: 3200   },
  { symbol: 'SOL/USD', type: 'Crypto',    mult: 1,     dec: 2, unit: 'pts',  base: 155    },
  { symbol: 'XRP/USD', type: 'Crypto',    mult: 1,     dec: 4, unit: 'pts',  base: 0.58   },
  // Indices
  { symbol: 'SPX',     type: 'Index',     mult: 1,     dec: 2, unit: 'pts',  base: 5250   },
  { symbol: 'IXIC',    type: 'Index',     mult: 1,     dec: 2, unit: 'pts',  base: 16400  },
  { symbol: 'DJI',     type: 'Index',     mult: 1,     dec: 2, unit: 'pts',  base: 39000  },
  { symbol: 'DAX',     type: 'Index',     mult: 1,     dec: 2, unit: 'pts',  base: 18200  },
  { symbol: 'FTSE',    type: 'Index',     mult: 1,     dec: 2, unit: 'pts',  base: 7900   },
  // ETFs (Pro only — still scanned server-side; plan gate is on the frontend)
  { symbol: 'SPY',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 524,   proOnly: true },
  { symbol: 'QQQ',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 445,   proOnly: true },
  { symbol: 'IWM',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 208,   proOnly: true },
  { symbol: 'TLT',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 92,    proOnly: true },
  { symbol: 'GLD',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 240,   proOnly: true },
  { symbol: 'USO',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 74,    proOnly: true },
  { symbol: 'EEM',     type: 'ETF',       mult: 1,     dec: 2, unit: 'pts',  base: 43,    proOnly: true },
];

// ── Technical Indicators ─────────────────────────────────────────
function calcEmaAll(data, period) {
  const k = 2 / (period + 1);
  const out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcRsi(closes, period = 14) {
  if (closes.length < period + 2) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcAtr(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  if (trs.length < period) return trs.reduce((s, v) => s + v, 0) / trs.length || 0.001;
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a || 0.001;
}

function detectPat(cs) {
  const n = cs.length; if (n < 2) return null;
  const c = cs[n - 1], p = cs[n - 2], pp = n >= 3 ? cs[n - 3] : null;
  const cBody = Math.abs(c.close - c.open), pBody = Math.abs(p.close - p.open);
  const cRange = c.high - c.low;
  const cLo = Math.min(c.open, c.close), cHi = Math.max(c.open, c.close);
  const lw = cLo - c.low, uw = c.high - cHi;

  if (cRange > 0 && cBody < cRange * 0.08) return { name: 'Doji', dir: 'NEUTRAL', str: 1 };
  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open && cBody > pBody * 0.8)
    return { name: 'Bullish Engulfing', dir: 'LONG', str: 3 };
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open && cBody > pBody * 0.8)
    return { name: 'Bearish Engulfing', dir: 'SHORT', str: 3 };
  if (lw > cBody * 2 && uw < cBody * 0.5 && cRange > 0)
    return { name: 'Bullish Pin Bar', dir: 'LONG', str: 2 };
  if (uw > cBody * 2 && lw < cBody * 0.5 && cRange > 0)
    return { name: 'Bearish Pin Bar', dir: 'SHORT', str: 2 };
  if (c.high < p.high && c.low > p.low) return { name: 'Inside Bar', dir: 'NEUTRAL', str: 1 };
  if (pp) {
    const ppBody = Math.abs(pp.close - pp.open);
    if (pp.close < pp.open && pBody < ppBody * 0.3 && c.close > c.open && c.close > (pp.open + pp.close) / 2)
      return { name: 'Morning Star', dir: 'LONG', str: 3 };
    if (pp.close > pp.open && pBody < ppBody * 0.3 && c.close < c.open && c.close < (pp.open + pp.close) / 2)
      return { name: 'Evening Star', dir: 'SHORT', str: 3 };
    if (pp.close > pp.open && p.close > p.open && c.close > c.open && c.close > p.close && p.close > pp.close)
      return { name: 'Three White Soldiers', dir: 'LONG', str: 3 };
    if (pp.close < pp.open && p.close < p.open && c.close < c.open && c.close < p.close && p.close < pp.close)
      return { name: 'Three Black Crows', dir: 'SHORT', str: 3 };
  }
  return null;
}

function findSwings(candles, pivot = 2) {
  const highs = [], lows = [];
  for (let i = pivot; i < candles.length - pivot; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= pivot; j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) isH = false;
      if (candles[i - j].low <= candles[i].low  || candles[i + j].low  <= candles[i].low)  isL = false;
    }
    if (isH) highs.push({ price: candles[i].high, idx: i });
    if (isL) lows.push({ price: candles[i].low,  idx: i });
  }
  return { highs, lows };
}

function priceStructure(highs, lows) {
  const rH = highs.slice(-3), rL = lows.slice(-3);
  if (rH.length < 2 || rL.length < 2) return 'unknown';
  const hh = rH[rH.length - 1].price > rH[rH.length - 2].price;
  const hl = rL[rL.length - 1].price > rL[rL.length - 2].price;
  const ll = rL[rL.length - 1].price < rL[rL.length - 2].price;
  const lh = rH[rH.length - 1].price < rH[rH.length - 2].price;
  if (hh && hl) return 'bullish';
  if (ll && lh) return 'bearish';
  return 'ranging';
}

function analyzeVolume(candles, period = 20) {
  const vols = candles.map(c => c.volume || 0);
  if (!vols.some(v => v > 0)) return null;
  const recent = vols.slice(-(period + 1));
  const avg = recent.slice(0, -1).reduce((s, v) => s + v, 0) / period;
  const last = recent[recent.length - 1];
  const ratio = avg > 0 ? last / avg : 1;
  const last5 = vols.slice(-6, -1);
  const declining = last5.length >= 2 && last5[last5.length - 1] < last5[0] * 0.8;
  return { avg: +avg.toFixed(0), last: +last.toFixed(0), ratio: +ratio.toFixed(2), declining };
}

function analyseCandles(candles, inst) {
  if (candles.length < 220) return null;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const e20a = calcEmaAll(closes, 20), e50a = calcEmaAll(closes, 50), e200a = calcEmaAll(closes, 200);
  const e20 = e20a[e20a.length - 1], e50 = e50a[e50a.length - 1], e200 = e200a[e200a.length - 1];
  const rsiVal = calcRsi(closes, 14);
  const atrVal = calcAtr(highs, lows, closes, 14);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const pat  = detectPat(candles.slice(-3));
  const aboveE200  = last.close > e200;
  const bullTrend  = e20 > e50 && e50 > e200;
  const bearTrend  = e20 < e50 && e50 < e200;
  const trendStr   = bullTrend ? 'Strong Uptrend ↑' : bearTrend ? 'Strong Downtrend ↓' : aboveE200 ? 'Uptrend (partial)' : 'Downtrend (partial)';

  const { highs: swingH, lows: swingL } = findSwings(candles.slice(-60), 2);
  const struct = priceStructure(swingH, swingL);
  const vol    = analyzeVolume(candles);
  const swingLevels = [...swingH.slice(-6).map(s => s.price), ...swingL.slice(-6).map(s => s.price)];
  const atKeyLevel  = swingLevels.length > 0 && swingLevels.some(lvl => Math.abs(lvl - last.close) < atrVal);
  const nearestLevel = swingLevels.length > 0
    ? swingLevels.reduce((b, lvl) => Math.abs(lvl - last.close) < Math.abs(b - last.close) ? lvl : b, swingLevels[0])
    : null;

  const overview = {
    symbol:  inst.symbol, type: inst.type,
    price:   +last.close.toFixed(inst.dec),
    change:  +(last.close - prev.close).toFixed(inst.dec),
    trend:   aboveE200 ? 'bull' : 'bear',
    rsi:     +rsiVal.toFixed(1),
    atrPips: +(atrVal * inst.mult).toFixed(1),
  };

  if (!pat || pat.dir === 'NEUTRAL') return { overview, signal: null };

  const dir    = pat.dir;
  const trendOk = (dir === 'LONG' && aboveE200) || (dir === 'SHORT' && !aboveE200);
  const rsiOk   = (dir === 'LONG' && rsiVal < 65) || (dir === 'SHORT' && rsiVal > 35);
  if (!trendOk && !rsiOk) return { overview, signal: null };

  const entry = last.close;
  const stop  = dir === 'LONG' ? entry - atrVal * 1.5 : entry + atrVal * 1.5;
  const t1    = dir === 'LONG' ? entry + atrVal * 2.5 : entry - atrVal * 2.5;
  const t2    = dir === 'LONG' ? entry + atrVal * 4.0 : entry - atrVal * 4.0;
  const rr    = Math.abs(t1 - entry) / Math.abs(stop - entry);
  const structAligned = (dir === 'LONG' && struct === 'bullish') || (dir === 'SHORT' && struct === 'bearish');

  let conf = 30;
  if (trendOk) conf += 22;
  if (bullTrend || bearTrend) conf += 15;
  if (rsiOk) conf += 13;
  conf += pat.str === 3 ? 15 : pat.str === 2 ? 8 : 0;
  if (structAligned) conf += 10;
  if (atKeyLevel) conf += 12;
  if (vol && vol.ratio > 2.0) conf += 15;
  else if (vol && vol.ratio > 1.5) conf += 10;
  if (vol && vol.declining) conf += 8;
  conf = Math.min(93, conf);

  const reasons = [];
  if (trendOk) reasons.push(`Price ${dir === 'LONG' ? 'above' : 'below'} EMA200 — trend aligned`);
  if (bullTrend || bearTrend) reasons.push(`EMAs stacked (20/50/200) — strong ${dir === 'LONG' ? 'uptrend' : 'downtrend'}`);
  if (rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} — ${dir === 'LONG' ? 'room to run, not overbought' : 'room to fall, not oversold'}`);
  if (pat.str === 3) reasons.push(`${pat.name} — high-conviction reversal pattern`);
  else if (pat.str === 2) reasons.push(`${pat.name} — moderate-strength pattern`);
  if (structAligned) reasons.push(`Price structure: ${struct} (${dir === 'LONG' ? 'HH + HL sequence' : 'LH + LL sequence'} confirmed)`);
  if (atKeyLevel && nearestLevel) reasons.push(`Pattern at key S/R — nearest level ${nearestLevel.toFixed(inst.dec)} (${(Math.abs(nearestLevel - entry) * inst.mult).toFixed(0)} ${inst.unit} away)`);
  if (vol && vol.ratio > 2.0) reasons.push(`Volume surge ${vol.ratio}×avg — strong conviction behind move`);
  else if (vol && vol.ratio > 1.5) reasons.push(`Above-average volume ${vol.ratio}×avg — confirms breakout`);
  if (vol && vol.declining) reasons.push('Volume declining before pattern — consolidation signals imminent breakout');

  return {
    overview,
    signal: {
      symbol: inst.symbol, type: inst.type, dir, pat: pat.name,
      entry:  +entry.toFixed(inst.dec), stop: +stop.toFixed(inst.dec),
      t1:     +t1.toFixed(inst.dec),   t2:   +t2.toFixed(inst.dec),
      rr:     +rr.toFixed(2),
      riskPips: +(Math.abs(entry - stop) * inst.mult).toFixed(1),
      conf, rsi: +rsiVal.toFixed(1), trend: trendStr,
      atrPips: +(atrVal * inst.mult).toFixed(1),
      structure: struct, atKeyLevel, nearestLevel: nearestLevel ? +nearestLevel.toFixed(inst.dec) : null,
      volRatio: vol ? vol.ratio : null, volDeclining: vol ? vol.declining : false,
      reasons,
    },
  };
}

// ── Twelve Data fetch ────────────────────────────────────────────
async function fetchTd(symbol, interval) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=220&apikey=${TD_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.status === 'error') throw new Error(d.message || 'Twelve Data error');
  if (!d.values || !d.values.length) throw new Error('No candle data returned');
  return d.values.reverse().map(v => ({
    datetime: v.datetime,
    open: +v.open, high: +v.high, low: +v.low, close: +v.close,
    volume: v.volume ? +v.volume : 0,
  }));
}

// ── Scan one timeframe ───────────────────────────────────────────
async function scanTimeframe(tf, batchId) {
  console.log(`\n── Scanning ${tf} (batch: ${batchId}) ──`);
  const rows = [];
  const total = INSTRUMENTS.length;

  for (let i = 0; i < total; i++) {
    const inst = INSTRUMENTS[i];
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${total}] ${inst.symbol.padEnd(8)} `);
    try {
      const candles = await fetchTd(inst.symbol, tf);
      const result  = analyseCandles(candles, inst);
      if (!result) { console.log('skip (< 220 candles)'); continue; }

      const sig = result.signal;
      rows.push({
        batch_id:     batchId,
        symbol:       inst.symbol,
        timeframe:    tf,
        inst_type:    inst.type,
        inst_unit:    inst.unit,
        inst_mult:    inst.mult,
        inst_dec:     inst.dec,
        price:        result.overview.price,
        price_change: result.overview.change,
        trend:        result.overview.trend,
        rsi:          result.overview.rsi,
        atr_pips:     result.overview.atrPips,
        direction:    sig?.dir        ?? null,
        confidence:   sig?.conf       ?? null,
        pattern:      sig?.pat        ?? null,
        entry:        sig?.entry      ?? null,
        stop_loss:    sig?.stop       ?? null,
        tp1:          sig?.t1         ?? null,
        tp2:          sig?.t2         ?? null,
        rr:           sig?.rr         ?? null,
        risk_pips:    sig?.riskPips   ?? null,
        structure:    sig?.structure  ?? null,
        at_key_level: sig?.atKeyLevel ?? null,
        nearest_level:sig?.nearestLevel ?? null,
        vol_ratio:    sig?.volRatio   ?? null,
        vol_declining:sig?.volDeclining ?? null,
        reasons:      sig?.reasons    ?? null,
      });
      console.log(sig ? `${sig.dir} ${sig.conf}% conf (${sig.pat})` : 'no signal');
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }

    // Rate limit: stay comfortably under 8 req/min
    if (i < total - 1) await sleep(8500);
  }

  if (!rows.length) { console.log('  No rows to write.'); return; }

  const { error } = await sb.from('signals').insert(rows);
  if (error) {
    console.error(`  DB insert failed: ${error.message}`);
  } else {
    const sigs = rows.filter(r => r.direction).length;
    console.log(`  ✓ Wrote ${rows.length} rows (${sigs} signal(s)) to Supabase`);
  }
}

// ── Cleanup old data ─────────────────────────────────────────────
async function pruneOldSignals() {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { error, count } = await sb.from('signals').delete({ count: 'exact' }).lt('scanned_at', cutoff);
  if (error) console.warn('Prune error:', error.message);
  else if (count) console.log(`\nPruned ${count} old signal rows (> 48h)`);
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  console.log(`Sharpe Scanner — ${now.toISOString()}`);

  // Timeframe schedule:
  //   1day  — every run (all 6 daily runs)
  //   4h    — every run
  //   1week — Monday only (day 1 in getUTCDay)
  const timeframes = ['1day', '4h'];
  if (now.getUTCDay() === 1) {
    timeframes.push('1week');
    console.log('Monday: weekly scan included');
  }

  for (const tf of timeframes) {
    const batchId = `${tf}_${now.toISOString().slice(0, 16)}`; // "1day_2024-01-15T08:00"
    await scanTimeframe(tf, batchId);
    if (timeframes.indexOf(tf) < timeframes.length - 1) await sleep(3000);
  }

  await pruneOldSignals();
  console.log('\n✓ Scan complete');
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
