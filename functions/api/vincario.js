// Cloudflare Pages Function — Vincario (vindecoder.eu) VIN decode proxy.
// Holds VINCARIO_KEY + VINCARIO_SECRET server-side and computes the SHA1
// control sum required by the 3.2 API. Returns a normalized JSON payload
// the client can consume without knowing the raw Vincario schema.
//
// If keys aren't configured, returns 200 with { available: false } so the
// browser doesn't log a red error and the client falls back to NHTSA vPIC.
// NHTSA is the primary, always-free decoder; Vincario is an optional upgrade.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const vin = (url.searchParams.get('vin') || '').toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return json({ error: 'valid 17-char vin required' }, 400);
  }
  if (!env.VINCARIO_KEY || !env.VINCARIO_SECRET) {
    return json({ available: false, reason: 'vincario_not_configured' }, 200);
  }

  // 3.2 API: control-sum = first 10 hex chars of SHA1(vin + action + key + secret)
  const action = 'decode';
  const raw = vin + '|' + action + '|' + env.VINCARIO_KEY + '|' + env.VINCARIO_SECRET;
  const controlSum = await sha1Hex(raw).then(h => h.slice(0, 10));
  const upstream = `https://api.vindecoder.eu/3.2/${env.VINCARIO_KEY}/${controlSum}/${action}/${vin}.json`;

  const res = await fetch(upstream);
  if (!res.ok) return json({ error: 'vincario_upstream_failed', status: res.status }, 502);
  const data = await res.json();

  // Vincario returns { decode: [{ label, value }, ...], price, balance, ... }
  const decode = Array.isArray(data?.decode) ? data.decode : [];
  const byLabel = {};
  for (const d of decode) if (d?.label) byLabel[d.label] = d.value;

  const pick = (...keys) => {
    for (const k of keys) if (byLabel[k]) return byLabel[k];
    return null;
  };

  const normalized = {
    source: 'vincario',
    vin,
    year: pick('Model Year', 'Production Year'),
    make: pick('Make'),
    model: pick('Model'),
    trim: pick('Trim', 'Trim 2'),
    series: pick('Series', 'Series 2'),
    bodyClass: pick('Body', 'Body Type', 'Body Class'),
    doors: pick('Number of Doors', 'Doors'),
    driveType: pick('Drive', 'Drive Type'),
    transmission: pick('Transmission', 'Transmission Type'),
    cylinders: pick('Number of Cylinders', 'Cylinders'),
    displacement: pick('Engine Displacement (ccm)', 'Displacement (L)', 'Displacement'),
    fuel: pick('Fuel Type - Primary', 'Fuel Type'),
    enginePower: pick('Engine Power (HP)', 'Engine Power'),
    plantCountry: pick('Plant Country'),
    manufacturer: pick('Manufacturer'),
    raw: byLabel,
  };

  return json(normalized, 200);
}

async function sha1Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
