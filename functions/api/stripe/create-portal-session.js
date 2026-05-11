// POST /api/stripe/create-portal-session
//
// Returns a Stripe Customer Portal URL where the user can update payment
// method, change plan, view invoices, or cancel.
//
// Body: { uid: string }
//
// We need the Stripe customerId to open the portal. The client sends just
// the uid; this function looks up the Firestore user doc to find the
// `stripeCustomerId` that was saved when the user first checked out.
//
// Because Cloudflare Workers don't have the Firebase Admin SDK, we hit the
// Firestore REST API anonymously — but that requires the doc to be readable
// by anyone, which it is NOT (rules are per-user). So instead the CLIENT
// is responsible for sending the customerId it already has cached locally
// in userDoc. That keeps this function stateless and avoids any Firebase
// service-account setup on the server.
//
// Required env:
//   STRIPE_SECRET_KEY
//   PUBLIC_BASE_URL

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

  const { customerId, uid } = body || {};
  if (!customerId) {
    // Without a customerId we can't open the portal. Tell the client to
    // pass it (it lives in userDoc.stripeCustomerId).
    return json(
      { error: 'No active subscription found. Subscribe to a paid plan first.' },
      400,
    );
  }
  if (!uid) {
    return json({ error: 'uid is required' }, 400);
  }

  const baseUrl =
    env.PUBLIC_BASE_URL || new URL(request.url).origin || 'https://vincritiq.com';

  const params = new URLSearchParams();
  params.append('customer', customerId);
  params.append('return_url', `${baseUrl}/?stripe=portal-return`);

  const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
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

  return json({ url: data.url });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
