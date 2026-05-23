import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_KEY)

async function verifyStripeSignature(body: string, sig: string, secret: string): Promise<boolean> {
  try {
    const parts = Object.fromEntries(sig.split(',').map(p => p.split('=')))
    const ts = parts['t']
    const v1 = parts['v1']
    if (!ts || !v1) return false

    const payload = `${ts}.${body}`
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
    const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
    return hex === v1
  } catch { return false }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const body = await req.text()
  const sig  = req.headers.get('stripe-signature') ?? ''

  // Load webhook secret
  const { data: secretRow } = await sb.from('site_config').select('value').eq('key', 'stripe_webhook_secret').maybeSingle()
  const webhookSecret = secretRow?.value ?? ''

  if (webhookSecret) {
    const valid = await verifyStripeSignature(body, sig, webhookSecret)
    if (!valid) return new Response('Invalid signature', { status: 400 })
  }

  let event: Record<string, unknown>
  try { event = JSON.parse(body) } catch { return new Response('Invalid JSON', { status: 400 }) }

  const type = event.type as string
  const obj  = (event.data as Record<string, unknown>)?.object as Record<string, unknown>

  // ── Subscription activated (checkout completed) ─────────────
  if (type === 'checkout.session.completed') {
    const userId   = (obj.client_reference_id ?? (obj.metadata as Record<string,string>)?.user_id) as string
    const plan     = (obj.metadata as Record<string,string>)?.plan as string
    const billing  = (obj.metadata as Record<string,string>)?.billing as string
    const custId   = obj.customer as string

    if (!userId || !plan) return new Response('Missing user_id or plan', { status: 400 })

    const months   = billing === 'annual' ? 12 : 1
    const expires  = new Date(Date.now() + months * 31 * 24 * 3600 * 1000).toISOString()

    await sb.from('profiles').update({
      plan,
      plan_expires_at:    expires,
      stripe_customer_id: custId,
    }).eq('id', userId)
  }

  // ── Subscription renewed ─────────────────────────────────────
  if (type === 'invoice.payment_succeeded') {
    const custId = obj.customer as string
    const subObj = obj.subscription as string
    if (!custId || !subObj) return new Response('ok', { status: 200 })

    // Extend by 31 days from now (Stripe fires this monthly)
    const expires = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString()
    await sb.from('profiles').update({ plan_expires_at: expires }).eq('stripe_customer_id', custId)
  }

  // ── Subscription cancelled ────────────────────────────────────
  if (type === 'customer.subscription.deleted') {
    const custId = obj.customer as string
    await sb.from('profiles').update({ plan: 'free', plan_expires_at: null }).eq('stripe_customer_id', custId)
  }

  return new Response('ok', { status: 200 })
})
