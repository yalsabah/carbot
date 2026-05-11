// POST /api/stripe/webhook
//
// Stripe → us. Receives subscription lifecycle events:
//   checkout.session.completed     → user just paid; happy path is also handled
//                                     by verify-session.js (client polls), this
//                                     is the redundant async confirmation.
//   customer.subscription.updated  → plan changed, payment method changed, etc.
//   customer.subscription.deleted  → cancellation
//   invoice.payment_failed         → renewal failed; downgrade after grace period
//
// We MUST verify the Stripe-Signature header before trusting anything in the
// body — otherwise anyone could POST a fake "subscription cancelled" event.
//
// IMPORTANT — Firestore writes from this handler are not yet wired.
// Cloudflare Workers can't import the Firebase Admin SDK (it's Node-only),
// so writing to Firestore from here requires either:
//   (a) signing a service-account JWT and hitting Firestore REST API
//       (~80 lines of crypto code), or
//   (b) forwarding to a tiny Firebase Cloud Function that does the write.
//
// For MVP, the verify-session.js endpoint handles the happy path (the client
// writes to its own user doc after a successful checkout, allowed by Firestore
// rules). This webhook still verifies + logs events so we have an audit trail
// in Cloudflare logs and can wire (a) or (b) in a follow-up PR.
//
// Required env:
//   STRIPE_WEBHOOK_SECRET — whsec_… from the Stripe dashboard webhook config

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response('webhook_not_configured', { status: 503 });
  }

  const sig = request.headers.get('stripe-signature') || '';
  const payload = await request.text(); // must be raw — signature is over bytes

  const verified = await verifyStripeSignature(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) {
    return new Response('invalid_signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('invalid_json', { status: 400 });
  }

  // Audit-trail log. Cloudflare captures `console.log` from Pages Functions
  // and surfaces them in the dashboard's Real-time Logs.
  console.log('[stripe-webhook]', event.type, {
    id: event.id,
    customer: event.data?.object?.customer,
    subscription: event.data?.object?.subscription || event.data?.object?.id,
  });

  // TODO: wire Firestore writes per the comment above. Skeleton is below
  // for the cases we care about; each branch is a no-op for now.
  switch (event.type) {
    case 'checkout.session.completed': {
      // const { client_reference_id: uid, customer, subscription, metadata } = event.data.object;
      // → write users/{uid}: { plan: metadata.planId, stripeCustomerId: customer,
      //                        stripeSubscriptionId: subscription, subscriptionStatus: 'active' }
      break;
    }
    case 'customer.subscription.updated': {
      // const sub = event.data.object;
      // → write users/{uidLookupByCustomer}: { subscriptionStatus: sub.status,
      //                                        currentPeriodEnd: sub.current_period_end }
      break;
    }
    case 'customer.subscription.deleted': {
      // → write users/{uidLookupByCustomer}: { plan: 'free', subscriptionStatus: 'cancelled' }
      break;
    }
    case 'invoice.payment_failed': {
      // → write users/{uidLookupByCustomer}: { subscriptionStatus: 'past_due' }
      break;
    }
    default:
      // Unhandled event type — fine, just acknowledge so Stripe stops retrying.
      break;
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stripe's signing scheme:
//   header is `t=<unix>,v1=<hex hmac sha256>,v1=<…>` — there can be multiple
//     v1 entries during secret rotation; any match counts.
//   signed payload is `${t}.${rawBody}`
//   we HMAC-SHA256 it with the webhook secret and compare to v1.
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (!k || !v) return acc;
    if (k === 't') acc.t = v;
    else if (k === 'v1') (acc.v1 ||= []).push(v);
    return acc;
  }, {});
  if (!parts.t || !parts.v1?.length) return false;

  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return false;
  // Reject events older than 5 minutes — protects against replay attacks
  // even if the secret somehow leaked into a log.
  const ageSec = Math.floor(Date.now() / 1000) - ts;
  if (ageSec > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${parts.t}.${payload}`),
  );
  const computedHex = [...new Uint8Array(sigBytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare against each candidate v1.
  return parts.v1.some((expected) => timingSafeEqualHex(expected, computedHex));
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
