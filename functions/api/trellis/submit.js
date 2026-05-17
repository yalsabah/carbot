// POST /api/trellis/submit
//
// Submits an image to NVIDIA's Microsoft TRELLIS image-to-3D NIM endpoint.
// Returns one of:
//   { mode: 'async', requestId }  — client should poll /api/trellis/status/{requestId}
//   { mode: 'sync', glbBase64 }   — NVIDIA returned the model inline; ready to persist
//
// NVIDIA NIM convention for long-running models (TRELLIS takes 30-90s):
//   - 200 OK: synchronous response, model is inline
//   - 202 Accepted: async; the response carries an `NVCF-REQID` header
//     that the client polls against `/v2/nvcf/pexec/status/{reqid}`
//
// We accept both shapes and let the client treat them uniformly.
//
// Required env: NVIDIA_TRELLIS_API_KEY (server-only secret).
//
// Request body (JSON):
//   { imageBase64: string, mediaType: string ('image/png' | 'image/jpeg') }
//   Optional: { seed?: number, noTexture?: boolean }

const TRELLIS_ENDPOINT = 'https://ai.api.nvidia.com/v1/genai/microsoft/trellis';
const NVCF_ASSETS_ENDPOINT = 'https://api.nvcf.nvidia.com/v2/nvcf/assets';

// Upload a binary image to NVCF's asset store and get back an assetId.
// Three-step NVIDIA pattern:
//   1. POST /v2/nvcf/assets with metadata → returns {assetId, uploadUrl}
//   2. PUT uploadUrl with the raw image bytes (presigned S3-style URL)
//   3. Reference the assetId in the inference request via
//      `image: data:<mediaType>;asset_id,<assetId>` AND the header
//      `NVCF-INPUT-ASSET-REFERENCES: <assetId>`.
//
// Returns the assetId on success, or throws with a useful error message.
async function uploadNvcfAsset({ apiKey, imageBytes, mediaType, description }) {
  // 1. Get a presigned upload URL
  const metaResp = await fetch(NVCF_ASSETS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      contentType: mediaType,
      description: description || 'VinCritiq vehicle image',
    }),
  });
  if (!metaResp.ok) {
    const body = await metaResp.text().catch(() => '');
    throw new Error(`nvcf_asset_meta_${metaResp.status}: ${body.slice(0, 200)}`);
  }
  const meta = await metaResp.json();
  if (!meta?.assetId || !meta?.uploadUrl) {
    throw new Error('nvcf_asset_meta_missing_fields');
  }

  // 2. PUT the raw bytes to the presigned URL.
  // The x-amz-meta-nvcf-asset-description header is required by NVCF's
  // S3-style endpoint — it echoes the description we sent in step 1.
  const putResp = await fetch(meta.uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mediaType,
      'x-amz-meta-nvcf-asset-description': description || 'VinCritiq vehicle image',
    },
    body: imageBytes,
  });
  if (!putResp.ok) {
    const body = await putResp.text().catch(() => '');
    throw new Error(`nvcf_asset_put_${putResp.status}: ${body.slice(0, 200)}`);
  }

  return meta.assetId;
}

// Decode a base64 string (with or without data: prefix) to Uint8Array.
// atob is available in Cloudflare Workers.
function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost({ request, env }) {
  const apiKey = env.NVIDIA_TRELLIS_API_KEY;
  if (!apiKey) {
    return json({ error: 'NVIDIA_TRELLIS_API_KEY not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { imageBase64, mediaType = 'image/png', seed = 0, noTexture = false } = body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return json({ error: 'imageBase64 is required' }, 400);
  }

  // Step 1+2: upload the image to NVCF's asset store. TRELLIS won't accept
  // inline base64 — only asset references — so this is mandatory.
  let assetId;
  try {
    const imageBytes = base64ToBytes(imageBase64);
    assetId = await uploadNvcfAsset({
      apiKey,
      imageBytes,
      mediaType,
      description: 'VinCritiq vehicle image for TRELLIS',
    });
  } catch (err) {
    return json({ error: 'nvcf_asset_upload_failed', message: String(err?.message || err) }, 502);
  }

  // Step 3: submit inference referencing the asset.
  let resp;
  try {
    resp = await fetch(TRELLIS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Tell NVIDIA which uploaded assets this request consumes. Required
        // when the body references asset_id values.
        'NVCF-INPUT-ASSET-REFERENCES': assetId,
      },
      body: JSON.stringify({
        mode: 'image',
        image: `data:${mediaType};asset_id,${assetId}`,
        output_format: 'glb',
        no_texture: noTexture,
        samples: 1,
        seed,
        // ss_cfg_scale / slat_cfg_scale / *_sampling_steps left as defaults —
        // NVIDIA's defaults are tuned for "good general quality."
      }),
    });
  } catch (err) {
    return json({ error: 'nvidia_fetch_failed', message: String(err?.message || err) }, 502);
  }

  // Async path: 202 Accepted + NVCF-REQID header. The body is usually empty
  // or just contains `{ status: 'pending' }`.
  if (resp.status === 202) {
    const requestId = resp.headers.get('NVCF-REQID') || resp.headers.get('nvcf-reqid');
    if (!requestId) {
      const txt = await resp.text().catch(() => '');
      return json(
        { error: 'no_request_id', message: 'TRELLIS returned 202 but no NVCF-REQID header', body: txt.slice(0, 200) },
        502,
      );
    }
    return json({ mode: 'async', requestId });
  }

  // Sync path: 200 OK with model inline. The actual response shape varies
  // by NIM; we try a few common keys and fall through to returning the
  // raw body for debugging if none match.
  if (resp.status === 200) {
    const data = await resp.json().catch(() => null);
    if (!data) {
      return json({ error: 'invalid_response', message: 'Could not parse TRELLIS 200 response as JSON' }, 502);
    }
    const glbBase64 = extractGlbBase64(data);
    if (!glbBase64) {
      return json({ error: 'no_glb_in_response', sample: shape(data) }, 502);
    }
    return json({ mode: 'sync', glbBase64 });
  }

  // Anything else is an error. Surface body so debugging is possible.
  const errBody = await resp.text().catch(() => '');
  return json(
    {
      error: 'trellis_error',
      status: resp.status,
      body: errBody.slice(0, 2000),
      // Surface the request shape we sent so the client console can
      // confirm what NVIDIA was given. Excludes the image bytes.
      sentShape: {
        endpoint: TRELLIS_ENDPOINT,
        assetIdRefHeader: assetId,
        bodyKeys: ['mode', 'image (asset_id ref)', 'output_format', 'no_texture', 'samples', 'seed'],
      },
    },
    resp.status >= 500 ? 502 : resp.status,
  );
}

// NVIDIA NIM responses vary in shape — try the common ones in order.
// Returns the base64-encoded GLB string, or null if not found.
export function extractGlbBase64(data) {
  if (!data) return null;
  // Shape 1: { artifacts: [{ base64 / b64 / data }] }
  if (Array.isArray(data.artifacts) && data.artifacts.length > 0) {
    const a = data.artifacts[0];
    return a.base64 || a.b64 || a.data || null;
  }
  // Shape 2: { assets: [...] } same as artifacts
  if (Array.isArray(data.assets) && data.assets.length > 0) {
    const a = data.assets[0];
    return a.base64 || a.b64 || a.data || null;
  }
  // Shape 3: { output: { glb_b64 / b64_json / data } }
  if (data.output && typeof data.output === 'object') {
    return data.output.glb_b64 || data.output.b64_json || data.output.data || null;
  }
  // Shape 4: top-level { glb_b64 / b64_json / data / model_b64 }
  return data.glb_b64 || data.b64_json || data.data || data.model_b64 || null;
}

// Quick shape probe for error responses — returns top-level key names so
// debug output isn't enormous.
function shape(o, depth = 0) {
  if (depth > 1 || !o || typeof o !== 'object') return typeof o;
  if (Array.isArray(o)) return `[${o.length}]${o[0] ? shape(o[0], depth + 1) : ''}`;
  const out = {};
  for (const k of Object.keys(o).slice(0, 10)) out[k] = shape(o[k], depth + 1);
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
