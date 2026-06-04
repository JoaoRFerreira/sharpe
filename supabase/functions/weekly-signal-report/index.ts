import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Environment ───────────────────────────────────────────────────────────────
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_KEY)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`Telegram error ${res.status}: ${body}`)
    }
  } catch (e) {
    console.error('sendTelegram threw:', e)
  }
}

function sign(n: number): string {
  return n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1)
}

function pct(wins: number, total: number): number {
  return total === 0 ? 0 : Math.round((wins / total) * 100)
}

/** Profit factor = gross winning pips / gross losing pips (absolute). */
function profitFactor(trades: { pnl_pips: number | null }[]): string {
  const grossWin  = trades.filter(t => (t.pnl_pips ?? 0) > 0).reduce((s, t) => s + (t.pnl_pips ?? 0), 0)
  const grossLoss = trades.filter(t => (t.pnl_pips ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl_pips ?? 0), 0)
  if (grossLoss === 0) return grossWin > 0 ? '∞' : '0.00'
  return (grossWin / grossLoss).toFixed(2)
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClosedTrade {
  symbol:      string
  direction:   string | null
  pnl_pips:    number | null
  close_reason: string | null
}

interface OpenedTrade {
  id: number
  symbol: string
}

interface Signal {
  symbol:     string
  timeframe:  string
  direction:  string | null
  confidence: number | null
  pattern:    string | null
  scanned_at: string
}

interface UserRow {
  user_id:          string
  telegram_token:   string
  telegram_chat_id: string
}

// ── Per-user weekly stats ─────────────────────────────────────────────────────

async function fetchUserStats(userId: string, since: string) {
  const [closedRes, openedRes, allTimeRes] = await Promise.all([
    // Trades closed this week
    sb
      .from('open_positions')
      .select('symbol, direction, pnl_pips, close_reason')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .gte('closed_at', since),

    // Trades opened this week (including those still open)
    sb
      .from('open_positions')
      .select('id, symbol')
      .eq('user_id', userId)
      .gte('opened_at', since),

    // All-time closed positions for aggregate stats
    sb
      .from('open_positions')
      .select('pnl_pips')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .not('pnl_pips', 'is', null),
  ])

  return {
    closed:  (closedRes.data  ?? []) as ClosedTrade[],
    opened:  (openedRes.data  ?? []) as OpenedTrade[],
    allTime: (allTimeRes.data ?? []) as { pnl_pips: number | null }[],
  }
}

// ── Top signals from the latest scan ─────────────────────────────────────────

async function fetchTopSignals(limit = 3): Promise<Signal[]> {
  // Grab the batch_id of the most recent scan first, so we always show
  // signals from the same coherent scan run.
  const { data: latestRow } = await sb
    .from('signals')
    .select('scanned_at')
    .not('direction', 'is', null)
    .gte('confidence', 65)
    .order('scanned_at', { ascending: false })
    .limit(1)

  if (!latestRow?.length) return []

  const latestTs = latestRow[0].scanned_at

  // Accept signals within 2 hours of the latest scan timestamp
  const scanCutoff = new Date(new Date(latestTs).getTime() - 2 * 60 * 60 * 1000).toISOString()

  const { data } = await sb
    .from('signals')
    .select('symbol, timeframe, direction, confidence, pattern, scanned_at')
    .not('direction', 'is', null)
    .gte('confidence', 65)
    .gte('scanned_at', scanCutoff)
    .order('confidence', { ascending: false })
    .limit(limit)

  return (data ?? []) as Signal[]
}

// ── Weekly signals aggregate (all users, public stats) ───────────────────────

async function fetchWeeklySignalBreakdown(since: string): Promise<{ total: number; byPattern: Record<string, number> }> {
  const { data } = await sb
    .from('signals')
    .select('pattern')
    .not('direction', 'is', null)
    .gte('scanned_at', since)
    .gte('confidence', 65)

  const rows = data ?? []
  const byPattern: Record<string, number> = {}
  for (const r of rows) {
    const key = (r.pattern as string | null) ?? 'Other'
    byPattern[key] = (byPattern[key] ?? 0) + 1
  }

  return { total: rows.length, byPattern }
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildWeekLabel(): string {
  const now = new Date()
  // Monday of the current ISO week
  const day      = now.getUTCDay() === 0 ? 7 : now.getUTCDay()  // treat Sun as 7
  const monday   = new Date(now)
  monday.setUTCDate(now.getUTCDate() - (day - 1))
  const sunday   = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)

  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${fmt(monday)} – ${fmt(sunday)}`
}

function buildMessage(params: {
  weekLabel:    string
  signalsTotal: number
  byPattern:    Record<string, number>
  openedCount:  number
  closedCount:  number
  closed:       ClosedTrade[]
  allTime:      { pnl_pips: number | null }[]
  topSignals:   Signal[]
}): string {
  const { weekLabel, signalsTotal, byPattern, openedCount, closedCount, closed, allTime, topSignals } = params

  // Weekly trade stats
  const weekWins   = closed.filter(t => (t.pnl_pips ?? 0) > 0).length
  const weekLosses = closed.filter(t => (t.pnl_pips ?? 0) < 0).length
  const netPips    = closed.reduce((s, t) => s + (t.pnl_pips ?? 0), 0)
  const weekWr     = pct(weekWins, closedCount)

  // Best trade this week
  let best: { symbol: string; pips: number } | null = null
  for (const t of closed) {
    if ((t.pnl_pips ?? -Infinity) > (best?.pips ?? -Infinity)) {
      best = { symbol: t.symbol, pips: t.pnl_pips! }
    }
  }

  // All-time stats
  const atTotal = allTime.length
  const atWins  = allTime.filter(t => (t.pnl_pips ?? 0) > 0).length
  const atWr    = pct(atWins, atTotal)
  const atPF    = profitFactor(allTime)

  // Pattern breakdown (top 3)
  const patternLines = Object.entries(byPattern)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, count]) => `  · ${name}: ${count}`)
    .join('\n')

  // Top signals section
  const tfLabel = (tf: string) =>
    tf === 'daily' ? 'Daily' : tf === 'weekly' ? 'Weekly' : tf.toUpperCase()

  const signalLines = topSignals.length
    ? topSignals
        .map(s => `  · ${s.symbol} ${tfLabel(s.timeframe)} ${s.direction} — ${s.pattern ?? '?'} (${s.confidence}%)`)
        .join('\n')
    : '  · No high-confidence signals at this time'

  // Compose message — using Telegram Markdown
  const lines: string[] = [
    `📊 *SHARPE WEEKLY — Week of ${weekLabel}*`,
    ``,
    `*Signals fired this week:* ${signalsTotal}${patternLines ? '\n' + patternLines : ''}`,
    ``,
    `*Paper trades this week:* ${openedCount} opened, ${closedCount} closed`,
  ]

  if (closedCount > 0) {
    lines.push(`*Net pips this week:* ${sign(netPips)}`)
    lines.push(`*Win rate this week:* ${weekWr}%  (${weekWins}W / ${weekLosses}L)`)
    if (best) {
      lines.push(`*Best trade:* ${best.symbol} ${sign(best.pips)} pips`)
    }
  } else {
    lines.push(`_No closed paper trades this week._`)
  }

  lines.push(``)
  lines.push(`*All-time:* win rate ${atWr}%, profit factor ${atPF}`)

  if (atTotal === 0) {
    lines.push(`_No all-time trade history yet — keep running signals!_`)
  }

  lines.push(``)
  lines.push(`💡 *Top setups to watch:*`)
  lines.push(signalLines)

  lines.push(``)
  lines.push(`_Powered by Sharpe_`)

  return lines.join('\n')
}

// ── Entry point ───────────────────────────────────────────────────────────────

Deno.serve(async (_req) => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const weekLabel = buildWeekLabel()

  // 1. Fetch all users with Telegram configured
  const { data: users, error: usersErr } = await sb
    .from('user_settings')
    .select('user_id, telegram_token, telegram_chat_id')
    .not('telegram_token',   'is', null)
    .not('telegram_chat_id', 'is', null)

  if (usersErr) {
    console.error('Failed to fetch users:', usersErr.message)
    return new Response(JSON.stringify({ ok: false, error: usersErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const userList = (users ?? []) as UserRow[]

  // 2. Fetch shared data that is the same for every user
  const [signalBreakdown, topSignals] = await Promise.all([
    fetchWeeklySignalBreakdown(since),
    fetchTopSignals(3),
  ])

  // 3. Send per-user personalised report
  let sent = 0
  for (const u of userList) {
    try {
      const { closed, opened, allTime } = await fetchUserStats(u.user_id, since)

      const msg = buildMessage({
        weekLabel,
        signalsTotal: signalBreakdown.total,
        byPattern:    signalBreakdown.byPattern,
        openedCount:  opened.length,
        closedCount:  closed.length,
        closed,
        allTime,
        topSignals,
      })

      await sendTelegram(u.telegram_token, u.telegram_chat_id, msg)
      sent++
    } catch (e) {
      console.error(`Error processing user ${u.user_id}:`, e)
    }
  }

  // 4. Optionally broadcast to the public channel (no per-user trade data)
  const { data: cfgRows } = await sb
    .from('site_config')
    .select('key, value')
    .in('key', ['tg_public_token', 'tg_public_channel_id'])

  const cfg: Record<string, string> = {}
  for (const r of (cfgRows ?? [])) cfg[r.key] = r.value

  const pubToken   = cfg['tg_public_token']      ?? ''
  const pubChannel = cfg['tg_public_channel_id'] ?? ''

  if (pubToken && pubChannel) {
    // Public message uses aggregate trade stats across all users
    const { data: allClosed } = await sb
      .from('open_positions')
      .select('symbol, direction, pnl_pips, close_reason')
      .eq('status', 'closed')
      .gte('closed_at', since)
      .not('pnl_pips', 'is', null)

    const { data: allOpened } = await sb
      .from('open_positions')
      .select('id, symbol')
      .gte('opened_at', since)

    const { data: allTimeAll } = await sb
      .from('open_positions')
      .select('pnl_pips')
      .eq('status', 'closed')
      .not('pnl_pips', 'is', null)

    const pubMsg = buildMessage({
      weekLabel,
      signalsTotal: signalBreakdown.total,
      byPattern:    signalBreakdown.byPattern,
      openedCount:  (allOpened ?? []).length,
      closedCount:  (allClosed ?? []).length,
      closed:       (allClosed ?? []) as ClosedTrade[],
      allTime:      (allTimeAll ?? []) as { pnl_pips: number | null }[],
      topSignals,
    })

    await sendTelegram(pubToken, pubChannel, pubMsg)
  }

  return new Response(
    JSON.stringify({ ok: true, sent, signals_this_week: signalBreakdown.total }),
    { headers: { 'Content-Type': 'application/json' } },
  )
})
