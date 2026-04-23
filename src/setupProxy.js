// Local dev proxy — mirrors the Cloudflare Pages Functions in /functions/api/.
// The dev server injects the API keys server-side so the browser never sees them,
// matching production behavior. Reads keys from .env (no REACT_APP_ prefix preferred,
// but falls back to the legacy REACT_APP_*_API_KEY names so existing .env works).
const { createProxyMiddleware } = require('http-proxy-middleware');

const CLAUDE_KEY   = process.env.CLAUDE_API_KEY   || process.env.REACT_APP_CLAUDE_API_KEY;
const TRIPO_KEY    = process.env.TRIPO_KEY        || process.env.REACT_APP_TRIPO_API_KEY;
const VINAUDIT_KEY = process.env.VINAUDIT_KEY     || process.env.REACT_APP_VINAUDIT_API_KEY;

const stripBrowserHeaders = (proxyReq) => {
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
  proxyReq.removeHeader('sec-fetch-site');
  proxyReq.removeHeader('sec-fetch-mode');
  proxyReq.removeHeader('sec-fetch-dest');
  proxyReq.removeHeader('sec-fetch-user');
};

module.exports = function (app) {
  // Claude (Anthropic Messages) — server adds x-api-key & anthropic-version
  app.use(
    '/api/claude',
    createProxyMiddleware({
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      pathRewrite: { '^/api/claude': '/v1/messages' },
      onProxyReq: (proxyReq) => {
        stripBrowserHeaders(proxyReq);
        if (CLAUDE_KEY) proxyReq.setHeader('x-api-key', CLAUDE_KEY);
        proxyReq.setHeader('anthropic-version', '2023-06-01');
      },
    })
  );

  // Tripo3D — catch-all; server adds Authorization: Bearer
  app.use(
    '/api/tripo',
    createProxyMiddleware({
      target: 'https://api.tripo3d.ai',
      changeOrigin: true,
      pathRewrite: { '^/api/tripo': '/v2/openapi' },
      onProxyReq: (proxyReq) => {
        stripBrowserHeaders(proxyReq);
        if (TRIPO_KEY) proxyReq.setHeader('Authorization', `Bearer ${TRIPO_KEY}`);
      },
    })
  );

  // VinAudit — server injects key into query string
  app.use(
    '/api/vinaudit',
    createProxyMiddleware({
      target: 'https://marketvalue.vinaudit.com',
      changeOrigin: true,
      pathRewrite: (path) => {
        const url = new URL(path, 'http://x');
        const vin = url.searchParams.get('vin') || '';
        const key = VINAUDIT_KEY || '';
        return `/getmarketvalue.php?key=${encodeURIComponent(key)}&vin=${encodeURIComponent(vin)}&format=json`;
      },
      onProxyReq: stripBrowserHeaders,
    })
  );
};
