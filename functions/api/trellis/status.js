// GET /api/trellis/status?requestId=...&slug=...
//
// Polls NVIDIA's NVCF status endpoint for a previously-submitted TRELLIS
// job. When the job completes, decodes the base64 GLB and uploads it
// directly to our R2 bucket at `models/{slug}.glb`, returning a permanent
// public URL that the client can persist to Firestore.
//
// Possible response shapes:
//   { status: 'pending' }                            — keep polling
//   { status: 'ready', glbUrl, key, bytes }          — GLB persisted to R2
//   { status: 'failed', reason }                     — terminal error
//
// Why we upload to R2 here instead of returning the base64 to the client:
//   - The GLB is large (~15MB). Round-tripping base64 through the client
//     is wasteful.
//   - The existing /api/models/upload endpoint only accepts a source URL
//     (it FETCHES the GLB from somewhere). NVIDIA's response is inline
//     base64, so we'd need a temp store anyway. May as well write to the
//     final R2 location directly.
//
// Required env:
//   NVIDIA_TRELLIS_API_KEY  (bearer for the poll)
//   MODELS_BUCKET           (R2 binding)
//   MODELS_PUBLIC_BASE      (public origin for the bucket)

import { extractGlbBase64 } from './submit.js';

const NVCF_STATUS_BASE = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function onRequestGet({ request, env }) {
  const apiKey = env.NVIDIA_TRELLIS_API_KEY;
  if (!apiKey) return json({ error: 'NVIDIA_TRELLIS_API_KEY not configured' }, 500);
  if (!env.MODELS_BUCKET) return json({ error: 'MODELS_BUCKET binding missing' }, 500);

  const url = new URL(request.url);
  const requestId = url.searchParams.get('requestId');
  const slug = url.searchParams.get('slug');
  if (!requestId) return json({ error: 'requestId required' }, 400);
  if (!slug || !SLUG_RE.test(slug) || slug.length > 120) {
    return json({ error: 'invalid_slug' }, 400);
  }

  // Poll NVIDIA
  let resp;
  try {
    resp = await fetch(`${NVCF_STATUS_BASE}/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
  } catch (err) {
    return json({ status: 'pending', _transient: true, error: String(err?.message || err) });
  }

  // 202 still pending — return pending so client keeps polling.
  if (resp.status === 202) {
    return json({ status: 'pending' });
  }
  // 404 means the request ID is unknown or expired — terminal failure.
  if (resp.status === 404) {
    return json({ status: 'failed', reason: 'request_not_found' });
  }
  if (resp.status >= 500) {
    return json({ status: 'pending', _transient: true, _serverStatus: resp.status });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    return json({ status: 'failed', reason: `nvidia_${resp.status}`, body: body.slice(0, 300) });
  }

  // 200 — completed. Parse out the GLB.
  const data = await resp.json().catch(() => null);
  if (!data) {
    return json({ status: 'failed', reason: 'invalid_completion_payload' });
  }
  const glbBase64 = extractGlbBase64(data);
  if (!glbBase64) {
    return json({ status: 'failed', reason: 'no_glb_in_response', sample: Object.keys(data || {}) });
  }

  // Decode and upload to R2 at the final slug location.
  let bytes;
  try {
    bytes = base64ToBytes(glbBase64);
  } catch (err) {
    return json({ status: 'failed', reason: 'base64_decode_failed', message: String(err?.message || err) });
  }
  const key = `models/${slug}.glb`;
  try {
    await env.MODELS_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: 'model/gltf-binary',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        source: 'trellis',
        nvcfRequestId: requestId.slice(0, 60),
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return json({ status: 'failed', reason: 'r2_put_failed', message: String(err?.message || err) });
  }

  const base = (env.MODELS_PUBLIC_BASE || '').replace(/\/+$/, '');
  const glbUrl = base ? `${base}/${key}` : null;

  return json({
    status: 'ready',
    glbUrl,
    key,
    bytes: bytes.byteLength,
    source: 'trellis',
  });
}

// Decode a base64 string (with or without data: prefix) to Uint8Array.
// Workers' atob handles the actual decode; we just normalize whitespace
// and strip the prefix if present.
function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
