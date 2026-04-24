// VIN decoding pipeline.
//
// Priority:
//   1. Vincario via /api/vincario (paid, accurate trim/series) — if the server
//      has VINCARIO_KEY + VINCARIO_SECRET configured.
//   2. NHTSA vPIC (free, no key, CORS-enabled) — always available fallback.
//
// Both sources get normalized to the same shape so callers don't care which
// one answered. The `block` string is a compact, LLM-friendly summary that
// gets injected into the Claude prompt as authoritative ground truth.

const NHTSA_FIELDS = [
  ['Model Year', 'year'],
  ['Make', 'make'],
  ['Model', 'model'],
  ['Trim', 'trim'],
  ['Trim2', 'trim2'],
  ['Series', 'series'],
  ['Body Class', 'bodyClass'],
  ['Vehicle Type', 'vehicleType'],
  ['Drive Type', 'driveType'],
  ['Engine Configuration', 'engineConfig'],
  ['Engine Number of Cylinders', 'cylinders'],
  ['Displacement (L)', 'displacement'],
  ['Fuel Type - Primary', 'fuel'],
  ['Transmission Style', 'transmission'],
  ['Plant Country', 'plantCountry'],
  ['Manufacturer Name', 'manufacturer'],
];

function buildBlock(v, sourceLabel) {
  const lines = [];
  if (v.year || v.make || v.model) {
    lines.push(`${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim());
  }
  const trimParts = [v.trim, v.trim2, v.series].filter(Boolean);
  if (trimParts.length) lines.push(`Trim/Series: ${trimParts.join(' · ')}`);
  if (v.bodyClass) lines.push(`Body: ${v.bodyClass}`);
  const drive = [v.driveType, v.engineConfig].filter(Boolean).join(' · ');
  if (drive) lines.push(`Drivetrain: ${drive}`);
  const engine = [
    v.displacement && `${v.displacement}L`,
    v.cylinders && `${v.cylinders}-cyl`,
    v.enginePower && `${v.enginePower}hp`,
    v.fuel,
    v.transmission,
  ].filter(Boolean).join(' · ');
  if (engine) lines.push(`Engine: ${engine}`);
  if (v.plantCountry) lines.push(`Plant: ${v.plantCountry}`);
  if (!lines.length) return null;
  return `(source: ${sourceLabel})\n${lines.join('\n')}`;
}

async function decodeViaVincario(vin) {
  try {
    const res = await fetch(`/api/vincario?vin=${encodeURIComponent(vin)}`);
    if (!res.ok) return null; // 501 = not configured, 502 = upstream failed
    const data = await res.json();
    if (!data?.make && !data?.model) return null;
    data.block = buildBlock(data, 'Vincario');
    return data.block ? data : null;
  } catch {
    return null;
  }
}

async function decodeViaNhtsa(vin) {
  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`
    );
    if (!res.ok) return null;
    const { Results } = await res.json();
    if (!Array.isArray(Results)) return null;

    const lookup = {};
    for (const r of Results) lookup[r.Variable] = r.Value;

    const out = { source: 'nhtsa', vin };
    for (const [key, prop] of NHTSA_FIELDS) {
      const v = lookup[key];
      if (v && v !== 'Not Applicable' && v !== '0') out[prop] = v;
    }
    out.block = buildBlock(out, 'NHTSA vPIC');
    return out.block ? out : null;
  } catch {
    return null;
  }
}

/**
 * Decode a VIN. Returns a normalized object with a `block` string suitable for
 * LLM prompt injection, or null if both sources fail / VIN is invalid.
 */
export async function decodeVin(vin) {
  if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return null;
  const clean = vin.toUpperCase();
  return (await decodeViaVincario(clean)) || (await decodeViaNhtsa(clean));
}
