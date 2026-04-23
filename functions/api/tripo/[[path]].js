// Cloudflare Pages Function — catch-all Tripo3D proxy.
// Maps /api/tripo/<rest> → https://api.tripo3d.ai/v2/openapi/<rest>.
// Holds TRIPO_KEY server-side; client never sees the bearer token.
export async function onRequest({ request, env, params }) {
  if (!env.TRIPO_KEY) {
    return new Response(JSON.stringify({ error: 'TRIPO_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const subPath = (params.path || []).join('/');
  const upstreamUrl = `https://api.tripo3d.ai/v2/openapi/${subPath}`;

  const headers = { Authorization: `Bearer ${env.TRIPO_KEY}` };
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const upstream = await fetch(upstreamUrl, init);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
  });
}
