// Cloudflare Pages Function — VinAudit market value lookup by VIN.
// Holds the VinAudit key server-side. Returns the upstream JSON verbatim.
//
// Accepts the key under either VINAUDIT_KEY (legacy) or VINAUDIT_API_KEY
// (matches what's in the dashboard now). First non-empty wins so existing
// deployments keep working.
export async function onRequestGet({ request, env }) {
  const KEY = env.VINAUDIT_API_KEY || env.VINAUDIT_KEY;
  if (!KEY) {
    return new Response(JSON.stringify({ error: 'VINAUDIT key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const vin = url.searchParams.get('vin');
  if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return new Response(JSON.stringify({ error: 'valid 17-char vin required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(
    `https://marketvalue.vinaudit.com/getmarketvalue.php?key=${encodeURIComponent(KEY)}&vin=${encodeURIComponent(vin)}&format=json`
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
