// Client-side helpers for our Stripe Pages Functions.
//
// All three endpoints live in /functions/api/stripe/* in production and are
// mirrored by /api/stripe/* dev-proxy stubs in src/setupProxy.js. The browser
// never sees the Stripe secret key — these helpers just hit our own functions
// which forward to Stripe with the secret attached server-side.

/**
 * Start a Stripe Checkout session for the given plan and redirect the browser
 * to the hosted checkout page. After payment, Stripe sends the user to
 * `${origin}/?stripe=success&session_id={CHECKOUT_SESSION_ID}` where the app
 * picks it up via App.js and verifies/applies the upgrade.
 *
 * @param {{ uid: string, email: string, priceId: string, planId: string }} args
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function startCheckout({ uid, email, priceId, planId }) {
  if (!priceId) {
    return { ok: false, error: 'This plan is not available yet — Stripe price ID missing.' };
  }
  try {
    const res = await fetch('/api/stripe/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, email, priceId, planId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      return { ok: false, error: data.error || `Could not start checkout (${res.status}).` };
    }
    window.location.href = data.url;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Open the Stripe Customer Portal so the user can manage their subscription
 * (update card, change plan, cancel). Redirects the browser on success.
 *
 * @param {{ uid: string }} args
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function openCustomerPortal({ uid }) {
  try {
    const res = await fetch('/api/stripe/create-portal-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) {
      return { ok: false, error: data.error || `Could not open billing portal (${res.status}).` };
    }
    window.location.href = data.url;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * After Stripe redirects back to the app with ?session_id=…, ask the server
 * to confirm the session was paid AND that it matches the current user, then
 * return what plan they should be on. The client does the Firestore write
 * itself (so we don't need a Firebase Admin SDK on the server) — Firestore
 * Security Rules already enforce per-user-only writes.
 *
 * @param {{ sessionId: string, uid: string }} args
 * @returns {Promise<{ ok: boolean, planId?: string, subscriptionId?: string, customerId?: string, error?: string }>}
 */
export async function verifyCheckoutSession({ sessionId, uid }) {
  try {
    const res = await fetch(
      `/api/stripe/verify-session?session_id=${encodeURIComponent(sessionId)}&uid=${encodeURIComponent(uid)}`,
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `Verification failed (${res.status}).` };
    }
    return {
      ok: true,
      planId: data.planId,
      subscriptionId: data.subscriptionId,
      customerId: data.customerId,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
