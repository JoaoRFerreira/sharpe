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
  // Get all users who have Telegram configured
  const { data: users } = await sb
    .from('user_settings')
    .select('user_id, telegram_token, telegram_chat_id')
    .not('telegram_token', 'is', null)
    .not('telegram_chat_id', 'is', null)

  if (!users?.length) return new Response('no users', { status: 200 })

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()

  for (const u of users) {
    const { data: closed } = await sb
      .from('open_positions')
      .select('symbol, direction, entry_price, close_price, pnl_pips, closed_at')
      .eq('user_id', u.user_id)
      .eq('status', 'closed')
      .gte('closed_at', since)

    const { data: open } = await sb
      .from('open_positions')
      .select('symbol')
      .eq('user_id', u.user_id)
      .eq('status', 'open')

    const trades = closed ?? []
    const total  = trades.length
    const wins   = trades.filter(t => (t.pnl_pips ?? 0) > 0).length
    const losses = trades.filter(t => (t.pnl_pips ?? 0) < 0).length
    const netPips = trades.reduce((s, t) => s + (t.pnl_pips ?? 0), 0)
    const winRate = total ? Math.round(wins / total * 100) : 0

    let best = { symbol: '—', pips: -Infinity }
    let worst = { symbol: '—', pips: Infinity }
    for (const t of trades) {
      if ((t.pnl_pips ?? 0) > best.pips)  best  = { symbol: t.symbol, pips: t.pnl_pips }
      if ((t.pnl_pips ?? 0) < worst.pips) worst = { symbol: t.symbol, pips: t.pnl_pips }
    }

    const openCount = open?.length ?? 0
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

    const msg = [
      `*📊 Sharpe Weekly Digest — ${date}*`,
      '',
      `*Closed trades (7d):* ${total}   ✅ ${wins}W / ❌ ${losses}L`,
      `*Win rate:* ${winRate}%`,
      `*Net pips:* ${netPips > 0 ? '+' : ''}${netPips.toFixed(1)}`,
      total ? `*Best trade:* ${best.symbol} (${best.pips > 0 ? '+' : ''}${best.pips?.toFixed(1)} pips)` : null,
      total ? `*Worst trade:* ${worst.symbol} (${worst.pips > 0 ? '+' : ''}${worst.pips?.toFixed(1)} pips)` : null,
      '',
      `*Open positions:* ${openCount}`,
      '',
      total === 0 ? '_No closed trades this week — keep watching the signals!_' : '_Good trading — see you next week!_',
    ].filter(Boolean).join('\n')

    await sendTelegram(u.telegram_token, u.telegram_chat_id, msg)
  }

  return new Response(JSON.stringify({ sent: users.length }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
