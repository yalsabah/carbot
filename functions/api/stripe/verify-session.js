// GET /api/stripe/verify-session?session_id=cs_…&uid=<firebase-uid>
//
// After Stripe redirects the user back with ?session_id=…, the client calls
// this to confirm the session was actually paid AND that it belongs to them.
// We return the planId + customerId + subscriptionId so the client can write
// it to its own Firestore user doc (which is allowed by per-user rules).
//
// This avoids needing a Firebase Admin SDK / service account on the worker:
// the client does the Firestore write, and the server's job is just to
// authenticate the Stripe side.
//
// Required env: STRIPE_SECRET_KEY

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return json({ ok: false, error: 'Stripe is not configured.' }, 503);
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  const uid = url.searchParams.get('uid');
  if (!sessionId || !uid) {
    return json({ ok: false, error: 'session_id and uid are required' }, 400);
  }

  // Expand subscription so we can return the subscription_id without a
  // second round trip.
  const r = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
    {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    },
  );
  const session = await r.json().catch(() => ({}));
  if (!r.ok) {
    return json(
      { ok: false, error: session?.error?.message || `Stripe ${r.status}` },
      r.status,
    );
  }

  // Defense in depth: confirm the session belongs to the user calling this.
  // client_reference_id is what we set when creating the session — Stripe
  // copies it back verbatim so we can match it to the current user.
  if (session.client_reference_id !== uid && session?.metadata?.uid !== uid) {
    return json({ ok: false, error: 'Session does not belong to this user.' }, 403);
  }

  // payment_status === 'paid' for one-time, 'no_payment_required' rarely.
  // For subscriptions we also check the subscription status is active/trialing.
  const paid =
    session.payment_status === 'paid' ||
    session.payment_status === 'no_payment_required';
  const subStatus =
    typeof session.subscription === 'object' ? session.subscription?.status : null;
  const subActive = !subStatus || subStatus === 'active' || subStatus === 'trialing';

  if (!paid || !subActive) {
    return json(
      { ok: false, error: `Payment not completed (status: ${session.payment_status}).` },
      402,
    );
  }

  return json({
    ok: true,
    planId: session?.metadata?.planId || null,
    customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
    subscriptionId:
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
