import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const APP_URL = 'https://joaorferreira.github.io/sharpe'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS })

  // Authenticate the caller
  const authHeader = req.headers.get('Authorization') ?? ''
  const sb = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data: { user }, error: authErr } = await sb.auth.getUser(authHeader.replace('Bearer ', ''))
  if (authErr || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS })

  const { plan, billing } = await req.json() as { plan: 'essential'|'pro'; billing: 'monthly'|'annual' }
  if (!['essential','pro'].includes(plan)) return new Response(JSON.stringify({ error: 'Invalid plan' }), { status: 400, headers: CORS })

  // Load Stripe keys and price IDs from site_config
  const { data: cfgRows } = await sb.from('site_config').select('key,value')
    .in('key', ['stripe_sk','stripe_price_essential_monthly','stripe_price_essential_annual','stripe_price_pro_monthly','stripe_price_pro_annual'])
  const cfg: Record<string,string> = Object.fromEntries((cfgRows ?? []).map(r => [r.key, r.value]))

  const sk = cfg['stripe_sk']
  if (!sk) return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers: CORS })

  const priceId = cfg[`stripe_price_${plan}_${billing === 'annual' ? 'annual' : 'monthly'}`]
  if (!priceId) return new Response(JSON.stringify({ error: 'Price ID not configured for this plan/billing combination' }), { status: 500, headers: CORS })

  // Build checkout session
  const params = new URLSearchParams({
    mode:                   'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    client_reference_id:    user.id,
    customer_email:         user.email ?? '',
    'metadata[user_id]':    user.id,
    'metadata[plan]':       plan,
    'metadata[billing]':    billing,
    success_url:            `${APP_URL}/app.html?upgraded=1`,
    cancel_url:             `${APP_URL}/app.html`,
    'subscription_data[metadata][user_id]': user.id,
    'subscription_data[metadata][plan]':    plan,
  })

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sk}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const session = await r.json()
  if (session.error) {
    return new Response(JSON.stringify({ error: session.error.message }), { status: 400, headers: CORS })
  }

  return new Response(JSON.stringify({ url: session.url }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
