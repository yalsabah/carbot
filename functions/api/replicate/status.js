// GET /api/replicate/status?predictionId=...&slug=...
//
// Polls a Replicate prediction. When succeeded, fetches the resulting
// GLB from Replicate's CDN and uploads it directly to our R2 bucket at
// `models/{slug}.glb`, returning a permanent public URL for the client
// to persist to Firestore.
//
// Replicate's prediction lifecycle:
//   status: 'starting'   → still spinning up the model
//   status: 'processing' → running the inference
//   status: 'succeeded'  → done; `output` is an array of file URLs
//   status: 'failed'     → terminal; `error` has the reason
//   status: 'canceled'   → terminal
//
// The firtoz/trellis output is a list of URLs — first one is the GLB,
// remaining are preview renders. We grab the .glb url, fetch it,
// and store the bytes in R2.
//
// Required env:
//   REPLICATE_API_TOKEN
//   MODELS_BUCKET       (R2 binding)
//   MODELS_PUBLIC_BASE  (public origin for the bucket)

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function onRequestGet({ request, env }) {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) return json({ error: 'REPLICATE_API_TOKEN not configured' }, 500);
  if (!env.MODELS_BUCKET) return json({ error: 'MODELS_BUCKET binding missing' }, 500);

  const url = new URL(request.url);
  const predictionId = url.searchParams.get('predictionId');
  const slug = url.searchParams.get('slug');
  if (!predictionId) return json({ error: 'predictionId required' }, 400);
  if (!slug || !SLUG_RE.test(slug) || slug.length > 120) {
    return json({ error: 'invalid_slug' }, 400);
  }

  let resp;
  try {
    resp = await fetch(`https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });
  } catch (err) {
    // Network blip — keep client polling.
    return json({ status: 'pending', _transient: true, error: String(err?.message || err) });
  }

  if (resp.status === 404) {
    return json({ status: 'failed', reason: 'prediction_not_found' });
  }
  if (resp.status >= 500) {
    return json({ status: 'pending', _transient: true, _serverStatus: resp.status });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return json({ status: 'failed', reason: `replicate_${resp.status}`, body: body.slice(0, 300) });
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    return json({ status: 'failed', reason: 'invalid_payload' });
  }

  // Still running — tell client to keep polling. Replicate reports
  // progress in `logs` (free-form text); we don't parse it but could
  // estimate from elapsed time if needed.
  if (data.status === 'starting' || data.status === 'processing') {
    return json({
      status: 'pending',
      replicateStatus: data.status,
    });
  }
  if (data.status === 'failed' || data.status === 'canceled') {
    return json({
      status: 'failed',
      reason: data.error || `replicate_${data.status}`,
    });
  }
  if (data.status !== 'succeeded') {
    // Unknown status — treat as still pending so we don't lose the run.
    return json({ status: 'pending', replicateStatus: data.status });
  }

  // Succeeded. Output is firtoz/trellis-specific:
  //   - Either a single URL string pointing to the .glb
  //   - Or an array of URLs where the .glb is one of them
  //   - Or an object with named outputs like { model_file: "...", color_video: "...", ... }
  // Find the .glb URL in any of these shapes.
  const glbUrl = findGlbUrl(data.output);
  if (!glbUrl) {
    return json({
      status: 'failed',
      reason: 'no_glb_in_output',
      outputSample: typeof data.output === 'string' ? data.output.slice(0, 200) : Object.keys(data.output || {}),
    });
  }

  // Fetch the GLB bytes from Replicate's CDN and stream to R2.
  let upstream;
  try {
    upstream = await fetch(glbUrl);
  } catch (err) {
    return json({ status: 'failed', reason: 'glb_fetch_failed', message: String(err?.message || err) });
  }
  if (!upstream.ok) {
    return json({ status: 'failed', reason: `glb_source_${upstream.status}` });
  }

  const key = `models/${slug}.glb`;
  try {
    await env.MODELS_BUCKET.put(key, upstream.body, {
      httpMetadata: {
        contentType: 'model/gltf-binary',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        source: 'replicate-trellis',
        predictionId: predictionId.slice(0, 60),
        sourceUrl: glbUrl.slice(0, 256),
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return json({ status: 'failed', reason: 'r2_put_failed', message: String(err?.message || err) });
  }

  // Confirm + size for telemetry
  let bytes = null;
  try {
    const head = await env.MODELS_BUCKET.head(key);
    bytes = head?.size ?? null;
  } catch {}

  const base = (env.MODELS_PUBLIC_BASE || '').replace(/\/+$/, '');
  const r2Url = base ? `${base}/${key}` : null;

  return json({
    status: 'ready',
    glbUrl: r2Url,
    key,
    bytes,
    source: 'replicate-trellis',
  });
}

// Replicate model output can be:
//   - string: a single URL → return as-is if .glb
//   - string[]: array of URLs → find the one ending in .glb
//   - { model_file: "...", ...named keys } → look for known names
function findGlbUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') {
    return /\.glb(\?|$)/i.test(output) ? output : null;
  }
  if (Array.isArray(output)) {
    return output.find((u) => typeof u === 'string' && /\.glb(\?|$)/i.test(u)) || null;
  }
  if (typeof output === 'object') {
    // firtoz/trellis specifically uses `model_file` for the GLB
    const candidates = [
      output.model_file,
      output.glb,
      output.glb_url,
      output.mesh,
      output.output_glb,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    // Last resort: scan all values for any .glb URL
    for (const v of Object.values(output)) {
      if (typeof v === 'string' && /\.glb(\?|$)/i.test(v)) return v;
    }
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
