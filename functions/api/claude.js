// Cloudflare Pages Function — proxies Anthropic Messages API.
// Holds CLAUDE_API_KEY server-side so it's never shipped to the browser.
// Streams responses through unchanged so client-side SSE parsing continues to work.
export async function onRequestPost({ request, env }) {
  if (!env.CLAUDE_API_KEY) {
    return new Response(JSON.stringify({ error: { message: 'CLAUDE_API_KEY not configured' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: request.body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
