// Netlify Function: proxies Claude API requests server-side so the API key
// is never exposed in the browser bundle.
//
// Set CLAUDE_API_KEY (NOT REACT_APP_CLAUDE_API_KEY) in Netlify environment
// variables with scope "Functions" only — it never reaches the browser.
//
// In claudeApi.js change the fetch URL from:
//   /api/claude/v1/messages   (current — exposes key in bundle)
// to:
//   /.netlify/functions/claude

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Claude API key not configured' }) };
  }

  try {
    const body = JSON.parse(event.body);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
        'anthropic-beta':       'interleaved-thinking-2025-05-14',
      },
      body: JSON.stringify(body),
    });

    const data = await response.text();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: data,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
