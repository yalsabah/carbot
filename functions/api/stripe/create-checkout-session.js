// POST /api/stripe/create-checkout-session
//
// Creates a Stripe Checkout Session for the given price + user, returns the
// hosted checkout URL. Client redirects the browser to that URL.
//
// Why we hit Stripe via raw fetch instead of the official `stripe` npm package:
// the official lib uses Node's http module (and process.env, etc.), which
// don't exist in Cloudflare Workers. The form-encoded REST API is small,
// stable, and lets us stay dependency-free.
//
// Required Cloudflare Pages env / secrets:
//   STRIPE_SECRET_KEY  — sk_test_… in dev/staging, sk_live_… in prod
//   PUBLIC_BASE_URL    — e.g. https://vincritiq.com (used to build success/cancel URLs)

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Stripe is not configured on this environment.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const { uid, email, priceId, planId } = body || {};
  if (!uid || !priceId) {
    return json({ error: 'uid and priceId are required' }, 400);
  }

  const baseUrl =
    env.PUBLIC_BASE_URL || new URL(request.url).origin || 'https://vincritiq.com';

  // Stripe expects application/x-www-form-urlencoded with bracket notation
  // for nested fields. URLSearchParams handles the encoding cleanly.
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('client_reference_id', uid);
  if (email) params.append('customer_email', email);
  params.append('success_url', `${baseUrl}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseUrl}/?stripe=cancelled`);
  params.append('allow_promotion_codes', 'true');
  // metadata travels through to webhook + verify-session so we know which
  // plan to apply when the checkout completes.
  if (planId) params.append('metadata[planId]', planId);
  params.append('metadata[uid]', uid);

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return json(
      { error: data?.error?.message || `Stripe ${r.status}` },
      r.status,
    );
  }

  return json({ url: data.url, id: data.id });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
