// Uses raw Supabase REST API — no npm imports needed (avoids esm.sh resolution at boot)
const SUPA_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

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

// ── Twelve Data helpers (forex + commodity) ────────────────────
async function fetchTwelveDataPrices(apiKey: string, insts: Inst[]): Promise<Record<string,number>> {
  if (!apiKey || !insts.length) return {}
  const symbols = insts.map(i => i.symbol)
  const url = `https://api.twelvedata.com/price?symbol=${symbols.map(encodeURIComponent).join(',')}&apikey=${apiKey}`
  const r = await fetch(url); if (!r.ok) return {}
  const data = await r.json()
  const out: Record<string,number> = {}
  if (symbols.length === 1) {
    if (data.price) out[symbols[0]] = parseFloat(data.price)
  } else {
    for (const sym of symbols) if (data[sym]?.price) out[sym] = parseFloat(data[sym].price)
  }
  return out
}

async function fetchTwelveDataCandles(symbol: string, interval: string, apiKey: string): Promise<Candle[]|null> {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=250&apikey=${apiKey}`
  const r = await fetch(url); if (!r.ok) return null
  const data = await r.json()
  if (!data.values || !Array.isArray(data.values)) return null
  return (data.values as Record<string,string>[]).reverse().map(v => ({
    open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low),
    close: parseFloat(v.close), volume: parseFloat(v.volume || '0')
  }))
}

// ── Binance helpers (crypto) ───────────────────────────────────
async function fetchBinancePrices(insts: Inst[]): Promise<Record<string,number>> {
  if (!insts.length) return {}
  const out: Record<string,number> = {}
  await Promise.all(insts.map(async inst => {
    if (!inst.bnSymbol) return
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${inst.bnSymbol}`)
      if (!r.ok) return
      const d = await r.json()
      if (d.price) out[inst.symbol] = parseFloat(d.price)
    } catch { /* skip */ }
  }))
  return out
}

async function fetchBinanceCandles(bnSymbol: string, interval: string): Promise<Candle[]|null> {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${bnSymbol}&interval=${interval}&limit=250`)
  if (!r.ok) return null
  const data = await r.json()
  if (!Array.isArray(data)) return null
  return data.map((k: unknown[]) => ({
    open:  parseFloat(k[1] as string),
    high:  parseFloat(k[2] as string),
    low:   parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string)
  }))
}

async function writeLog(entry: Record<string,unknown>): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/scan_log`, {
    method: 'POST',
    headers: hdr({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(entry)
  })
}

// ── Entry point ─────────────────────────────────────────────────
const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type'}

Deno.serve(async (req: Request) => {
  if (req.method==='OPTIONS') return new Response(null,{headers:CORS})

  const startMs = Date.now()
  const reqUrl = new URL(req.url)
  const pricesOnly = reqUrl.searchParams.get('pricesOnly') === 'true'

  // Read Twelve Data key
  const cfgRows = await dbGet('site_config', 'select=value&key=eq.twelve_data_key&limit=1') as {value:string}[]
  const apiKey = cfgRows[0]?.value ?? ''

  const tdInsts = INSTRUMENTS.filter(i => !i.bnSymbol)
  const bnInsts = INSTRUMENTS.filter(i => i.bnSymbol)

  // Fetch prices: Twelve Data for forex/commodity, Binance for crypto (no key needed)
  const [tdPrices, bnPrices] = await Promise.all([
    fetchTwelveDataPrices(apiKey, tdInsts),
    fetchBinancePrices(bnInsts)
  ])
  const priceMap = { ...tdPrices, ...bnPrices }
  const priceCount = Object.keys(priceMap).length

  if (priceCount > 0) {
    const rows = Object.entries(priceMap).map(([symbol,price]) => ({symbol,price,change_pct:0,updated_at:new Date().toISOString()}))
    await dbUpsert('live_prices', rows, 'symbol')
  }

  if (pricesOnly) {
    await writeLog({run_type:'prices',prices_updated:priceCount,duration_ms:Date.now()-startMs,status:'ok'})
    return new Response(JSON.stringify({ok:true,prices:priceCount}),{headers:{...CORS,'Content-Type':'application/json'}})
  }

  // Full scan — crypto runs even without a Finnhub key (Binance is free)
  const batchId = crypto.randomUUID(), scannedAt = new Date().toISOString()
  const signalRows: unknown[] = []
  let scanError: string|null = null

  try {
    for (const {tf, tdInterval, bnInterval} of [
      {tf:'daily', tdInterval:'1day', bnInterval:'1d'},
      {tf:'4h',    tdInterval:'4h',   bnInterval:'4h'}
    ]) {
      for (const inst of INSTRUMENTS) {
        try {
          let candles: Candle[]|null = null
          if (inst.bnSymbol) {
            candles = await fetchBinanceCandles(inst.bnSymbol, bnInterval)
          } else if (apiKey) {
            candles = await fetchTwelveDataCandles(inst.symbol, tdInterval, apiKey)
          }
          if (!candles) continue
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
    if (signalRows.length > 0) await dbInsert('signals', signalRows)
  } catch(e) {
    scanError = e instanceof Error ? e.message : String(e)
  }

  await writeLog({
    run_type:'full', batch_id:batchId,
    signals_generated:signalRows.length, prices_updated:priceCount,
    duration_ms:Date.now()-startMs,
    status:scanError?'error':'ok',
    error_msg:scanError
  })

  if (scanError) return new Response(JSON.stringify({ok:false,error:scanError}),{status:500,headers:{...CORS,'Content-Type':'application/json'}})
  return new Response(JSON.stringify({ok:true,signals:signalRows.length,batch:batchId,scanned_at:scannedAt}),{headers:{...CORS,'Content-Type':'application/json'}})
})
