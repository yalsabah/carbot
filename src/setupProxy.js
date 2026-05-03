// Local dev proxy — mirrors the Cloudflare Pages Functions in /functions/api/.
// The dev server injects the API keys server-side so the browser never sees them,
// matching production behavior. Reads keys from .env (no REACT_APP_ prefix preferred,
// but falls back to the legacy REACT_APP_*_API_KEY names so existing .env works).
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const { Readable } = require('node:stream');

// Accept multiple env-var spellings so production (Cloudflare Pages bindings)
// and local .env can use whichever convention. The first non-empty wins.
const pickEnv = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== '') return v.trim();
  }
  return undefined;
};
const CLAUDE_KEY      = pickEnv('CLAUDE_API_KEY', 'CLAUDE_KEY', 'REACT_APP_CLAUDE_API_KEY');
const TRIPO_KEY       = pickEnv('TRIPO_KEY', 'TRIPO_API_KEY', 'REACT_APP_TRIPO_API_KEY');
const VINAUDIT_KEY    = pickEnv('VINAUDIT_KEY', 'VINAUDIT_API_KEY', 'REACT_APP_VINAUDIT_API_KEY');
const VINCARIO_KEY    = pickEnv('VINCARIO_KEY');
const VINCARIO_SECRET = pickEnv('VINCARIO_SECRET');

// Startup banner — confirms which keys actually loaded into this process.
// Prints first/last 4 chars + length so you can eyeball it without leaking
// the secret. If a key shows "MISSING", the dev server didn't see it in
// .env at start time; restart `npm start` after editing .env.
const fingerprint = (k) => {
  if (!k) return 'MISSING';
  const s = String(k).trim();
  return `${s.slice(0, 4)}…${s.slice(-4)} (len ${s.length})`;
};
console.log('[setupProxy] keys loaded:');
console.log('  CLAUDE_KEY     :', fingerprint(CLAUDE_KEY));
console.log('  TRIPO_KEY      :', fingerprint(TRIPO_KEY));
console.log('  VINAUDIT_KEY   :', fingerprint(VINAUDIT_KEY));
console.log('  VINCARIO_KEY   :', fingerprint(VINCARIO_KEY));
console.log('  VINCARIO_SECRET:', fingerprint(VINCARIO_SECRET));

const stripBrowserHeaders = (proxyReq) => {
  proxyReq.removeHeader('origin');
  proxyReq.removeHeader('referer');
  proxyReq.removeHeader('sec-fetch-site');
  proxyReq.removeHeader('sec-fetch-mode');
  proxyReq.removeHeader('sec-fetch-dest');
  proxyReq.removeHeader('sec-fetch-user');
};

module.exports = function (app) {
  // Claude (Anthropic Messages) — server adds x-api-key & anthropic-version.
  // We capture and log the upstream body for any non-2xx response so we can
  // tell apart 400 (oversized image / bad payload), 401 (bad key), 413
  // (request too large), 529 (overloaded), etc. The successful streaming
  // path is left completely untouched.
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
      onProxyRes: (proxyRes, req) => {
        if (proxyRes.statusCode >= 400) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 600);
            console.warn(`[claude←] ${req.method} ${req.url}  status: ${proxyRes.statusCode}\n         body: ${body}`);
          });
        }
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
      onProxyReq: (proxyReq, req) => {
        stripBrowserHeaders(proxyReq);
        if (TRIPO_KEY) {
          proxyReq.setHeader('Authorization', `Bearer ${TRIPO_KEY}`);
          console.log(`[tripo→] ${req.method} ${req.url}  auth: attached (key ${fingerprint(TRIPO_KEY)})`);
        } else {
          console.warn(`[tripo→] ${req.method} ${req.url}  auth: MISSING — TRIPO_KEY not loaded; request will 401`);
        }
      },
      onProxyRes: (proxyRes, req) => {
        if (proxyRes.statusCode >= 400) {
          // Surface the upstream body for failed Tripo requests so we can tell
          // 401 (bad key) from 402 (out of credits) from 400 (bad payload).
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8').slice(0, 400);
            console.warn(`[tripo←] ${req.method} ${req.url}  status: ${proxyRes.statusCode}\n         body: ${body}`);
          });
        }
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
      // Return 200 (not 501) so the browser doesn't log a red error in the
      // console. The decoder reads `available: false` and gracefully falls
      // back to NHTSA. Vincario is an optional upgrade — NHTSA is the
      // primary path and is always free.
      return res.json({ available: false, reason: 'vincario_not_configured' });
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

  // Dev-only GLB CORS bypass.
  //
  // Tripo3D's CDN (tripo-data.rg1.data.tripo3d.com) doesn't send
  // Access-Control-Allow-Origin, so a browser fetch from localhost is
  // blocked. In production this never happens — R2 + our custom domain
  // (models.vincritiq.com) has CORS configured. In dev we tunnel the
  // request through the dev server so the browser sees a same-origin
  // response with permissive CORS headers.
  //
  // Only Tripo CDN hosts are allow-listed here so this can't be turned
  // into an SSRF that pulls arbitrary URLs.
  app.get('/dev-glb-proxy', async (req, res) => {
    const url = String(req.query.url || '');
    if (!/^https:\/\/[a-z0-9-]+\.(?:rg1\.)?data\.tripo3d\.com\//i.test(url)) {
      return res.status(400).json({ error: 'invalid_or_disallowed_url' });
    }
    try {
      const upstream = await fetch(url);
      if (!upstream.ok) {
        console.warn('[dev-glb-proxy] upstream non-OK', { status: upstream.status, url });
        return res.status(upstream.status).end();
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'model/gltf-binary');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (upstream.body) {
        Readable.fromWeb(upstream.body).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      console.warn('[dev-glb-proxy] fetch threw', err);
      res.status(502).json({ error: 'upstream_failed', message: String(err?.message || err) });
    }
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
