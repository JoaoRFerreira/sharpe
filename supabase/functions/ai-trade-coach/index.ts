import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_KEY)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ── Stats helpers ──────────────────────────────────────────────
interface Position {
  symbol: string
  direction: string
  pattern: string | null
  entry_price: number | null
  stop_loss: number | null
  tp1: number | null
  pnl_pips: number | null
  close_reason: string | null
  opened_at: string | null
  closed_at: string | null
  timeframe: string | null
  confidence: number | null
}

interface ComputedStats {
  total: number
  wins: number
  losses: number
  winRate: number
  avgWinPips: number
  avgLossPips: number
  bestPattern: string
  worstPattern: string
  avgHoldHours: number
  maxWinStreak: number
  maxLossStreak: number
  currentStreak: { count: number; type: 'win' | 'loss' | 'none' }
  bySymbol: Record<string, { wins: number; losses: number }>
  recentTrend: string // last 10 trades win/loss sequence e.g. "WLWWWLLWWL"
}

function computeStats(positions: Position[]): ComputedStats {
  const wins = positions.filter(p => (p.pnl_pips ?? 0) > 0)
  const losses = positions.filter(p => (p.pnl_pips ?? 0) <= 0)

  const avgWinPips = wins.length
    ? wins.reduce((s, p) => s + (p.pnl_pips ?? 0), 0) / wins.length
    : 0

  const avgLossPips = losses.length
    ? Math.abs(losses.reduce((s, p) => s + (p.pnl_pips ?? 0), 0) / losses.length)
    : 0

  // Pattern performance
  const patternMap: Record<string, { wins: number; total: number; pnl: number }> = {}
  for (const p of positions) {
    const pat = p.pattern ?? 'Unknown'
    if (!patternMap[pat]) patternMap[pat] = { wins: 0, total: 0, pnl: 0 }
    patternMap[pat].total++
    patternMap[pat].pnl += p.pnl_pips ?? 0
    if ((p.pnl_pips ?? 0) > 0) patternMap[pat].wins++
  }

  let bestPattern = 'N/A'
  let worstPattern = 'N/A'
  let bestPnl = -Infinity
  let worstPnl = Infinity
  for (const [pat, d] of Object.entries(patternMap)) {
    if (d.total < 2) continue
    if (d.pnl > bestPnl) { bestPnl = d.pnl; bestPattern = pat }
    if (d.pnl < worstPnl) { worstPnl = d.pnl; worstPattern = pat }
  }

  // Average hold time in hours
  const holdTimes = positions
    .filter(p => p.opened_at && p.closed_at)
    .map(p => (new Date(p.closed_at!).getTime() - new Date(p.opened_at!).getTime()) / 3_600_000)
  const avgHoldHours = holdTimes.length
    ? holdTimes.reduce((s, h) => s + h, 0) / holdTimes.length
    : 0

  // Streaks (positions assumed sorted newest first — we reverse for chronological)
  const chron = [...positions].reverse()
  let maxWinStreak = 0, maxLossStreak = 0
  let curW = 0, curL = 0
  for (const p of chron) {
    if ((p.pnl_pips ?? 0) > 0) {
      curW++; curL = 0
      if (curW > maxWinStreak) maxWinStreak = curW
    } else {
      curL++; curW = 0
      if (curL > maxLossStreak) maxLossStreak = curL
    }
  }

  // Current streak (most recent trades)
  let currentStreak: ComputedStats['currentStreak'] = { count: 0, type: 'none' }
  if (positions.length > 0) {
    const firstIsWin = (positions[0].pnl_pips ?? 0) > 0
    let count = 0
    for (const p of positions) {
      const isWin = (p.pnl_pips ?? 0) > 0
      if (isWin === firstIsWin) count++
      else break
    }
    currentStreak = { count, type: firstIsWin ? 'win' : 'loss' }
  }

  // By symbol
  const bySymbol: Record<string, { wins: number; losses: number }> = {}
  for (const p of positions) {
    if (!bySymbol[p.symbol]) bySymbol[p.symbol] = { wins: 0, losses: 0 }
    if ((p.pnl_pips ?? 0) > 0) bySymbol[p.symbol].wins++
    else bySymbol[p.symbol].losses++
  }

  // Recent trend (last 10, newest first → show as oldest→newest)
  const recentTrend = [...positions]
    .slice(0, 10)
    .reverse()
    .map(p => ((p.pnl_pips ?? 0) > 0 ? 'W' : 'L'))
    .join('')

  return {
    total: positions.length,
    wins: wins.length,
    losses: losses.length,
    winRate: positions.length ? (wins.length / positions.length) * 100 : 0,
    avgWinPips,
    avgLossPips,
    bestPattern,
    worstPattern,
    avgHoldHours,
    maxWinStreak,
    maxLossStreak,
    currentStreak,
    bySymbol,
    recentTrend,
  }
}

// ── Main handler ───────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let body: { user_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { user_id } = body
  if (!user_id) return json({ error: 'user_id is required' }, 400)

  // ── Fetch last 50 closed positions ──────────────────────────
  const { data: positions, error: posErr } = await sb
    .from('open_positions')
    .select('symbol,direction,pattern,entry_price,stop_loss,tp1,pnl_pips,close_reason,opened_at,closed_at,timeframe,confidence')
    .eq('user_id', user_id)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(50)

  if (posErr) {
    console.error('DB fetch error:', posErr)
    return json({ error: 'Failed to fetch trade history' }, 500)
  }

  if (!positions || positions.length < 10) {
    return json({ error: 'Need at least 10 closed trades' }, 200)
  }

  // ── Compute stats ────────────────────────────────────────────
  const s = computeStats(positions as Position[])

  // ── Fetch Anthropic key from environment secret ──────────────
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!anthropicKey) {
    console.error('ANTHROPIC_API_KEY secret not set')
    return json({ error: 'AI coaching unavailable — API key not configured' }, 503)
  }

  // ── Build prompt ─────────────────────────────────────────────
  const topSymbols = Object.entries(s.bySymbol)
    .sort((a, b) => (b[1].wins + b[1].losses) - (a[1].wins + a[1].losses))
    .slice(0, 5)
    .map(([sym, d]) => `${sym} (${d.wins}W/${d.losses}L)`)
    .join(', ')

  const holdLabel = s.avgHoldHours < 1
    ? `${Math.round(s.avgHoldHours * 60)} minutes`
    : s.avgHoldHours < 24
    ? `${s.avgHoldHours.toFixed(1)} hours`
    : `${(s.avgHoldHours / 24).toFixed(1)} days`

  const prompt = `You are an elite trading performance coach analysing a trader's actual closed trade data. Your job is to identify specific, data-driven behavioural patterns — not generic advice.

TRADER STATISTICS (last ${s.total} closed trades):
- Win rate: ${s.winRate.toFixed(1)}% (${s.wins} wins, ${s.losses} losses)
- Average winning trade: +${s.avgWinPips.toFixed(1)} pips
- Average losing trade: -${s.avgLossPips.toFixed(1)} pips
- Win/Loss ratio: ${s.avgLossPips > 0 ? (s.avgWinPips / s.avgLossPips).toFixed(2) : 'N/A'}
- Best performing pattern: ${s.bestPattern}
- Worst performing pattern: ${s.worstPattern}
- Average hold time: ${holdLabel}
- Max win streak: ${s.maxWinStreak} | Max loss streak: ${s.maxLossStreak}
- Current streak: ${s.currentStreak.count} consecutive ${s.currentStreak.type}s
- Most traded instruments: ${topSymbols || 'various'}
- Recent sequence (oldest→newest): ${s.recentTrend || 'N/A'}

Respond ONLY with the following structure (no preamble, no sign-off):

**PATTERNS OBSERVED**
1. [Specific behavioural pattern grounded in their actual numbers — reference the exact stats]
2. [Second specific pattern — be direct and precise, not generic]
3. [Third pattern — can be positive or negative, must be data-backed]

**THIS WEEK'S FOCUS**
[One single, concrete, measurable action they should take this week. Be specific about what to change and how to know it's working.]

**YOUR EDGE**
[One genuine strength visible in the data that they should protect and build on. Name it precisely.]

Keep each section concise (2–4 sentences max). Do not add disclaimers. Do not use vague language like "consider" or "might". Be direct.`

  // ── Call Claude API ──────────────────────────────────────────
  let analysis = ''
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
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const respJson = await resp.json()
    if (!resp.ok) {
      console.error('Claude API error:', JSON.stringify(respJson))
      return json({ error: 'AI analysis failed — please try again later' }, 500)
    }
    analysis = respJson.content?.[0]?.text ?? ''
  } catch (err) {
    console.error('Fetch error calling Claude:', err)
    return json({ error: 'AI analysis failed — please try again later' }, 500)
  }

  if (!analysis) {
    return json({ error: 'AI returned empty response — please try again' }, 500)
  }

  const computed_at = new Date().toISOString()

  // ── Cache in coach_cache (upsert by user_id) ─────────────────
  const { error: upsertErr } = await sb
    .from('coach_cache')
    .upsert(
      { user_id, analysis, computed_at },
      { onConflict: 'user_id' }
    )

  if (upsertErr) {
    // Non-fatal — log but still return the result
    console.error('coach_cache upsert failed:', upsertErr)
  }

  return json({ analysis, computed_at })
})
