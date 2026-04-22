const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  // Claude API proxy
  app.use(
    '/api/claude',
    createProxyMiddleware({
      target: 'https://api.anthropic.com',
      changeOrigin: true,
      pathRewrite: { '^/api/claude': '' },
      onProxyReq: (proxyReq) => {
        proxyReq.removeHeader('origin');
        proxyReq.removeHeader('referer');
        proxyReq.removeHeader('sec-fetch-site');
        proxyReq.removeHeader('sec-fetch-mode');
        proxyReq.removeHeader('sec-fetch-dest');
        proxyReq.removeHeader('sec-fetch-user');
      },
    })
  );

  // Hyper3D Rodin API proxy
  app.use(
    '/api/rodin',
    createProxyMiddleware({
      target: 'https://hyperhuman.deemos.com',
      changeOrigin: true,
      pathRewrite: { '^/api/rodin': '/api/v2/rodin' },
      onProxyReq: (proxyReq) => {
        proxyReq.removeHeader('origin');
        proxyReq.removeHeader('referer');
        proxyReq.removeHeader('sec-fetch-site');
        proxyReq.removeHeader('sec-fetch-mode');
        proxyReq.removeHeader('sec-fetch-dest');
        proxyReq.removeHeader('sec-fetch-user');
      },
    })
  );
};
