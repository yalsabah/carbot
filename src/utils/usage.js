import { doc, updateDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

const ANON_KEY = 'carbot-anon-usage';
export const PLAN_LIMITS = { free: 3, starter: 50, pro: 150, unlimited: Infinity };

// Emails that always get unlimited access, no quota checks. Two ways to match:
//   1. Exact entry in this array.
//   2. Pattern match: any address shaped `admin_<anything>@gmail.com`. Lets
//      us hand a coworker an admin login (e.g. admin_marketing@gmail.com)
//      without redeploying.
export const ADMIN_EMAILS = ['yousif2alsabah@gmail.com', 'madaorocket@gmail.com'];
const ADMIN_PATTERN = /^admin_[^@\s]+@gmail\.com$/i;

export function isAdmin(email) {
  if (!email) return false;
  const e = String(email).toLowerCase().trim();
  if (ADMIN_EMAILS.includes(e)) return true;
  return ADMIN_PATTERN.test(e);
}

// Display helper: appends " (Admin)" to the user's name (or email) when they
// have admin privileges. Use this anywhere we render the user identity in the
// UI; SettingsModal's editable name input uses the raw value so the suffix
// doesn't get saved into Firestore.
export function formatDisplayName(displayName, email) {
  const base = (displayName && displayName.trim()) || email || 'User';
  return isAdmin(email) ? `${base} (Admin)` : base;
}

export function getAnonUsage() {
  try {
    const raw = localStorage.getItem(ANON_KEY);
    if (!raw) return { count: 0, date: new Date().toDateString() };
    return JSON.parse(raw);
  } catch {
    return { count: 0, date: new Date().toDateString() };
  }
}

export function incrementAnonUsage() {
  const today = new Date().toDateString();
  const usage = getAnonUsage();
  const count = usage.date === today ? usage.count + 1 : 1;
  localStorage.setItem(ANON_KEY, JSON.stringify({ count, date: today }));
}

export function canAnonPrompt() {
  const today = new Date().toDateString();
  const usage = getAnonUsage();
  return usage.date !== today || usage.count < 1;
}

// Check quota using cached userDoc (from context) — no Firestore call needed
export function canPromptFromDoc(userDoc, userEmail) {
  if (!userDoc) return false;
  if (isAdmin(userEmail)) return true;
  const limit = PLAN_LIMITS[userDoc.plan] ?? 3;
  if (limit === Infinity) return true;
  return (userDoc.promptsUsed || 0) < limit;
}

// Quota cycle = 24 hours from the user's FIRST prompt of the cycle.
// Stored on the user doc as `cycleStartedAt: Timestamp`. When 24h has
// elapsed since cycleStartedAt, the next prompt resets the counter and
// stamps a new cycleStartedAt. This is a rolling window, not a calendar
// day — a user who first prompts at 11:55 PM Monday won't see their
// quota reset at midnight; it resets at 11:55 PM Tuesday.
const CYCLE_MS = 24 * 60 * 60 * 1000;

const readCycleStartMs = (data) => {
  const v = data?.cycleStartedAt;
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return 0;
};

export async function canUserPrompt(userId, userEmail) {
  // Admin always allowed
  if (isAdmin(userEmail)) return true;

  try {
    const ref = doc(db, 'users', userId);
    const snap = await getDoc(ref);
    // If doc doesn't exist yet (Firestore just connected), allow and it'll be created
    if (!snap.exists()) return true;

    const data = snap.data();
    const limit = PLAN_LIMITS[data.plan] ?? 3;
    if (limit === Infinity) return true;

    // Free plan uses a 24h rolling cycle from first prompt. Paid plans
    // also reset on a 24h cycle (matches the "X prompts/day" labeling
    // shown in PLANS) — adjust here if you change paid plans to monthly.
    const start = readCycleStartMs(data);
    const now = Date.now();
    const cycleExpired = start > 0 && now - start >= CYCLE_MS;
    if (cycleExpired) {
      // The next prompt starts a fresh cycle; reset and let it through.
      // We clear cycleStartedAt rather than stamping `now` here — the
      // increment step will stamp it when the prompt actually completes.
      await updateDoc(ref, { promptsUsed: 0, cycleStartedAt: null });
      return true;
    }

    return (data.promptsUsed || 0) < limit;
  } catch {
    // Firestore offline — fail open so user isn't blocked
    return true;
  }
}

export async function incrementUserUsage(userId, userEmail) {
  if (isAdmin(userEmail)) return; // don't count admin usage
  try {
    const ref = doc(db, 'users', userId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const patch = { promptsUsed: (data.promptsUsed || 0) + 1 };
    // Stamp cycle start on the first prompt of a new cycle. canUserPrompt
    // clears cycleStartedAt when the previous cycle expires, so this
    // condition catches both "very first prompt ever" and "first prompt
    // after the rolling window expired".
    const start = readCycleStartMs(data);
    if (!start) {
      patch.cycleStartedAt = serverTimestamp();
      patch.promptsUsed = 1; // ensures clean reset → 1 even if increment race
    }
    await updateDoc(ref, patch);
  } catch {}
}

// Stripe price IDs are sourced from build-time env (REACT_APP_STRIPE_PRICE_*).
// Keeping them as env vars (not hard-coded) means dev/staging/prod can use
// different Stripe products without code changes. When unset (e.g. local dev
// without Stripe configured), the upgrade button stays disabled.
export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    prompts: '3/day',
    description: 'Try VinCritiq for free',
    priceId: null,
  },
  {
    id: 'starter',
    name: 'Starter',
    price: '$5.99/mo',
    prompts: '50 prompts',
    description: 'Perfect for occasional buyers',
    priceId: process.env.REACT_APP_STRIPE_PRICE_STARTER || null,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$11.99/mo',
    prompts: '150 prompts',
    description: 'Serious car shoppers',
    priceId: process.env.REACT_APP_STRIPE_PRICE_PRO || null,
  },
  {
    id: 'unlimited',
    name: 'Unlimited',
    price: '$29.99/mo',
    prompts: 'Unlimited',
    description: 'Dealers & power users',
    priceId: process.env.REACT_APP_STRIPE_PRICE_UNLIMITED || null,
  },
];
