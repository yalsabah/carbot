// Cloudflare Pages Function — VinAudit Vehicle Images API proxy.
//
// Holds the VinAudit key server-side. Calls
// https://images.vinaudit.com/v3/images and returns the response shape
// the client expects.
//
// Cost note: VinAudit charges per API call. We rely on the SLUG-based 3D
// model cache (models3d/{slug}) to amortize: any one slug should hit
// VinAudit at most ONCE in its lifetime — after Tripo3D produces a GLB,
// that GLB is cached in R2 keyed by slug, and every future user of the
// same trim gets the GLB instantly without re-calling VinAudit.
//
// Accepted env var names: VINAUDIT_API_KEY (preferred) or VINAUDIT_KEY
// (legacy). First non-empty wins.
//
// Query params:
//   vin   — required, 17-char VIN
//   pose  — optional, default 'front_right' (front_left|front_right|front|back_left|back_right|back|right|left)
//   size  — optional, default 'medium' (small|medium|large|xlarge|full)
//   color — optional, default 'white' (white|black|gray|silver|blue|red|green|brown|beige|gold|orange|purple|yellow)
//
// Response (normalized):
//   {
//     images: [
//       { base64: "iVBORw0KGgo...", mediaType: "image/png", source: "vinaudit" }
//     ],
//     ymmt: { year, make, model, trim }   // best-effort
//   }

const UPSTREAM = 'https://images.vinaudit.com/v3/images';

export async function onRequestGet({ request, env }) {
  const KEY = env.VINAUDIT_API_KEY || env.VINAUDIT_KEY;
  if (!KEY) {
    return json({ error: 'VINAUDIT key not configured' }, 500);
  }

  const url = new URL(request.url);
  const vin = url.searchParams.get('vin');
  if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return json({ error: 'valid 17-char vin required' }, 400);
  }

  // Build upstream query. We default to front_right + medium because that's
  // a good Tripo3D / TRELLIS input (clearly shows front + one side,
  // ~1280x960 is enough resolution for image-to-3D without being wasteful).
  //
  // granularity defaults to 'model' so different trims of the same
  // year/make/model share a single image — VinAudit returns the same
  // photo for "2022 Audi S5 Premium" and "2022 Audi S5 Premium Plus"
  // when granularity=model. Callers can override to 'trim' for trim-
  // specific shots when needed (e.g. RS trims with unique fascias).
  const upstreamParams = new URLSearchParams({
    vin,
    key: KEY,
    format: 'json',
    pose: url.searchParams.get('pose') || 'front_right',
    size: url.searchParams.get('size') || 'medium',
    color: url.searchParams.get('color') || 'white',
    granularity: url.searchParams.get('granularity') || 'model',
  });

  let data;
  try {
    const r = await fetch(`${UPSTREAM}?${upstreamParams.toString()}`);
    data = await r.json().catch(() => ({}));
    if (!r.ok || data?.success === false) {
      return json(
        { error: data?.error || `VinAudit ${r.status}` },
        r.status >= 400 ? r.status : 502,
      );
    }
  } catch (err) {
    return json({ error: String(err?.message || err) }, 502);
  }

  // Normalize: VinAudit returns { images: [{ content_type, data }] } where
  // `data` is base64. We rename to { mediaType, base64 } and stamp the
  // source so the Tripo pipeline can route it correctly (cost tracking).
  const images = Array.isArray(data?.images)
    ? data.images
        .filter((i) => i?.data && i?.content_type)
        .map((i) => ({
          base64: i.data,
          mediaType: i.content_type,
          source: 'vinaudit',
        }))
    : [];

  return json({ images, ymmt: data?.ymmt || null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
