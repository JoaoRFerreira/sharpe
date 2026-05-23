import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_KEY)

interface WebhookPayload {
  secret?:    string
  symbol:     string          // e.g. "EURUSD" or "EUR/USD"
  direction:  'long' | 'short'
  entry:      number
  stop:       number
  tp?:        number
  timeframe?: string          // e.g. "4h"
  confidence?: number         // 0–100
  note?:      string
}

function normalizeSymbol(raw: string): string {
  // Accept EURUSD → EUR/USD, BTCUSDT stays as BTCUSDT
  const s = raw.toUpperCase().trim()
  const fxPairs = ['EUR','GBP','AUD','NZD','USD','CAD','CHF','JPY','XAU','XAG']
  // If it looks like 6-char concatenated pair (EURUSD)
  if (s.length === 6 && !s.includes('/')) {
    const base  = s.slice(0, 3)
    const quote = s.slice(3, 6)
    if (fxPairs.includes(base) && fxPairs.includes(quote)) return `${base}/${quote}`
  }
  return s
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let body: WebhookPayload
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  // Validate secret token
  const { data: secretCfg } = await sb
    .from('site_config')
    .select('value')
    .eq('key', 'tv_webhook_secret')
    .maybeSingle()

  const expectedSecret = secretCfg?.value
  if (expectedSecret && body.secret !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Validate required fields
  if (!body.symbol || !body.direction || !body.entry || !body.stop) {
    return new Response('Missing required fields: symbol, direction, entry, stop', { status: 400 })
  }
  if (!['long', 'short'].includes(body.direction)) {
    return new Response('direction must be "long" or "short"', { status: 400 })
  }

  const symbol    = normalizeSymbol(body.symbol)
  const timeframe = body.timeframe ?? '4h'
  const conf      = body.confidence ?? 75
  const tp        = body.tp ?? (body.direction === 'long'
    ? body.entry + (body.entry - body.stop) * 2
    : body.entry - (body.stop - body.entry) * 2)

  // Upsert into signals table so it shows on dashboard
  const { error: sigErr } = await sb.from('signals').upsert({
    symbol,
    timeframe,
    direction:  body.direction,
    entry:      body.entry,
    stop:       body.stop,
    tp,
    confidence: conf,
    reasons:    body.note ? [body.note] : ['TradingView Alert'],
    created_at: new Date().toISOString(),
  }, { onConflict: 'symbol,timeframe' })

  if (sigErr) {
    console.error('signal upsert error:', sigErr)
    return new Response(JSON.stringify({ error: sigErr.message }), { status: 500 })
  }

  // Auto-create pending_entries for users who have auto_paper_trade enabled
  // and whose min_conf is met
  const { data: users } = await sb
    .from('user_settings')
    .select('user_id, auto_paper_min_conf')
    .eq('auto_paper_trade', true)
    .lte('auto_paper_min_conf', conf)

  let entriesCreated = 0
  for (const u of users ?? []) {
    const { error: peErr } = await sb.from('pending_entries').insert({
      user_id:    u.user_id,
      symbol,
      timeframe,
      direction:  body.direction,
      entry_low:  Math.min(body.entry, body.stop + (body.direction === 'long' ? 0.0001 : -0.0001)),
      entry_high: body.entry,
      stop:       body.stop,
      tp,
      mode:       'paper',
      created_at: new Date().toISOString(),
    })
    if (!peErr) entriesCreated++
  }

  return new Response(JSON.stringify({ ok: true, symbol, entriesCreated }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
