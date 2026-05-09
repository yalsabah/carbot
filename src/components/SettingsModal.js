import React, { useState } from 'react';
import {
  X,
  User,
  CreditCard,
  BarChart2,
  Brain,
  Check,
  Shield,
  LogOut,
  Mail,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { doc, updateDoc, deleteField } from 'firebase/firestore';
import { db } from '../firebase/config';
import { PLANS, isAdmin, formatDisplayName } from '../utils/usage';
import { useTheme } from '../contexts/ThemeContext';
import { startCheckout, openCustomerPortal } from '../utils/stripeClient';

const TABS = [
  { id: 'personal', label: 'Personal', icon: User },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'usage', label: 'Usage', icon: BarChart2 },
  { id: 'memory', label: 'Memory', icon: Brain },
];

export default function SettingsModal({ onClose }) {
  const { user, userDoc, logout, refreshUserDoc, updateUserEmail, reauthenticate } = useAuth();
  const { dark } = useTheme();
  const admin = isAdmin(user?.email);
  const [tab, setTab] = useState('personal');

  // ── Display name state ────────────────────────────────────────────
  const [name, setName] = useState(userDoc?.displayName || '');
  const [savingName, setSavingName] = useState(false);
  const [savedName, setSavedName] = useState(false);

  // ── Email change state ────────────────────────────────────────────
  const [email, setEmail] = useState(user?.email || '');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState(null); // { kind: 'ok'|'err', text, code? }

  // ── Reauth state (only used when email change hits requires-recent-login) ─
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);

  // ── Billing state ─────────────────────────────────────────────────
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState(null);

  const emailChanged =
    email.trim().length > 0 &&
    email.trim().toLowerCase() !== (user?.email || '').toLowerCase();

  const saveName = async () => {
    if (!user) return;
    setSavingName(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { displayName: name });
      await refreshUserDoc();
      setSavedName(true);
      setTimeout(() => setSavedName(false), 2000);
    } finally {
      setSavingName(false);
    }
  };

  const saveEmail = async () => {
    if (!user || !emailChanged) return;
    setEmailBusy(true);
    setEmailMsg(null);
    try {
      const result = await updateUserEmail(email);
      if (result.ok) {
        setEmailMsg({ kind: 'ok', text: result.message });
      } else {
        // Carry the code through so the UI can render the inline reauth flow
        // when Firebase says auth/requires-recent-login.
        setEmailMsg({ kind: 'err', text: result.message, code: result.code });
      }
    } finally {
      setEmailBusy(false);
    }
  };

  // For Google: pop the picker and (on success) auto-retry the email change.
  // For password: first call returns needs-password; we render an input and
  // call again with the password.
  const handleReauthAndRetry = async (passwordIfNeeded) => {
    setReauthBusy(true);
    try {
      const result = await reauthenticate(passwordIfNeeded);
      if (result.ok) {
        setEmailMsg(null);
        setReauthPassword('');
        await saveEmail();
        return;
      }
      if (result.code === 'needs-password') {
        // First click for password users — surface the inline input.
        setEmailMsg({
          kind: 'err',
          code: 'needs-password',
          text: result.message,
        });
        return;
      }
      setEmailMsg({ kind: 'err', text: result.message, code: result.code });
    } finally {
      setReauthBusy(false);
    }
  };

  // ── Billing actions ───────────────────────────────────────────────
  const handleUpgrade = async (plan) => {
    if (!user || !plan?.priceId) return;
    setBillingBusy(true);
    setBillingError(null);
    const result = await startCheckout({
      uid: user.uid,
      email: user.email,
      priceId: plan.priceId,
      planId: plan.id,
    });
    if (!result.ok) {
      setBillingError(result.error);
      setBillingBusy(false);
    }
    // On success the browser navigates away, no cleanup needed.
  };

  const handleManageSubscription = async () => {
    if (!user) return;
    const customerId = userDoc?.stripeCustomerId;
    if (!customerId) {
      setBillingError('No active subscription to manage.');
      return;
    }
    setBillingBusy(true);
    setBillingError(null);
    try {
      const res = await fetch('/api/stripe/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid, customerId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        setBillingError(data.error || `Could not open billing portal (${res.status}).`);
        setBillingBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      setBillingError(String(err?.message || err));
      setBillingBusy(false);
    }
    // openCustomerPortal export is unused on this path because we need to
    // pass customerId from userDoc; keeping the helper for future API parity.
    // eslint-disable-next-line no-unused-expressions
    openCustomerPortal;
  };

  const clearMemory = async () => {
    if (!user) return;
    await updateDoc(doc(db, 'users', user.uid), { preferences: deleteField() });
    await refreshUserDoc();
  };

  const planLimit = { free: 3, starter: 50, pro: 150, unlimited: Infinity };
  const limit = planLimit[userDoc?.plan] ?? 3;
  const used = userDoc?.promptsUsed ?? 0;
  const pct = limit === Infinity ? 5 : Math.min(100, Math.round((used / limit) * 100));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative w-full max-w-3xl rounded-2xl overflow-hidden shadow-2xl flex flex-col"
        // Stop clicks INSIDE the modal from bubbling up to the backdrop —
        // otherwise typing in inputs or hitting buttons would close the modal.
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          maxHeight: 'min(640px, 90vh)',
          height: '90vh',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 flex-shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <div className="flex items-center gap-2">
            <h2 className="font-bold text-lg" style={{ color: 'var(--color-text)' }}>
              Settings
            </h2>
            {admin && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                style={{
                  background: dark ? '#1a2e1a' : '#f0fdf4',
                  border: '1px solid #16a34a',
                  color: '#16a34a',
                }}
                title={formatDisplayName(userDoc?.displayName, user?.email)}
              >
                <Shield size={10} /> Admin
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
            aria-label="Close settings"
          >
            <X size={18} style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar tabs */}
          <div
            className="w-48 p-3 space-y-1 flex-shrink-0"
            style={{ borderRight: '1px solid var(--color-border)' }}
          >
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-all"
                  style={{
                    background: active ? 'var(--color-bg)' : 'transparent',
                    color: active ? 'var(--color-text)' : 'var(--color-muted)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  <Icon size={15} />
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6">
            {tab === 'personal' && (
              <div className="space-y-6">
                <div>
                  <h3
                    className="font-semibold text-base mb-1"
                    style={{ color: 'var(--color-text)' }}
                  >
                    Personal Information
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--color-muted)' }}>
                    Update how your name and email appear across VinCritiq.
                  </p>
                </div>

                {/* Display Name */}
                <div className="space-y-2">
                  <label
                    className="text-xs font-semibold uppercase tracking-wider block"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Display Name
                  </label>
                  <div className="flex gap-2">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                      style={{
                        background: 'var(--color-bg)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text)',
                      }}
                      placeholder="Your name"
                    />
                    <button
                      onClick={saveName}
                      disabled={savingName || name === (userDoc?.displayName || '')}
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {savedName ? <Check size={14} /> : null}
                      {savedName ? 'Saved' : savingName ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Email */}
                <div className="space-y-2">
                  <label
                    className="text-xs font-semibold uppercase tracking-wider block"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Email
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1 relative">
                      <Mail
                        size={14}
                        className="absolute left-3 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--color-muted)' }}
                      />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          setEmailMsg(null);
                        }}
                        autoComplete="email"
                        className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                        style={{
                          background: 'var(--color-bg)',
                          border: '1px solid var(--color-border)',
                          color: 'var(--color-text)',
                        }}
                      />
                    </div>
                    <button
                      onClick={saveEmail}
                      disabled={emailBusy || !emailChanged}
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                    >
                      {emailBusy && <Loader2 size={14} className="animate-spin" />}
                      {emailBusy ? 'Sending…' : 'Change Email'}
                    </button>
                  </div>
                  {emailMsg && (
                    <div
                      className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
                      style={{
                        background:
                          emailMsg.kind === 'ok'
                            ? dark
                              ? '#0f2e1a'
                              : '#f0fdf4'
                            : dark
                            ? '#2e0f0f'
                            : '#fef2f2',
                        color: emailMsg.kind === 'ok' ? '#16a34a' : '#dc2626',
                        border: `1px solid ${
                          emailMsg.kind === 'ok' ? '#16a34a' : '#dc2626'
                        }33`,
                      }}
                    >
                      {emailMsg.kind === 'ok' ? (
                        <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                      )}
                      <span>{emailMsg.text}</span>
                    </div>
                  )}

                  {/* Inline reauth flow — shown when Firebase asks us to
                      re-verify the user before changing email. We detect
                      provider in handleReauthAndRetry; for Google it pops
                      a window, for password we render this inline input. */}
                  {emailMsg?.kind === 'err' &&
                    (emailMsg.code === 'auth/requires-recent-login' ||
                      emailMsg.code === 'needs-password') && (
                      <div
                        className="rounded-lg p-3 space-y-2"
                        style={{
                          background: 'var(--color-bg)',
                          border: '1px solid var(--color-border)',
                        }}
                      >
                        <div
                          className="text-xs font-semibold"
                          style={{ color: 'var(--color-text)' }}
                        >
                          Verify it's you
                        </div>
                        <p className="text-[11px]" style={{ color: 'var(--color-muted)' }}>
                          Sensitive changes need a fresh login. We'll re-verify
                          you and retry the email change automatically.
                        </p>

                        {emailMsg.code === 'needs-password' ? (
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={reauthPassword}
                              onChange={(e) => setReauthPassword(e.target.value)}
                              placeholder="Current password"
                              autoComplete="current-password"
                              className="flex-1 px-3 py-2 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
                              style={{
                                background: 'var(--color-surface)',
                                border: '1px solid var(--color-border)',
                                color: 'var(--color-text)',
                              }}
                            />
                            <button
                              onClick={() => handleReauthAndRetry(reauthPassword)}
                              disabled={reauthBusy || !reauthPassword}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                            >
                              {reauthBusy && <Loader2 size={12} className="animate-spin" />}
                              {reauthBusy ? 'Verifying…' : 'Verify & Retry'}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleReauthAndRetry()}
                            disabled={reauthBusy}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                          >
                            {reauthBusy && <Loader2 size={12} className="animate-spin" />}
                            {reauthBusy ? 'Opening…' : 'Verify with Google'}
                          </button>
                        )}
                      </div>
                    )}

                  <p className="text-[11px]" style={{ color: 'var(--color-muted)' }}>
                    We'll send a verification link to the new address. Your email
                    only changes after you click that link.
                  </p>
                </div>

                {/* Sign Out — danger zone, separated visually */}
                <div
                  className="pt-5 mt-5"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                >
                  <h4
                    className="text-xs font-semibold uppercase tracking-wider mb-2"
                    style={{ color: 'var(--color-muted)' }}
                  >
                    Account
                  </h4>
                  <button
                    onClick={async () => {
                      // Sign out, then hard-reload so any in-memory chats,
                      // attachments, or token-cache state from the previous
                      // session are wiped from the DOM. A simple onClose()
                      // would leave the chat list visible until React
                      // re-rendered, which has flickered the previous user's
                      // messages on screen for a few hundred ms.
                      try {
                        await logout();
                      } finally {
                        window.location.reload();
                      }
                    }}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:bg-red-500/10"
                    style={{
                      border: '1px solid #dc2626',
                      color: '#dc2626',
                      background: 'transparent',
                    }}
                  >
                    <LogOut size={14} />
                    Sign Out
                  </button>
                </div>
              </div>
            )}

            {tab === 'billing' && (
              <div className="space-y-5">
                <div>
                  <h3
                    className="font-semibold text-base mb-1"
                    style={{ color: 'var(--color-text)' }}
                  >
                    Billing & Plan
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--color-muted)' }}>
                    Choose the plan that fits your usage. Upgrades unlock daily
                    analyses and faster cached 3D models.
                  </p>
                </div>

                {admin && (
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium"
                    style={{
                      background: dark ? '#1a2e1a' : '#f0fdf4',
                      border: '1px solid #16a34a',
                      color: '#16a34a',
                    }}
                  >
                    <Shield size={14} />
                    Admin — Unlimited access, no quota
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  {PLANS.map((plan) => {
                    const isCurrent = admin
                      ? plan.id === 'unlimited'
                      : userDoc?.plan === plan.id;
                    return (
                      <div
                        key={plan.id}
                        className="rounded-xl p-4 transition-all"
                        style={{
                          border: isCurrent
                            ? '2px solid #2563eb'
                            : '1px solid var(--color-border)',
                          background: isCurrent
                            ? dark
                              ? '#1e3a5f'
                              : '#eff6ff'
                            : 'var(--color-bg)',
                        }}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <span
                            className="font-semibold text-sm"
                            style={{ color: 'var(--color-text)' }}
                          >
                            {plan.name}
                          </span>
                          {isCurrent && (
                            <span className="text-[10px] uppercase tracking-wider text-blue-400 font-bold px-1.5 py-0.5 rounded"
                              style={{ background: dark ? '#0a1f3a' : '#dbeafe' }}
                            >
                              Current
                            </span>
                          )}
                        </div>
                        <div
                          className="text-xl font-bold mb-1"
                          style={{ color: 'var(--color-text)' }}
                        >
                          {plan.price}
                        </div>
                        <div
                          className="text-xs mb-3"
                          style={{ color: 'var(--color-muted)' }}
                        >
                          {plan.prompts} · {plan.description}
                        </div>
                        {plan.id !== 'free' && !isCurrent && (
                          <button
                            onClick={() => handleUpgrade(plan)}
                            disabled={billingBusy || !plan.priceId}
                            title={
                              plan.priceId
                                ? `Upgrade to ${plan.name}`
                                : 'Stripe price ID not configured for this plan'
                            }
                            className="w-full py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {billingBusy
                              ? 'Opening…'
                              : plan.priceId
                              ? `Upgrade to ${plan.name}`
                              : 'Coming Soon'}
                          </button>
                        )}
                        {isCurrent && plan.id !== 'free' && (
                          <button
                            onClick={handleManageSubscription}
                            disabled={billingBusy}
                            className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                            style={{
                              border: '1px solid var(--color-border)',
                              color: 'var(--color-text)',
                            }}
                          >
                            {billingBusy ? 'Opening…' : 'Manage Subscription'}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {billingError && (
                  <div
                    className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
                    style={{
                      background: dark ? '#2e0f0f' : '#fef2f2',
                      color: '#dc2626',
                      border: '1px solid #dc262633',
                    }}
                  >
                    <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                    <span>{billingError}</span>
                  </div>
                )}

                <div className="text-[11px]" style={{ color: 'var(--color-muted)' }}>
                  Billing is handled securely by Stripe. We never see or store your
                  card details.
                </div>
              </div>
            )}

            {tab === 'usage' && (
              <div className="space-y-5">
                <div>
                  <h3
                    className="font-semibold text-base mb-1"
                    style={{ color: 'var(--color-text)' }}
                  >
                    Usage
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--color-muted)' }}>
                    Track how many vehicle analyses you've run today.
                  </p>
                </div>

                {admin ? (
                  <div
                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium"
                    style={{
                      background: dark ? '#1a2e1a' : '#f0fdf4',
                      border: '1px solid #16a34a',
                      color: '#16a34a',
                    }}
                  >
                    <Shield size={14} />
                    Admin — No usage limits apply
                  </div>
                ) : (
                  <div
                    className="rounded-xl p-4"
                    style={{
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <div
                      className="flex justify-between text-sm mb-2"
                      style={{ color: 'var(--color-muted)' }}
                    >
                      <span>Prompts used</span>
                      <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                        {used} / {limit === Infinity ? '∞' : limit}
                      </span>
                    </div>
                    <div
                      className="w-full h-2 rounded-full overflow-hidden"
                      style={{ background: 'var(--color-border)' }}
                    >
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          background: pct > 80 ? '#c0392b' : '#2563eb',
                        }}
                      />
                    </div>
                    {userDoc?.plan === 'free' && (
                      <p
                        className="text-xs mt-2.5"
                        style={{ color: 'var(--color-muted)' }}
                      >
                        Resets daily. Upgrade for more prompts.
                      </p>
                    )}
                  </div>
                )}
                <div
                  className="rounded-xl p-3 text-sm"
                  style={{
                    background: 'var(--color-bg)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-muted)',
                  }}
                >
                  Current plan:{' '}
                  <span
                    className="font-semibold capitalize"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {admin ? 'Admin (Unlimited)' : userDoc?.plan || 'free'}
                  </span>
                </div>
              </div>
            )}

            {tab === 'memory' && (
              <div className="space-y-5">
                <div>
                  <h3
                    className="font-semibold text-base mb-1"
                    style={{ color: 'var(--color-text)' }}
                  >
                    Memory & Preferences
                  </h3>
                  <p className="text-xs" style={{ color: 'var(--color-muted)' }}>
                    VinCritiq remembers what you care about across analyses —
                    budget, body style, mileage tolerance.
                  </p>
                </div>
                {userDoc?.preferences && Object.keys(userDoc.preferences).length > 0 ? (
                  <div
                    className="rounded-xl p-3"
                    style={{
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <pre
                      className="text-xs overflow-auto"
                      style={{
                        color: 'var(--color-muted)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {JSON.stringify(userDoc.preferences, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--color-muted)' }}>
                    No preferences stored yet. VinCritiq learns your preferences as
                    you analyze vehicles.
                  </p>
                )}
                <button
                  onClick={clearMemory}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-all hover:bg-red-500/10"
                  style={{ border: '1px solid #c0392b', color: '#c0392b' }}
                >
                  Clear All Memory
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
