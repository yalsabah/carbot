// Server-side relay: fetch a freshly-generated GLB from Tripo3D's CDN and
// persist it to our R2 bucket so it lives forever (Tripo URLs are short-lived).
//
// Required Cloudflare Pages bindings/env vars:
//   - MODELS_BUCKET     : R2 bucket binding (configured in Pages → Settings → Functions → R2)
//   - MODELS_PUBLIC_BASE: public origin for the bucket, no trailing slash
//                         e.g. "https://models.vincritiq.com" if you bound a custom
//                         domain to the bucket, or the r2.dev URL for testing.
//
// Body: { slug: string, sourceUrl: string }
//   slug      — kebab-case identifier built client-side from year/make/model/trim/version
//               (e.g. "2022-toyota-camry-se-v1"). Strict pattern enforced server-side.
//   sourceUrl — the temporary Tripo3D GLB URL returned by the task poller.
//
// Returns: { glbUrl, key, bytes }
//
// We do NOT write to Firestore here — the client owns the models3d/{slug} doc
// (it has the user's auth context). This function is just the R2 writer.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.MODELS_BUCKET) {
    return json({ error: 'r2_not_configured', message: 'MODELS_BUCKET binding missing' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { slug, sourceUrl } = body || {};
  if (!slug || typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 120) {
    return json({ error: 'invalid_slug' }, 400);
  }
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return json({ error: 'invalid_source_url' }, 400);
  }

  // Sanity: only fetch from https URLs, and only allow Tripo3D's known asset
  // host(s) so this can't be turned into an SSRF that pulls arbitrary content.
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return json({ error: 'invalid_source_url' }, 400);
  }
  if (url.protocol !== 'https:') return json({ error: 'https_required' }, 400);
  const host = url.hostname.toLowerCase();
  const allowed = host.endsWith('.tripo3d.ai')
                || host.endsWith('.tripo3d.com')
                || host.endsWith('.tripocdn.com')
                || host.endsWith('.r2.cloudflarestorage.com')
                || host.endsWith('.amazonaws.com');
  if (!allowed) return json({ error: 'host_not_allowed', host }, 400);

  // Fetch the GLB
  let upstream;
  try {
    upstream = await fetch(sourceUrl);
  } catch (err) {
    return json({ error: 'fetch_failed', message: String(err?.message || err) }, 502);
  }
  if (!upstream.ok) {
    return json({ error: 'source_not_ok', status: upstream.status }, 502);
  }

  const key = `models/${slug}.glb`;

  try {
    await env.MODELS_BUCKET.put(key, upstream.body, {
      httpMetadata: {
        contentType: 'model/gltf-binary',
        // Slugs are versioned (e.g. -v1, -v2), so files are immutable per slug.
        // Long max-age + immutable lets browsers and CDNs cache aggressively.
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        sourceUrl: sourceUrl.slice(0, 256),
        uploadedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    return json({ error: 'r2_put_failed', message: String(err?.message || err) }, 500);
  }

  // Confirm the object exists and report its size
  let bytes = null;
  try {
    const head = await env.MODELS_BUCKET.head(key);
    bytes = head?.size ?? null;
  } catch {}

  const base = (env.MODELS_PUBLIC_BASE || '').replace(/\/+$/, '');
  const glbUrl = base ? `${base}/${key}` : null;

  return json({ glbUrl, key, bytes });
}

// Optional: a tiny GET to check whether a slug is already in R2 without touching Firestore.
// Useful for cold-start sanity checks; the canonical "is it ready" lookup is the
// Firestore models3d/{slug} doc, which the client reads directly.
export async function onRequestGet({ request, env }) {
  if (!env.MODELS_BUCKET) return json({ exists: false, reason: 'no_bucket' }, 200);
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug') || '';
  if (!SLUG_RE.test(slug)) return json({ exists: false, reason: 'invalid_slug' }, 400);
  const key = `models/${slug}.glb`;
  try {
    const head = await env.MODELS_BUCKET.head(key);
    if (!head) return json({ exists: false }, 200);
    const base = (env.MODELS_PUBLIC_BASE || '').replace(/\/+$/, '');
    return json({ exists: true, key, bytes: head.size, glbUrl: base ? `${base}/${key}` : null });
  } catch {
    return json({ exists: false }, 200);
  }
}
