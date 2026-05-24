const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const SUPA_URL    = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const hdr = (extra: Record<string, string> = {}) => ({
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'apikey': SERVICE_KEY,
  'Content-Type': 'application/json',
  ...extra,
})

async function dbGet(table: string, params: string): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, { headers: hdr({ Prefer: '' }) })
  if (!r.ok) return []
  return r.json()
}

async function dbInsert(table: string, rows: unknown[]): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: hdr({ Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  })
}

async function dbPatch(table: string, updates: unknown, filter: string): Promise<void> {
  await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: hdr({ Prefer: 'return=minimal' }),
    body: JSON.stringify(updates),
  })
}

// ── Binance signing (for live crypto orders) ──────────────────────
async function bnSign(params: Record<string, unknown>, secret: string): Promise<string> {
  const qs = new URLSearchParams(params as Record<string, string>).toString()
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(qs))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function bnRequest(
  endpoint: string,
  params: Record<string, unknown>,
  method: string,
  apiKey: string,
  secret: string,
  testnet: boolean
): Promise<Record<string, unknown>> {
  const p = { ...params, timestamp: Date.now() }
  p.signature = await bnSign(p, secret)
  const base = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com'
  const qs = new URLSearchParams(p as Record<string, string>).toString()
  const url = method === 'GET' ? `${base}${endpoint}?${qs}` : `${base}${endpoint}`
  const r = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { body: qs } : {}),
  })
  return r.json()
}

function toBnSymbol(symbol: string): string {
  return symbol.split('/')[0] + 'USDT'
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

// ── OANDA helpers ─────────────────────────────────────────────────
function oandaBase(practice: boolean): string {
  return practice ? 'https://api-fxpractice.oanda.com/v3' : 'https://api-fxtrade.oanda.com/v3'
}

async function oandaGetBalance(token: string, accountId: string, practice: boolean): Promise<number> {
  const r = await fetch(`${oandaBase(practice)}/accounts/${accountId}/summary`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept-Datetime-Format': 'RFC3339' }
  })
  if (!r.ok) return 0
  const d = await r.json()
  return parseFloat(d.account?.balance ?? '0')
}

function calcOandaUnits(entryPrice: number, stopPrice: number, balance: number, riskPct: number, symbol: string): number {
  const riskAmt = balance * (riskPct / 100)
  const stopDist = Math.abs(entryPrice - stopPrice)
  if (!stopDist) return 1000
  const usdBase = ['USD/JPY', 'USD/CAD', 'USD/CHF'].includes(symbol)
  const units = usdBase
    ? Math.floor(riskAmt * entryPrice / stopDist)
    : Math.floor(riskAmt / stopDist)
  return Math.max(1000, Math.min(units, 500000))
}

async function oandaPlaceOrder(
  token: string, accountId: string, practice: boolean,
  symbol: string, units: number, isLong: boolean,
  stopPrice: number, tpPrice: number, dec: number,
  conf: number, pattern: string
): Promise<string> {
  const body = { order: {
    type: 'MARKET',
    instrument: symbol.replace('/', '_'),
    units: (isLong ? units : -units).toString(),
    stopLossOnFill:   { price: stopPrice.toFixed(dec) },
    takeProfitOnFill: { price: tpPrice.toFixed(dec) },
    tradeClientExtensions: { comment: `AutoSignal conf:${conf}% ${pattern}` },
  }}
  const r = await fetch(`${oandaBase(practice)}/accounts/${accountId}/orders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Datetime-Format': 'RFC3339' },
    body: JSON.stringify(body),
  })
  const d = await r.json()
  if (d.orderFillTransaction) return String(d.orderFillTransaction.tradeOpened?.tradeID ?? d.orderFillTransaction.id)
  if (d.orderCreateTransaction) return String(d.orderCreateTransaction.id)
  throw new Error(d.errorMessage ?? d.errorCode ?? JSON.stringify(d).slice(0, 120))
}

function calcBnQty(entryPrice: number, stopLoss: number, riskUsdt: number): string {
  const stopDist = Math.abs(entryPrice - stopLoss)
  if (!stopDist) return '0.001'
  const qty = Math.max(riskUsdt / stopDist, 10 / entryPrice)
  return qty.toFixed(6)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const now = new Date()

    // ── Load live prices ────────────────────────────────────────────
    const priceRows = await dbGet('live_prices', 'select=symbol,price')
    const pm: Record<string, number> = {}
    priceRows.forEach(r => { pm[r.symbol as string] = parseFloat(r.price as string) })

    // ── Load Binance config from site_config (shared admin keys) ───
    const cfgRows = await dbGet('site_config',
      'select=key,value&key=in.(bn_api_key,bn_secret,bn_testnet,bn_risk_usdt,tg_public_token,tg_public_channel_id)')
    const cfg: Record<string, string> = {}
    cfgRows.forEach(r => { cfg[r.key as string] = r.value as string })
    const bnApiKey   = cfg['bn_api_key'] ?? ''
    const bnSecret   = cfg['bn_secret']  ?? ''
    const bnTestnet  = cfg['bn_testnet'] !== 'false'
    const bnRiskUsdt = parseFloat(cfg['bn_risk_usdt'] ?? '50')
    const pubToken   = cfg['tg_public_token'] ?? ''
    const pubChannel = cfg['tg_public_channel_id'] ?? ''

    // ── Load per-user settings for Telegram + risk + OANDA ─────────
    interface UserSetting {
      user_id: string
      telegram_token: string|null
      telegram_chat_id: string|null
      risk_max_positions: number
      risk_max_daily_loss_pips: number
      risk_daily_loss_enabled: boolean
      risk_correlation_guard: boolean
      oanda_token: string|null
      oanda_account: string|null
      oanda_practice: boolean
      oanda_risk_pct: number
    }
    const userSettingsRows = await dbGet('user_settings',
      'select=user_id,telegram_token,telegram_chat_id,risk_max_positions,risk_max_daily_loss_pips,risk_daily_loss_enabled,risk_correlation_guard,oanda_token,oanda_account,oanda_practice,oanda_risk_pct'
    ) as UserSetting[]
    const userSettingsMap = new Map<string, UserSetting>(userSettingsRows.map(u => [u.user_id, u]))

    // ── Risk: pre-load open state (per-user) ───────────────────────
    const openNow = await dbGet('open_positions', 'status=eq.open&select=id,symbol,user_id') as Record<string,string>[]
    // openCount / openSymbols are per-user — resolved inline during pending loop
    const CORR_GROUPS = [
      ['EUR/USD','EUR/GBP','EUR/JPY','EUR/CHF'],
      ['GBP/USD','GBP/JPY'],
      ['USD/JPY','EUR/JPY','GBP/JPY','AUD/JPY'],
      ['AUD/USD','AUD/JPY'],
    ]
    // Per-user daily P&L (computed lazily below)
    const userDailyLossCache = new Map<string, number>()

    // ── 1. Process pending entries ──────────────────────────────────
    const pending = await dbGet('pending_entries', 'status=eq.pending&select=*')
    let opened = 0, expired = 0

    for (const e of pending) {
      const symbol  = e.symbol as string
      const price   = pm[symbol]
      const userId  = e.user_id as string | null
      const uCfg    = userId ? userSettingsMap.get(userId) : undefined

      // Per-user risk config (fallback to permissive defaults for entries without user_id)
      const maxPositions     = uCfg?.risk_max_positions     ?? 99
      const maxDailyLossPips = uCfg?.risk_max_daily_loss_pips ?? 0
      const dailyLossEnabled = uCfg?.risk_daily_loss_enabled ?? false
      const correlationGuard = uCfg?.risk_correlation_guard  ?? false

      // Per-user open positions for risk checks
      const userOpen = openNow.filter(p => (p.user_id ?? null) === userId)
      let userOpenCount = userOpen.length
      const userOpenSymbols = new Set(userOpen.map(p => p.symbol))

      // Expire stale entries
      if (new Date(e.expires_at as string) < now) {
        await dbPatch('pending_entries', { status: 'expired' }, `id=eq.${e.id}`)
        expired++
        continue
      }

      if (!price) continue

      const atr    = (e.atr_pips as number) / (e.inst_mult as number)
      const isLong = e.direction === 'LONG'
      const inZone = isLong
        ? price <= (e.entry_price as number) + atr * 0.25
        : price >= (e.entry_price as number) - atr * 0.25

      if (!inZone) continue

      // ── Risk management checks (per user) ──────────────────────
      if (userOpenCount >= maxPositions) continue
      if (dailyLossEnabled && maxDailyLossPips > 0) {
        let todayLoss = userDailyLossCache.get(userId ?? '') ?? null
        if (todayLoss === null && userId) {
          const todayStart = new Date(); todayStart.setHours(0,0,0,0)
          const todayClosed = await dbGet('open_positions',
            `status=eq.closed&closed_at=gte.${todayStart.toISOString()}&user_id=eq.${userId}&select=pnl_pips`
          ) as Record<string,number>[]
          todayLoss = todayClosed.reduce((s, p) => s + (p.pnl_pips || 0), 0)
          userDailyLossCache.set(userId, todayLoss)
        }
        if ((todayLoss ?? 0) <= -maxDailyLossPips) continue
      }
      if (correlationGuard) {
        const corrGroup = CORR_GROUPS.find(g => g.includes(symbol))
        if (corrGroup && corrGroup.some(s => s !== symbol && userOpenSymbols.has(s))) continue
      }

      // Open position
      await dbInsert('open_positions', [{
        user_id:     userId,
        entry_id:    e.id,
        symbol,
        timeframe:   e.timeframe,
        direction:   e.direction,
        entry_price: price,
        stop_loss:   e.stop_loss,
        tp1:         e.tp1,
        tp2:         e.tp2,
        confidence:  e.confidence,
        pattern:     e.pattern,
        inst_mult:   e.inst_mult,
        inst_dec:    e.inst_dec,
        inst_unit:   e.inst_unit,
        inst_type:   e.inst_type,
        mode:        e.mode,
      }])
      await dbPatch('pending_entries', { status: 'filled' }, `id=eq.${e.id}`)
      userOpenCount++; userOpenSymbols.add(symbol)
      // Update openNow so later entries in this loop see the updated count
      openNow.push({ id: '', symbol, user_id: userId ?? '' })
      opened++

      // ── Telegram: position opened (per user) ────────────────────
      const tgToken = uCfg?.telegram_token ?? ''
      const tgChat  = uCfg?.telegram_chat_id ?? ''
      if (tgToken && tgChat) {
        const modeTag = e.mode === 'live' ? '💰 Live' : '📋 Paper'
        const dEmoji  = isLong ? '🟢' : '🔴'
        await sendTelegram(tgToken, tgChat,
          `${dEmoji} *Position Opened — ${symbol} ${isLong?'LONG':'SHORT'}*\n${modeTag}\n📍 Entry: \`${price}\`\n🛡 Stop: \`${e.stop_loss}\`\n🎯 TP1: \`${e.tp1}\`\n🕯 ${e.pattern||'—'} · ${e.confidence}% conf`)
      }

      // ── Live Binance execution ──────────────────────────────────
      if (e.mode === 'live' && e.inst_type === 'crypto' && bnApiKey && bnSecret) {
        try {
          const bnSym = toBnSymbol(symbol)
          const qty   = calcBnQty(price, e.stop_loss as number, bnRiskUsdt)

          const order = await bnRequest('/api/v3/order', {
            symbol: bnSym, side: isLong ? 'BUY' : 'SELL',
            type: 'MARKET', quantity: qty,
          }, 'POST', bnApiKey, bnSecret, bnTestnet)

          if ((order as Record<string, unknown>).code) {
            console.error('Binance entry failed:', order)
            continue
          }

          const fillPrice = parseFloat((order as Record<string, string>).price ?? String(price))
          const orderId   = (order as Record<string, string>).orderId ?? ''

          const tpPrice  = e.tp1 as number
          const slPrice  = e.stop_loss as number
          const slLimit  = isLong
            ? +(slPrice * 0.999).toFixed(e.inst_dec as number)
            : +(slPrice * 1.001).toFixed(e.inst_dec as number)

          await bnRequest('/api/v3/order/oco', {
            symbol:               bnSym,
            side:                 isLong ? 'SELL' : 'BUY',
            quantity:             qty,
            price:                tpPrice.toFixed(e.inst_dec as number),
            stopPrice:            slPrice.toFixed(e.inst_dec as number),
            stopLimitPrice:       slLimit,
            stopLimitTimeInForce: 'GTC',
          }, 'POST', bnApiKey, bnSecret, bnTestnet)

          await dbPatch('open_positions', { broker_order_id: String(orderId), entry_price: fillPrice },
            `entry_id=eq.${e.id}`)
        } catch (err) {
          console.error('Binance execution error:', err)
        }
      }

      // ── Live OANDA execution (forex + commodities) ──────────────
      const oandaToken    = uCfg?.oanda_token    ?? ''
      const oandaAccount  = uCfg?.oanda_account  ?? ''
      const oandaPractice = uCfg?.oanda_practice !== false
      const oandaRiskPct  = uCfg?.oanda_risk_pct ?? 1
      if (e.mode === 'live' && (e.inst_type === 'forex' || e.inst_type === 'commodity') && oandaToken && oandaAccount) {
        try {
          const balance = await oandaGetBalance(oandaToken, oandaAccount, oandaPractice)
          const units   = calcOandaUnits(price, e.stop_loss as number, balance, oandaRiskPct, symbol)
          const tradeId = await oandaPlaceOrder(
            oandaToken, oandaAccount, oandaPractice,
            symbol, units, isLong,
            e.stop_loss as number, e.tp1 as number, e.inst_dec as number,
            e.confidence as number, (e.pattern as string) ?? '',
          )
          await dbPatch('open_positions', { broker_order_id: tradeId }, `entry_id=eq.${e.id}`)
        } catch (err) {
          console.error('OANDA execution error:', err)
        }
      }
    }

    // ── 2. Check open positions for SL/TP hits ──────────────────────
    const positions = await dbGet('open_positions', 'status=eq.open&select=*')
    let closed = 0
    const publicCloseNotified = new Set<string>()

    for (const pos of positions) {
      // Skip live Binance positions — OCO handles close on exchange
      if (pos.mode === 'live' && pos.broker_order_id) continue

      const price = pm[pos.symbol as string]
      if (!price) continue

      const isLong = pos.direction === 'LONG'
      const hitSL  = isLong ? price <= (pos.stop_loss as number) : price >= (pos.stop_loss as number)
      const hitTP  = isLong ? price >= (pos.tp1 as number)       : price <= (pos.tp1 as number)

      if (!hitSL && !hitTP) continue

      const reason  = hitTP ? 'tp1' : 'stop'
      const pnlPips = isLong
        ? (price - (pos.entry_price as number)) * (pos.inst_mult as number)
        : ((pos.entry_price as number) - price) * (pos.inst_mult as number)

      const pnlRounded = parseFloat(pnlPips.toFixed(1))
      await dbPatch('open_positions', {
        status:       'closed',
        closed_at:    now.toISOString(),
        close_price:  price,
        close_reason: reason,
        pnl_pips:     pnlRounded,
      }, `id=eq.${pos.id}`)
      closed++

      // ── Telegram: position closed (per user) ────────────────────
      const posUserId = pos.user_id as string | null
      const posUCfg   = posUserId ? userSettingsMap.get(posUserId) : undefined
      const posTgToken = posUCfg?.telegram_token ?? ''
      const posTgChat  = posUCfg?.telegram_chat_id ?? ''
      if (posTgToken && posTgChat) {
        const won   = reason === 'tp1'
        const emoji = won ? '✅' : '❌'
        const sign  = pnlRounded >= 0 ? '+' : ''
        await sendTelegram(posTgToken, posTgChat,
          `${emoji} *Position Closed — ${pos.symbol as string} ${pos.direction as string}*\n${won ? '🎯 Target hit!' : '🛡 Stop loss hit'}\n💰 P&L: \`${sign}${pnlRounded} ${(pos.inst_unit as string)||'pips'}\`\n📋 ${pos.mode === 'live' ? 'Live' : 'Paper'}`)
      }

      // ── Public Telegram: close result (paper positions, confidence ≥ 70) ──
      const pubKey = `${pos.symbol as string}-${pos.timeframe as string}-${pos.direction as string}`
      if (pubToken && pubChannel && (pos.confidence as number) >= 70 && !publicCloseNotified.has(pubKey)) {
        publicCloseNotified.add(pubKey)
        const won   = reason === 'tp1'
        const emoji = won ? '✅' : '❌'
        const sign  = pnlRounded >= 0 ? '+' : ''
        const tf    = pos.timeframe === 'daily' ? 'Daily' : pos.timeframe === '4h' ? '4H' : 'Weekly'
        await sendTelegram(pubToken, pubChannel, [
          `${emoji} *${won ? 'WIN' : 'LOSS'} — ${pos.symbol as string} ${pos.direction as string}* (${tf})`,
          `${won ? '🎯 TP1 hit' : '🛡 Stop hit'} · Result: \`${sign}${pnlRounded} ${(pos.inst_unit as string) || 'pips'}\``,
          `📍 Entry \`${pos.entry_price}\` → Exit \`${price}\``,
          ``,
          `_Powered by Sharpe_`,
        ].join('\n'))
      }
    }

    return new Response(JSON.stringify({ ok: true, opened, expired, closed, ts: now.toISOString() }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
