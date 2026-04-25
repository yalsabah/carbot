// Local dev proxy — mirrors the Cloudflare Pages Functions in /functions/api/.
// The dev server injects the API keys server-side so the browser never sees them,
// matching production behavior. Reads keys from .env (no REACT_APP_ prefix preferred,
// but falls back to the legacy REACT_APP_*_API_KEY names so existing .env works).
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');

const CLAUDE_KEY      = process.env.CLAUDE_API_KEY   || process.env.REACT_APP_CLAUDE_API_KEY;
const TRIPO_KEY       = process.env.TRIPO_KEY        || process.env.REACT_APP_TRIPO_API_KEY;
const VINAUDIT_KEY    = process.env.VINAUDIT_KEY     || process.env.REACT_APP_VINAUDIT_API_KEY;
const VINCARIO_KEY    = process.env.VINCARIO_KEY;
const VINCARIO_SECRET = process.env.VINCARIO_SECRET;

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

  // Vincario — mirrors functions/api/vincario.js. Computes SHA1 control sum,
  // fetches vindecoder.eu, normalizes to the same JSON shape the client expects.
  app.get('/api/vincario', async (req, res) => {
    const vin = String(req.query.vin || '').toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      return res.status(400).json({ error: 'valid 17-char vin required' });
    }
    if (!VINCARIO_KEY || !VINCARIO_SECRET) {
      return res.status(501).json({ error: 'vincario_not_configured' });
    }
    try {
      const action = 'decode';
      const raw = `${vin}|${action}|${VINCARIO_KEY}|${VINCARIO_SECRET}`;
      const controlSum = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
      const upstream = `https://api.vindecoder.eu/3.2/${VINCARIO_KEY}/${controlSum}/${action}/${vin}.json`;
      const r = await fetch(upstream);
      if (!r.ok) return res.status(502).json({ error: 'vincario_upstream_failed', status: r.status });
      const data = await r.json();
      const decode = Array.isArray(data?.decode) ? data.decode : [];
      const byLabel = {};
      for (const d of decode) if (d?.label) byLabel[d.label] = d.value;
      const pick = (...keys) => { for (const k of keys) if (byLabel[k]) return byLabel[k]; return null; };
      res.json({
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
      });
    } catch (err) {
      res.status(500).json({ error: 'vincario_dev_proxy_failed', message: String(err?.message || err) });
    }
  });

  // Models (R2 GLB asset library) — mirrors functions/api/models/upload.js.
  // In dev there's no R2 binding, so we don't actually persist the GLB; we just
  // tell the orchestrator that no public URL was produced. It then falls back to
  // using the original Tripo3D URL for the current session (no caching benefit
  // in dev, but the modal still renders the model end-to-end).
  app.post('/api/models/upload', async (req, res) => {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return res.status(400).json({ error: 'invalid_json' });
      }
    }
    const { slug, sourceUrl } = body || {};
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
      return res.status(400).json({ error: 'invalid_slug' });
    }
    if (!sourceUrl || typeof sourceUrl !== 'string') {
      return res.status(400).json({ error: 'invalid_source_url' });
    }
    return res.json({ glbUrl: null, key: `models/${slug}.glb`, bytes: null, dev: true });
  });

  app.get('/api/models/upload', (_req, res) => {
    res.json({ exists: false, reason: 'dev_no_bucket' });
  });

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
