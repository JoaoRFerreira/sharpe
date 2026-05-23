import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_KEY)

async function sendTelegram(token: string, chatId: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
  } catch { /* non-critical */ }
}

Deno.serve(async () => {
  // Fetch Anthropic API key from site_config
  const { data: cfg } = await sb
    .from('site_config')
    .select('value')
    .eq('key', 'anthropic_api_key')
    .maybeSingle()

  const anthropicKey = cfg?.value
  if (!anthropicKey) return new Response('no anthropic key', { status: 200 })

  // Fetch current signals
  const { data: signals } = await sb
    .from('signals')
    .select('symbol, timeframe, direction, confidence, reasons, created_at')
    .order('confidence', { ascending: false })
    .limit(10)

  // Fetch live prices (a sample to provide context)
  const { data: prices } = await sb
    .from('live_prices')
    .select('symbol, price, updated_at')
    .order('symbol')

  // Fetch open positions count
  const { count: openCount } = await sb
    .from('open_positions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const priceSnap = (prices ?? [])
    .slice(0, 12)
    .map(p => `${p.symbol}: ${Number(p.price).toFixed(p.symbol.includes('JPY') ? 3 : 5)}`)
    .join(', ')

  const sigSnap = (signals ?? [])
    .slice(0, 5)
    .map(s => `${s.symbol} ${s.timeframe} ${s.direction} conf=${s.confidence}% reasons=${(s.reasons||[]).join('+')}`)
    .join('\n')

  const prompt = `You are a concise professional trading analyst sending a morning brief to swing traders.
Today is ${today}.

Current market prices: ${priceSnap || 'unavailable'}

Top signals right now:
${sigSnap || 'No active signals'}

Open managed positions: ${openCount ?? 0}

Write a 2–3 paragraph morning brief (plain prose, no markdown headers, max 250 words) that:
1. Comments on the key price action visible in the data
2. Highlights which signals deserve attention today and why
3. Notes any risk considerations given market context

Be direct and actionable. Do not add disclaimers. Do not repeat the raw numbers verbatim — synthesise them.`

  // Call Claude API
  let brief = ''
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const json = await resp.json()
    brief = json.content?.[0]?.text ?? ''
  } catch (err) {
    console.error('Claude API error:', err)
    return new Response('claude error', { status: 500 })
  }

  if (!brief) return new Response('empty brief', { status: 500 })

  // Get all users with Telegram configured
  const { data: users } = await sb
    .from('user_settings')
    .select('telegram_token, telegram_chat_id')
    .not('telegram_token', 'is', null)
    .not('telegram_chat_id', 'is', null)

  const msg = `*🌅 Sharpe Morning Brief — ${today}*\n\n${brief}`

  for (const u of users ?? []) {
    await sendTelegram(u.telegram_token, u.telegram_chat_id, msg)
  }

  return new Response(JSON.stringify({ sent: users?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
