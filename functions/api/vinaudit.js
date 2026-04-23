// Cloudflare Pages Function — VinAudit market value lookup by VIN.
// Holds VINAUDIT_KEY server-side. Returns the upstream JSON verbatim.
export async function onRequestGet({ request, env }) {
  if (!env.VINAUDIT_KEY) {
    return new Response(JSON.stringify({ error: 'VINAUDIT_KEY not configured' }), {
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
    `https://marketvalue.vinaudit.com/getmarketvalue.php?key=${env.VINAUDIT_KEY}&vin=${encodeURIComponent(vin)}&format=json`
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
