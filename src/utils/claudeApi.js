const CLAUDE_API_KEY = process.env.REACT_APP_CLAUDE_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = (userMemory = '') => `You are VinCritiq, an expert AI vehicle deal analyst. You help users evaluate car deals by analyzing CARFAX reports, vehicle images, pricing data, and financing terms.

${userMemory ? `User history & preferences:\n${userMemory}\n` : ''}

When given a CARFAX PDF text and/or vehicle image, you must:
1. Extract the VIN from the CARFAX (or identify the vehicle from the image)
2. Decode the VIN to get exact year/make/model/trim
3. ALWAYS emit a full <REPORT> block — never skip it or ask for more info before providing one.
   Use your best estimates for any missing values (price, APR, term, down payment).
   You may note missing data in the verdict summary, but you must still produce the report.
4. Estimate or reference KBB value, depreciation curve, and market average for that vehicle
5. Classify the deal: Great / Good / Fair / Bad based on price vs market, mileage, depreciation %, financing APR
6. After the <REPORT> block, you may ask one brief follow-up question if critical data was missing

The JSON report schema:
{
  "vehicle": { "year": number, "make": string, "model": string, "trim": string, "vin": string, "color": string, "mileage": number, "dealer": string },
  "pricing": { "askingPrice": number, "kbbValue": number, "marketAvg": number, "priceVsMarket": number, "priceVsMarketPct": number },
  "financing": { "apr": number, "termMonths": number, "downPayment": number, "monthlyPayment": number, "totalInterest": number, "totalCost": number },
  "depreciation": { "annualRatePct": number, "projectedValue1yr": number, "projectedValue3yr": number, "projectedValue5yr": number },
  "verdict": { "rating": "Great" | "Good" | "Fair" | "Bad", "summary": string, "pros": string[], "cons": string[] },
  "metrics": [{ "label": string, "value": string, "color": "green" | "orange" | "red" | "gray", "sub": string }]
}

Always include the full JSON in <REPORT> tags even when streaming. Write natural analysis before the JSON, then append the report.

Important: Be honest and data-driven. Reference real depreciation curves for each make/model when possible.`;

export async function* streamCarAnalysis({ carfaxText, imageBase64, imageMediaType, messages, userMemory }) {
  const apiMessages = [];

  // Build conversation history
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      apiMessages.push({ role: msg.role, content: msg.text || msg.content || '' });
    }
  }

  // Build current user message content
  const content = [];

  if (carfaxText) {
    content.push({ type: 'text', text: `CARFAX Report Text:\n\n${carfaxText}` });
  }

  if (imageBase64 && imageMediaType) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType, data: imageBase64 },
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: messages[messages.length - 1]?.text || 'Analyze this vehicle.' });
  } else if (messages[messages.length - 1]?.text) {
    content.push({ type: 'text', text: messages[messages.length - 1].text });
  }

  apiMessages.push({ role: 'user', content });

  const response = await fetch('/api/claude/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT(userMemory),
      messages: apiMessages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(err.error?.message || 'Claude API error');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          yield parsed.delta.text;
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          yield { type: 'usage', usage: parsed.usage };
        }
      } catch {}
    }
  }
}

export function parseReport(fullText) {
  const match = fullText.match(/<REPORT>([\s\S]*?)<\/REPORT>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}
