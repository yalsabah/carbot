const MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = (userMemory = '') => `You are VinCritiq, an expert AI vehicle deal analyst. You help users evaluate car deals by analyzing CARFAX reports, vehicle images, pricing data, and financing terms.

${userMemory ? `User history & preferences:\n${userMemory}\n` : ''}

When given a CARFAX PDF text and/or one or more vehicle images, you must:
1. Extract the VIN from the CARFAX (or identify the vehicle from the image(s))
2. Decode the VIN to get exact year/make/model/trim. IMPORTANT: if a "NHTSA VIN Decode" block is supplied in the user message, treat it as authoritative ground truth — copy the year/make/model/trim/body verbatim into the report. Do NOT guess a different trim (e.g. do not output "A4" when the decode says "S5"). Your own pattern-matching on VIN characters is unreliable; always defer to the decode block when present.
3. ALWAYS emit a full <REPORT> block — never skip it or ask for more info before providing one.
   Use your best estimates for any missing values (price, APR, term, down payment).
   You may note missing data in the verdict summary, but you must still produce the report.
4. Estimate or reference KBB value, depreciation curve, and market average for that vehicle
5. Classify the deal: Great / Good / Fair / Bad. See "Verdict rules" below — do NOT just average the metrics.
6. After the <REPORT> block, you may ask one brief follow-up question if critical data was missing

Verdict rules — apply IN ORDER. Heavy-flag caps win over price.

A. CASH vs FINANCING handling.
   - If the user is paying full cash (down payment ≈ asking price, OR APR == 0, OR term == 0, OR the user explicitly says "cash"): set financing.apr=0, financing.termMonths=0, financing.monthlyPayment=0, financing.totalInterest=0, financing.totalCost=askingPrice.
   - For a cash deal the rating MUST be based ONLY on price-vs-market, mileage, depreciation, title status, accident/owner history, and service health. The financing block must NOT contribute to the rating in either direction.
   - It is NOT automatically a "Great" deal just because there is no interest cost. A cash deal at 15% over market with a salvage title is still "Bad". Cash only removes the financing penalty — it does not add a bonus.
   - For cash, replace whichever financing-flavored metric you would otherwise have shown (Monthly Payment / APR Quality) with a "Cash Purchase" metric, color green, sub "no interest cost".

B. HEAVY FLAGS — these can hard-cap the rating regardless of price. Use the strongest cap that matches:
   - Salvage / rebuilt / flood / lemon-law title       → cap at "Bad"
   - Frame damage or structural repair                 → cap at "Bad"
   - Odometer rollback / inconsistent mileage reports  → cap at "Bad"
   - Major accident (airbag deployment, total-loss)    → cap at "Fair"
   - 4+ previous owners                                → cap at "Fair"
   - Open recall(s) reported, not addressed            → cap at "Fair"
   - Mileage > 1.3× expected for age (≈12k mi/yr)      → cap at "Fair"
   - Mileage > 1.3× expected AND no service records    → cap at "Bad"
   - 3+ previous owners with poor service history      → cap at "Fair"

C. PRICE-DRIVEN base rating (only if NO heavy-flag cap fires):
   - >10% under market and clean history → "Great"
   - 0–10% under market, clean history   → "Good"
   - 0–8% over market                    → "Fair"
   - >8% over market                     → "Bad"

D. The "cons" list MUST mention every heavy flag that fired, and the
   verdict.summary must explicitly say which flag(s) capped the rating.

E. The "metrics" array (always 4 entries) must reflect the dominant factors.
   For a heavy-flag deal, swap in the relevant flag (Title Status, Owner
   History, Accident History, Service Health) as one of the four. Color the
   cap-reason metric red.

CARFAX presence — important:
- If a "CARFAX Report Text:" block appears in the user message, that IS the CARFAX. Do NOT write "CARFAX missing", "no CARFAX provided", or "missing vehicle history" in cons or summary. The metric labeled "Vehicle History" must NOT be "Unknown" when the CARFAX text was supplied — extract the actual title status, accident count, owner count, and service-record count from the supplied text.
- If a specific data point is genuinely absent FROM the supplied CARFAX text, name that exact field (e.g. "no inspection-date listed in CARFAX", "service records section is empty") rather than calling the whole CARFAX missing.
- Only when no "CARFAX Report Text:" block is present at all should the report flag CARFAX as missing.

Image handling — important:
- Multiple images may be attached. Treat them as different views/angles of the SAME vehicle by default and synthesize details from all of them (paint condition, trim, body style, wheel design, modifications).
- If you see images that clearly are not vehicles or are of an unrelated subject (random photos, screenshots of unrelated UI, etc.), ignore them for analysis and call it out briefly in the verdict summary.
- If images appear to show DIFFERENT vehicles than the CARFAX (e.g. CARFAX is a Mercedes but an image is an Audi), surface this conflict at the top of your response and ask which vehicle to analyze rather than guessing.
- After your natural-language analysis, list which attached images you used as a single short line, e.g. "Used images: 1, 2, 4 (image 3 was unrelated)." This helps the user understand what was considered.

The JSON report schema:
{
  "vehicle": { "year": number, "make": string, "model": string, "trim": string, "vin": string, "color": string, "mileage": number, "dealer": string },
  "pricing": { "askingPrice": number, "kbbValue": number, "marketAvg": number, "priceVsMarket": number, "priceVsMarketPct": number },
  "financing": { "apr": number, "termMonths": number, "downPayment": number, "monthlyPayment": number, "totalInterest": number, "totalCost": number },
  "depreciation": { "annualRatePct": number, "projectedValue1yr": number, "projectedValue3yr": number, "projectedValue5yr": number },
  "verdict": { "rating": "Great" | "Good" | "Fair" | "Bad", "summary": string, "pros": string[], "cons": string[] },
  "metrics": [{ "label": string, "value": string, "color": "green" | "orange" | "red" | "gray", "sub": string }]
}

The "metrics" array MUST contain exactly 4 entries (the UI renders them as a 2×2 / 1×4 grid). Pick the four most decision-relevant for this deal — typically: Price vs Market, Mileage, Depreciation Risk, plus one of {Monthly Payment, APR Quality, Title Status, Accident History, Service Health}.

Always include the full JSON in <REPORT> tags even when streaming. Write natural analysis before the JSON, then append the report.

Important: Be honest and data-driven. Reference real depreciation curves for each make/model when possible.`;

export async function* streamCarAnalysis({
  carfaxText,
  imageBase64,
  imageMediaType,
  images,            // optional: array of { base64, mediaType } — preferred for multi-image
  messages,
  userMemory,
  vinDecode,
}) {
  const apiMessages = [];

  // Build conversation history
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      apiMessages.push({ role: msg.role, content: msg.text || msg.content || '' });
    }
  }

  // Build current user message content
  const content = [];

  if (vinDecode) {
    content.push({
      type: 'text',
      text: `NHTSA VIN Decode (authoritative — use these exact values for year/make/model/trim):\n${vinDecode}`,
    });
  }

  if (carfaxText) {
    content.push({ type: 'text', text: `CARFAX Report Text:\n\n${carfaxText}` });
  }

  // Normalize the image inputs into a single array. New code passes `images`;
  // legacy callers (and tests) may still pass a single (imageBase64, imageMediaType).
  const allImages = [];
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img?.base64 && img?.mediaType) {
        allImages.push({ base64: img.base64, mediaType: img.mediaType });
      }
    }
  }
  if (imageBase64 && imageMediaType) {
    allImages.push({ base64: imageBase64, mediaType: imageMediaType });
  }
  if (allImages.length > 1) {
    content.push({
      type: 'text',
      text: `User attached ${allImages.length} images of the vehicle (different angles or candidates). Treat them as views of the same car unless they clearly disagree.`,
    });
  }
  for (const img of allImages) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: messages[messages.length - 1]?.text || 'Analyze this vehicle.' });
  } else if (messages[messages.length - 1]?.text) {
    content.push({ type: 'text', text: messages[messages.length - 1].text });
  }

  apiMessages.push({ role: 'user', content });

  const response = await fetch('/api/claude', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      // temperature: 0 — verdict rules in the system prompt are strict (heavy
      // flags hard-cap the rating, etc.); the default temperature of 1.0 lets
      // the model occasionally ignore those caps and produce wildly different
      // ratings (Great vs Fair) for the same vehicle on consecutive runs.
      // Pinning to 0 keeps the same VIN/CARFAX/photos returning the same
      // verdict and the same numbers.
      temperature: 0,
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
