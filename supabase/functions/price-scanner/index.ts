// Uses raw Supabase REST API — no npm imports needed (avoids esm.sh resolution at boot)
const SUPA_URL   = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Candles fetched per instrument on regular runs vs seed runs
const FETCH_SIZE = 3
const SEED_SIZE  = 250

const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type'}

const hdr = (extra: Record<string,string> = {}) => ({
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'apikey': SERVICE_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
  ...extra
})

async function dbGet(table: string, params: string): Promise<unknown[]> {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, { headers: hdr({'Prefer':''}) })
  if (!r.ok) return []
  return r.json()
}

async function dbUpsert(table: string, rows: unknown[], conflict: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: hdr({ 'Prefer': `resolution=merge-duplicates,return=minimal`, 'on-conflict': conflict }),
    body: JSON.stringify(rows)
  })
}

async function dbInsert(table: string, rows: unknown[]): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: hdr(),
    body: JSON.stringify(rows)
  })
}

async function dbDelete(table: string, params: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, { method: 'DELETE', headers: hdr() })
}

// ── Instrument catalogue ────────────────────────────────────────
interface Inst { symbol:string; type:string; base:number; mult:number; dec:number; unit:string; proOnly?:boolean; bnSymbol?:string }
const INSTRUMENTS: Inst[] = [
  { symbol:'EUR/USD', type:'forex',     base:1.08,  mult:10000, dec:5, unit:'pips' },
  { symbol:'GBP/USD', type:'forex',     base:1.27,  mult:10000, dec:5, unit:'pips' },
  { symbol:'USD/JPY', type:'forex',     base:149,   mult:100,   dec:3, unit:'pips' },
  { symbol:'AUD/USD', type:'forex',     base:0.65,  mult:10000, dec:5, unit:'pips' },
  { symbol:'USD/CAD', type:'forex',     base:1.36,  mult:10000, dec:5, unit:'pips' },
  { symbol:'NZD/USD', type:'forex',     base:0.60,  mult:10000, dec:5, unit:'pips' },
  { symbol:'USD/CHF', type:'forex',     base:0.90,  mult:10000, dec:5, unit:'pips' },
  { symbol:'EUR/GBP', type:'forex',     base:0.85,  mult:10000, dec:5, unit:'pips' },
  { symbol:'EUR/JPY', type:'forex',     base:160,   mult:100,   dec:3, unit:'pips' },
  { symbol:'GBP/JPY', type:'forex',     base:187,   mult:100,   dec:3, unit:'pips' },
  { symbol:'EUR/CHF', type:'forex',     base:0.97,  mult:10000, dec:5, unit:'pips' },
  { symbol:'AUD/JPY', type:'forex',     base:97,    mult:100,   dec:3, unit:'pips' },
  { symbol:'XAU/USD', type:'commodity', base:1980,  mult:10,    dec:2, unit:'pts',  proOnly:true },
  { symbol:'XAG/USD', type:'commodity', base:24,    mult:100,   dec:3, unit:'pts',  proOnly:true },
  { symbol:'BTC/USD', type:'crypto',    base:42000, mult:1,     dec:0, unit:'pts',  proOnly:true, bnSymbol:'BTCUSDT' },
  { symbol:'ETH/USD', type:'crypto',    base:2200,  mult:1,     dec:2, unit:'pts',  proOnly:true, bnSymbol:'ETHUSDT' },
]

// ── Technical analysis ─────────────────────────────────────────
interface Candle { open:number; high:number; low:number; close:number; volume:number }

function calcEmaAll(closes: number[], period: number): number[] {
  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period
  const out: number[] = new Array(period - 1).fill(ema)
  out.push(ema)
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); out.push(ema) }
  return out
}

function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let ag = 0, al = 0
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; ag += Math.max(d,0); al += Math.max(-d,0) }
  ag /= period; al /= period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1]
    ag = (ag*(period-1)+Math.max(d,0))/period; al = (al*(period-1)+Math.max(-d,0))/period
  }
  return al === 0 ? 100 : 100 - 100/(1+ag/al)
}

function calcAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const trs: number[] = []
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])))
  if (trs.length < period) return trs.reduce((s,v)=>s+v,0)/trs.length || 0.001
  let a = trs.slice(0,period).reduce((s,v)=>s+v,0)/period
  for (let i = period; i < trs.length; i++) a = (a*(period-1)+trs[i])/period
  return a || 0.001
}

function detectPat(cs: Candle[]) {
  const n = cs.length; if (n < 2) return null
  const c = cs[n-1], p = cs[n-2], pp = n >= 3 ? cs[n-3] : null
  const cBody = Math.abs(c.close-c.open), pBody = Math.abs(p.close-p.open)
  const cRange = c.high-c.low, cLo = Math.min(c.open,c.close), cHi = Math.max(c.open,c.close)
  const lw = cLo-c.low, uw = c.high-cHi
  if (cRange > 0 && cBody < cRange*0.08) return {name:'Doji',dir:'NEUTRAL',str:1}
  if (p.close<p.open&&c.close>c.open&&c.open<=p.close&&c.close>=p.open&&cBody>pBody*0.8)
    return {name:'Bullish Engulfing',dir:'LONG',str:3}
  if (p.close>p.open&&c.close<c.open&&c.open>=p.close&&c.close<=p.open&&cBody>pBody*0.8)
    return {name:'Bearish Engulfing',dir:'SHORT',str:3}
  if (lw>cBody*2&&uw<cBody*0.5&&cRange>0) return {name:'Bullish Pin Bar',dir:'LONG',str:2}
  if (uw>cBody*2&&lw<cBody*0.5&&cRange>0) return {name:'Bearish Pin Bar',dir:'SHORT',str:2}
  if (c.high<p.high&&c.low>p.low) return {name:'Inside Bar',dir:'NEUTRAL',str:1}
  if (pp) {
    const ppBody = Math.abs(pp.close-pp.open)
    if (pp.close<pp.open&&pBody<ppBody*0.3&&c.close>c.open&&c.close>(pp.open+pp.close)/2)
      return {name:'Morning Star',dir:'LONG',str:3}
    if (pp.close>pp.open&&pBody<ppBody*0.3&&c.close<c.open&&c.close<(pp.open+pp.close)/2)
      return {name:'Evening Star',dir:'SHORT',str:3}
    if (pp.close>pp.open&&p.close>p.open&&c.close>c.open&&c.close>p.close&&p.close>pp.close)
      return {name:'Three White Soldiers',dir:'LONG',str:3}
    if (pp.close<pp.open&&p.close<p.open&&c.close<c.open&&c.close<p.close&&p.close<pp.close)
      return {name:'Three Black Crows',dir:'SHORT',str:3}
  }
  return null
}

function findSwings(candles: Candle[], pivot = 2) {
  const highs: {price:number}[] = [], lows: {price:number}[] = []
  for (let i = pivot; i < candles.length-pivot; i++) {
    let isH = true, isL = true
    for (let j = 1; j <= pivot; j++) {
      if (candles[i-j].high>=candles[i].high||candles[i+j].high>=candles[i].high) isH=false
      if (candles[i-j].low<=candles[i].low||candles[i+j].low<=candles[i].low) isL=false
    }
    if (isH) highs.push({price:candles[i].high})
    if (isL) lows.push({price:candles[i].low})
  }
  return {highs, lows}
}

function priceStructure(highs: {price:number}[], lows: {price:number}[]): string {
  const rH = highs.slice(-3), rL = lows.slice(-3)
  if (rH.length<2||rL.length<2) return 'unknown'
  const hh = rH[rH.length-1].price>rH[rH.length-2].price
  const hl = rL[rL.length-1].price>rL[rL.length-2].price
  const ll = rL[rL.length-1].price<rL[rL.length-2].price
  const lh = rH[rH.length-1].price<rH[rH.length-2].price
  if (hh&&hl) return 'bullish'; if (ll&&lh) return 'bearish'; return 'ranging'
}

function analyzeVolume(candles: Candle[], period = 20) {
  const vols = candles.map(c=>c.volume||0)
  if (!vols.some(v=>v>0)) return null
  const recent = vols.slice(-(period+1))
  const avg = recent.slice(0,-1).reduce((s,v)=>s+v,0)/period
  const last = recent[recent.length-1]
  const ratio = avg>0 ? last/avg : 1
  const last5 = vols.slice(-6,-1)
  return {ratio:+ratio.toFixed(2), declining: last5.length>=2 && last5[last5.length-1]<last5[0]*0.8}
}

function analyseCandles(candles: Candle[], inst: Inst) {
  if (candles.length < 220) return null
  const closes=candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low)
  const e20a=calcEmaAll(closes,20), e50a=calcEmaAll(closes,50), e200a=calcEmaAll(closes,200)
  const e20=e20a[e20a.length-1], e50=e50a[e50a.length-1], e200=e200a[e200a.length-1]
  const rsiVal=calcRsi(closes,14), atrVal=calcAtr(highs,lows,closes,14)
  const last=candles[candles.length-1], prev=candles[candles.length-2]
  const pat=detectPat(candles.slice(-3))
  const aboveE200=last.close>e200
  const bullTrend=e20>e50&&e50>e200, bearTrend=e20<e50&&e50<e200
  const trendStr=bullTrend?'Strong Uptrend ↑':bearTrend?'Strong Downtrend ↓':aboveE200?'Uptrend (partial)':'Downtrend (partial)'
  const {highs:swingH,lows:swingL}=findSwings(candles.slice(-60),2)
  const struct=priceStructure(swingH,swingL)
  const vol=analyzeVolume(candles)
  const swingLevels=[...swingH.slice(-6).map(s=>s.price),...swingL.slice(-6).map(s=>s.price)]
  const atKeyLevel=swingLevels.length>0&&swingLevels.some(lvl=>Math.abs(lvl-last.close)<atrVal)
  const nearestLevel=swingLevels.length>0?swingLevels.reduce((b,lvl)=>Math.abs(lvl-last.close)<Math.abs(b-last.close)?lvl:b,swingLevels[0]):null

  const overview={
    symbol:inst.symbol,type:inst.type,price:+last.close.toFixed(inst.dec),
    change:+(last.close-prev.close).toFixed(inst.dec),
    trend:aboveE200?'bull':'bear',rsi:+rsiVal.toFixed(1),atrPips:+(atrVal*inst.mult).toFixed(1)
  }

  if (!pat||pat.dir==='NEUTRAL') return {overview,signal:null}
  const dir=pat.dir
  const trendOk=(dir==='LONG'&&aboveE200)||(dir==='SHORT'&&!aboveE200)
  const rsiOk=(dir==='LONG'&&rsiVal<65)||(dir==='SHORT'&&rsiVal>35)
  if (!trendOk&&!rsiOk) return {overview,signal:null}

  const entry=last.close
  const stop=dir==='LONG'?entry-atrVal*1.5:entry+atrVal*1.5
  const t1=dir==='LONG'?entry+atrVal*2.5:entry-atrVal*2.5
  const t2=dir==='LONG'?entry+atrVal*4.0:entry-atrVal*4.0
  const rr=Math.abs(t1-entry)/Math.abs(stop-entry)
  const structAligned=(dir==='LONG'&&struct==='bullish')||(dir==='SHORT'&&struct==='bearish')

  let conf=30
  if(trendOk) conf+=22; if(bullTrend||bearTrend) conf+=15; if(rsiOk) conf+=13
  conf+=pat.str===3?15:pat.str===2?8:0
  if(structAligned) conf+=10; if(atKeyLevel) conf+=12
  if(vol&&vol.ratio>2.0) conf+=15; else if(vol&&vol.ratio>1.5) conf+=10
  if(vol&&vol.declining) conf+=8
  conf=Math.min(93,conf)

  const reasons:string[]=[]
  if(trendOk) reasons.push(`Price ${dir==='LONG'?'above':'below'} EMA200 — trend aligned`)
  if(bullTrend||bearTrend) reasons.push(`EMAs stacked (20/50/200) — strong ${dir==='LONG'?'uptrend':'downtrend'}`)
  if(rsiOk) reasons.push(`RSI ${rsiVal.toFixed(0)} — ${dir==='LONG'?'room to run':'room to fall'}`)
  if(pat.str===3) reasons.push(`${pat.name} — high-conviction pattern`)
  else if(pat.str===2) reasons.push(`${pat.name} — moderate-strength pattern`)
  if(structAligned) reasons.push(`Price structure: ${struct}`)
  if(atKeyLevel&&nearestLevel) reasons.push(`Key S/R level at ${nearestLevel.toFixed(inst.dec)}`)
  if(vol&&vol.ratio>2.0) reasons.push(`Volume surge ${vol.ratio}×avg`)
  else if(vol&&vol.ratio>1.5) reasons.push(`Above-average volume ${vol.ratio}×avg`)
  if(vol&&vol.declining) reasons.push('Volume declining — consolidation before breakout')

  return {
    overview,
    signal:{
      dir,pat:pat.name,entry:+entry.toFixed(inst.dec),stop:+stop.toFixed(inst.dec),
      t1:+t1.toFixed(inst.dec),t2:+t2.toFixed(inst.dec),rr:+rr.toFixed(2),
      riskPips:+(Math.abs(entry-stop)*inst.mult).toFixed(1),conf,rsi:+rsiVal.toFixed(1),
      trend:trendStr,atrPips:+(atrVal*inst.mult).toFixed(1),structure:struct,
      atKeyLevel,nearestLevel:nearestLevel?+nearestLevel.toFixed(inst.dec):null,
      volRatio:vol?vol.ratio:null,volDeclining:vol?vol.declining:false,
      reasons,unit:inst.unit,mult:inst.mult,dec:inst.dec
    }
  }
}

// ── Candle fetch helpers ───────────────────────────────────────
interface CandleFetch { candles: Candle[]; timestamps: string[] }

async function fetchTdCandles(symbol: string, interval: string, apiKey: string, size: number): Promise<CandleFetch|null> {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${size}&apikey=${apiKey}`
  const r = await fetch(url); if (!r.ok) return null
  const data = await r.json()
  if (!data.values || !Array.isArray(data.values)) return null
  const rows = (data.values as Record<string,string>[]).reverse()
  return {
    candles: rows.map(v=>({open:+v.open,high:+v.high,low:+v.low,close:+v.close,volume:+(v.volume||0)})),
    timestamps: rows.map(v=>new Date(v.datetime.replace(' ','T')+'Z').toISOString())
  }
}

async function fetchBnCandles(bnSymbol: string, interval: string, size: number): Promise<CandleFetch|null> {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${bnSymbol}&interval=${interval}&limit=${size}`)
  if (!r.ok) return null
  const data = await r.json()
  if (!Array.isArray(data)) return null
  return {
    candles: data.map((k:unknown[])=>({open:+((k as string[])[1]),high:+((k as string[])[2]),low:+((k as string[])[3]),close:+((k as string[])[4]),volume:+((k as string[])[5])})),
    timestamps: data.map((k:unknown[])=>new Date((k as number[])[0]).toISOString())
  }
}

// ── Candle cache (Supabase) ────────────────────────────────────
async function cacheCandles(symbol: string, tf: string, fetched: CandleFetch): Promise<void> {
  if (!fetched.candles.length) return
  const rows = fetched.candles.map((c,i)=>({
    symbol, timeframe:tf, ts:fetched.timestamps[i],
    open:c.open, high:c.high, low:c.low, close:c.close, volume:c.volume
  }))
  await dbUpsert('candles', rows, 'symbol,timeframe,ts')
}

async function loadCandles(symbol: string, tf: string): Promise<Candle[]> {
  // Fetch latest 250 rows descending, then reverse for chronological TA order
  const rows = await dbGet('candles',
    `select=open,high,low,close,volume&symbol=eq.${encodeURIComponent(symbol)}&timeframe=eq.${encodeURIComponent(tf)}&order=ts.desc&limit=250`
  ) as {open:string;high:string;low:string;close:string;volume:string}[]
  return rows.reverse().map(r=>({open:+r.open,high:+r.high,low:+r.low,close:+r.close,volume:+r.volume}))
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch { /* non-critical */ }
}

async function writeLog(entry: Record<string,unknown>): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/scan_log`, {
    method: 'POST',
    headers: hdr({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(entry)
  })
}

// ── Entry point ─────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{headers:CORS})

  const startMs  = Date.now()
  const reqUrl   = new URL(req.url)
  const pricesOnly = reqUrl.searchParams.get('pricesOnly') === 'true'
  const seed       = reqUrl.searchParams.get('seed') === 'true'
  const fetchSize  = seed ? SEED_SIZE : FETCH_SIZE

  // Read Twelve Data key
  const cfgRows = await dbGet('site_config','select=value&key=eq.twelve_data_key&limit=1') as {value:string}[]
  const apiKey  = cfgRows[0]?.value ?? ''

  // ── Price-only mode: update crypto via Binance + forex via open.er-api.com
  if (pricesOnly) {
    const now = new Date().toISOString()
    const priceRows: {symbol:string;price:number;change_pct:number;updated_at:string}[] = []

    // Crypto prices from Binance
    const bnInsts = INSTRUMENTS.filter(i=>i.bnSymbol)
    await Promise.all(bnInsts.map(async inst=>{
      try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${inst.bnSymbol}`)
        if (!r.ok) return
        const d = await r.json()
        if (d.price) priceRows.push({symbol:inst.symbol,price:parseFloat(d.price),change_pct:0,updated_at:now})
      } catch { /* skip */ }
    }))

    // Forex + commodity prices from open.er-api.com (free, no key, 1500 req/month)
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD')
      if (r.ok) {
        const d = await r.json() as {rates:Record<string,number>}
        const rates = d.rates
        const fxMap: Record<string,()=>number|undefined> = {
          'EUR/USD': () => rates.EUR ? 1/rates.EUR : undefined,
          'GBP/USD': () => rates.GBP ? 1/rates.GBP : undefined,
          'USD/JPY': () => rates.JPY,
          'AUD/USD': () => rates.AUD ? 1/rates.AUD : undefined,
          'USD/CAD': () => rates.CAD,
          'NZD/USD': () => rates.NZD ? 1/rates.NZD : undefined,
          'USD/CHF': () => rates.CHF,
          'EUR/GBP': () => (rates.GBP&&rates.EUR) ? rates.GBP/rates.EUR : undefined,
          'EUR/JPY': () => (rates.JPY&&rates.EUR) ? rates.JPY/rates.EUR : undefined,
          'GBP/JPY': () => (rates.JPY&&rates.GBP) ? rates.JPY/rates.GBP : undefined,
          'EUR/CHF': () => (rates.CHF&&rates.EUR) ? rates.CHF/rates.EUR : undefined,
          'AUD/JPY': () => (rates.JPY&&rates.AUD) ? rates.JPY/rates.AUD : undefined,
          'XAU/USD': () => rates.XAU ? 1/rates.XAU : undefined,
          'XAG/USD': () => rates.XAG ? 1/rates.XAG : undefined,
        }
        for (const [symbol, calc] of Object.entries(fxMap)) {
          const price = calc()
          if (price) priceRows.push({symbol, price, change_pct:0, updated_at:now})
        }
      }
    } catch { /* skip forex */ }

    if (priceRows.length) await dbUpsert('live_prices', priceRows, 'symbol')
    await writeLog({run_type:'prices',prices_updated:priceRows.length,duration_ms:Date.now()-startMs,status:'ok'})
    return new Response(JSON.stringify({ok:true,prices:priceRows.length}),{headers:{...CORS,'Content-Type':'application/json'}})
  }

  // ── Prune signals older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  await dbDelete('signals', `scanned_at=lt.${cutoff}`)

  // ── Full scan (or seed)
  const batchId = crypto.randomUUID(), scannedAt = new Date().toISOString()
  const signalRows: unknown[] = []
  const priceMap:  Record<string,number> = {}
  let   seedCount  = 0
  let   scanError: string|null = null

  try {
    for (const {tf, tdInterval, bnInterval} of [
      {tf:'daily',  tdInterval:'1day',  bnInterval:'1d'},
      {tf:'4h',     tdInterval:'4h',    bnInterval:'4h'},
      {tf:'weekly', tdInterval:'1week', bnInterval:'1w'},
    ]) {
      for (const inst of INSTRUMENTS) {
        try {
          // 1. Fetch new candles from API and write to cache
          let fetched: CandleFetch|null = null
          if (inst.bnSymbol) {
            fetched = await fetchBnCandles(inst.bnSymbol, bnInterval, fetchSize)
          } else if (apiKey) {
            fetched = await fetchTdCandles(inst.symbol, tdInterval, apiKey, fetchSize)
          }
          if (fetched) { await cacheCandles(inst.symbol, tf, fetched); seedCount++ }

          // 2. Load full history from cache for TA
          const candles = await loadCandles(inst.symbol, tf)
          if (candles.length < 220) continue

          // 3. Track latest price from daily candles
          if (tf === 'daily') priceMap[inst.symbol] = candles[candles.length-1].close

          // 4. Run analysis
          const result = analyseCandles(candles, inst)
          if (!result) continue
          const {overview, signal} = result

          signalRows.push({
            batch_id:batchId, scanned_at:scannedAt, timeframe:tf, symbol:inst.symbol,
            inst_type:inst.type, price:overview.price, price_change:overview.change,
            trend:overview.trend, rsi:overview.rsi, atr_pips:overview.atrPips,
            direction:signal?.dir??null, pattern:signal?.pat??null,
            entry:signal?.entry??null, stop_loss:signal?.stop??null,
            tp1:signal?.t1??null, tp2:signal?.t2??null, rr:signal?.rr??null,
            risk_pips:signal?.riskPips??null, confidence:signal?.conf??null,
            structure:signal?.structure??null, at_key_level:signal?.atKeyLevel??false,
            nearest_level:signal?.nearestLevel??null, vol_ratio:signal?.volRatio??null,
            vol_declining:signal?.volDeclining??false, reasons:signal?.reasons??[],
            inst_unit:inst.unit, inst_mult:inst.mult, inst_dec:inst.dec, pro_only:inst.proOnly??false
          })
        } catch(e) { console.error(`scan ${inst.symbol} ${tf}:`, e) }
      }
    }

    // Update live_prices from latest daily candle closes
    if (Object.keys(priceMap).length > 0) {
      const rows = Object.entries(priceMap).map(([symbol,price])=>({symbol,price,change_pct:0,updated_at:new Date().toISOString()}))
      await dbUpsert('live_prices', rows, 'symbol')
    }

    if (signalRows.length > 0) await dbInsert('signals', signalRows)

    // ── Per-user auto paper trade + Telegram alerts ─────────────
    interface UserSetting {
      user_id: string
      auto_paper_trade: boolean
      auto_paper_min_conf: number
      telegram_token: string|null
      telegram_chat_id: string|null
    }
    const userSettings = await dbGet(
      'user_settings',
      'select=user_id,auto_paper_trade,auto_paper_min_conf,telegram_token,telegram_chat_id'
    ) as UserSetting[]

    const tfExpiry: Record<string,number> = { daily:3, '4h':0.5, weekly:7 }
    const sigs = signalRows as Record<string,unknown>[]

    for (const u of userSettings) {
      // Auto paper entries for this user
      if (u.auto_paper_trade) {
        const minConf = u.auto_paper_min_conf ?? 70
        const pendingRows = sigs
          .filter(r => r.direction && (r.confidence as number) >= minConf)
          .map(r => ({
            user_id:     u.user_id,
            symbol:      r.symbol,
            timeframe:   r.timeframe,
            direction:   r.direction,
            entry_price: r.entry,
            stop_loss:   r.stop_loss,
            tp1:         r.tp1,
            tp2:         r.tp2,
            confidence:  r.confidence,
            pattern:     r.pattern,
            atr_pips:    r.atr_pips,
            inst_mult:   r.inst_mult,
            inst_dec:    r.inst_dec,
            inst_unit:   r.inst_unit,
            inst_type:   r.inst_type,
            mode:        'paper',
            expires_at:  new Date(Date.now() + (tfExpiry[r.timeframe as string] ?? 1) * 24*60*60*1000).toISOString(),
          }))
        if (pendingRows.length > 0) await dbInsert('pending_entries', pendingRows)
      }

      // Telegram signal alerts for this user
      if (u.telegram_token && u.telegram_chat_id) {
        const minConf = u.auto_paper_min_conf ?? 70
        const sigAlerts = sigs.filter(r => r.direction && (r.confidence as number) >= minConf)
        for (const s of sigAlerts) {
          const dir   = s.direction as string
          const tf    = s.timeframe === 'daily' ? 'Daily' : s.timeframe === '4h' ? '4H' : 'Weekly'
          const emoji = dir === 'LONG' ? '🟢' : '🔴'
          const text  = `${emoji} *${dir} — ${s.symbol}*\n⏱ ${tf} · 🎯 ${s.confidence}% confidence\n📍 Entry: \`${s.entry}\`\n🛡 Stop: \`${s.stop_loss}\` (${s.risk_pips} ${s.inst_unit})\n🎯 TP1: \`${s.tp1}\`\n📊 R:R 1:${s.rr} · ${s.pattern}`
          await sendTelegram(u.telegram_token, u.telegram_chat_id, text)
        }
      }
    }
  } catch(e) {
    scanError = e instanceof Error ? e.message : String(e)
  }

  await writeLog({
    run_type: seed ? 'seed' : 'full',
    batch_id:batchId, signals_generated:signalRows.length,
    prices_updated:Object.keys(priceMap).length,
    duration_ms:Date.now()-startMs,
    status:scanError?'error':'ok', error_msg:scanError
  })

  if (scanError) return new Response(JSON.stringify({ok:false,error:scanError}),{status:500,headers:{...CORS,'Content-Type':'application/json'}})
  return new Response(JSON.stringify({
    ok:true, seed, candles_written:seedCount,
    signals:signalRows.length, batch:batchId, scanned_at:scannedAt
  }),{headers:{...CORS,'Content-Type':'application/json'}})
})
