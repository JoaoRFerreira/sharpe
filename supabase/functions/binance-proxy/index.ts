const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

const BN_LIVE    = 'https://api.binance.com'
const BN_TESTNET = 'https://testnet.binance.vision'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  try {
    const { endpoint, params, apiKey, method = 'GET', testnet = false } = await req.json()
    if (!endpoint || !apiKey) throw new Error('endpoint and apiKey are required')

    const base = testnet ? BN_TESTNET : BN_LIVE
    const qs   = new URLSearchParams(params).toString()
    const url  = method === 'GET' ? `${base}${endpoint}?${qs}` : `${base}${endpoint}`

    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(method === 'POST' ? { body: qs } : {}),
    })

    const data = await res.json()
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
