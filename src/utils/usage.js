import { doc, updateDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

const ANON_KEY = 'carbot-anon-usage';
export const PLAN_LIMITS = { free: 3, starter: 50, pro: 150, unlimited: Infinity };

// Emails that always get unlimited access, no quota checks
export const ADMIN_EMAILS = ['yousif2alsabah@gmail.com', 'madaorocket@gmail.com'];

export function isAdmin(email) {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
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

    // Reset daily for free plan
    if (data.plan === 'free') {
      const lastReset = data.lastReset?.toDate?.() || new Date(0);
      const today = new Date().toDateString();
      if (lastReset.toDateString() !== today) {
        await updateDoc(ref, { promptsUsed: 0, lastReset: serverTimestamp() });
        return true;
      }
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
    await updateDoc(ref, { promptsUsed: (data.promptsUsed || 0) + 1 });
  } catch {}
}

export const PLANS = [
  { id: 'free', name: 'Free', price: '$0', prompts: '3/day', description: 'Try CarBot for free' },
  { id: 'starter', name: 'Starter', price: '$5.99/mo', prompts: '50 prompts', description: 'Perfect for occasional buyers' },
  { id: 'pro', name: 'Pro', price: '$11.99/mo', prompts: '150 prompts', description: 'Serious car shoppers' },
  { id: 'unlimited', name: 'Unlimited', price: '$29.99/mo', prompts: 'Unlimited', description: 'Dealers & power users' },
];
