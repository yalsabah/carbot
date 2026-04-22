import React, { useState } from 'react';
import { X, User, CreditCard, BarChart2, Brain, Check, Shield } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { doc, updateDoc, deleteField } from 'firebase/firestore';
import { db } from '../firebase/config';
import { PLANS, isAdmin } from '../utils/usage';
import { useTheme } from '../contexts/ThemeContext';

const TABS = [
  { id: 'personal', label: 'Personal', icon: User },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'usage', label: 'Usage', icon: BarChart2 },
  { id: 'memory', label: 'Memory', icon: Brain },
];

export default function SettingsModal({ onClose }) {
  const { user, userDoc, logout, refreshUserDoc } = useAuth();
  const { dark } = useTheme();
  const admin = isAdmin(user?.email);
  const [tab, setTab] = useState('personal');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState(userDoc?.displayName || '');

  const saveName = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { displayName: name });
      await refreshUserDoc();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <h2 className="font-bold text-base" style={{ color: 'var(--color-text)' }}>Settings</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10">
            <X size={18} style={{ color: 'var(--color-muted)' }} />
          </button>
        </div>

        <div className="flex">
          {/* Tabs */}
          <div className="w-36 p-3 space-y-0.5 flex-shrink-0" style={{ borderRight: '1px solid var(--color-border)' }}>
            {TABS.map(t => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-all"
                  style={{
                    background: tab === t.id ? 'var(--color-bg)' : 'transparent',
                    color: tab === t.id ? 'var(--color-text)' : 'var(--color-muted)',
                    fontWeight: tab === t.id ? 600 : 400,
                  }}
                >
                  <Icon size={14} />
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div className="flex-1 p-5 min-h-72">
            {tab === 'personal' && (
              <div className="space-y-4">
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Personal Information</h3>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-muted)' }}>Display Name</label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: 'var(--color-muted)' }}>Email</label>
                  <input
                    value={user?.email || ''}
                    readOnly
                    className="w-full px-3 py-2 rounded-lg text-sm opacity-60"
                    style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-text)' }}
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={saveName}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-all"
                  >
                    {saved ? <Check size={14} /> : null}
                    {saved ? 'Saved!' : saving ? 'Saving…' : 'Save Changes'}
                  </button>
                  <button
                    onClick={async () => { await logout(); onClose(); }}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={{ border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            )}

            {tab === 'billing' && (
              <div className="space-y-3">
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Billing & Plan</h3>
                {admin && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium" style={{ background: dark ? '#1a2e1a' : '#f0fdf4', border: '1px solid #16a34a', color: '#16a34a' }}>
                    <Shield size={14} />
                    Admin — Unlimited access, no quota
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {PLANS.map(plan => {
                    const isCurrent = admin ? plan.id === 'unlimited' : userDoc?.plan === plan.id;
                    return (
                      <div
                        key={plan.id}
                        className="rounded-xl p-3 transition-all"
                        style={{
                          border: isCurrent ? '2px solid #2563eb' : '1px solid var(--color-border)',
                          background: isCurrent ? (dark ? '#1e3a5f' : '#eff6ff') : 'var(--color-bg)',
                          opacity: plan.id !== 'free' && !isCurrent ? 0.75 : 1,
                        }}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>{plan.name}</span>
                          {isCurrent && <span className="text-xs text-blue-400 font-bold">Current</span>}
                        </div>
                        <div className="text-lg font-bold mb-0.5" style={{ color: 'var(--color-text)' }}>{plan.price}</div>
                        <div className="text-xs mb-2" style={{ color: 'var(--color-muted)' }}>{plan.prompts} · {plan.description}</div>
                        {plan.id !== 'free' && !isCurrent && (
                          <button className="w-full py-1 rounded-lg text-xs font-medium text-white bg-blue-600 opacity-60 cursor-not-allowed">
                            Upgrade (Coming Soon)
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {tab === 'usage' && (
              <div className="space-y-4">
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Usage</h3>
                {admin ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium" style={{ background: dark ? '#1a2e1a' : '#f0fdf4', border: '1px solid #16a34a', color: '#16a34a' }}>
                    <Shield size={14} />
                    Admin — No usage limits apply
                  </div>
                ) : (
                  <div>
                    <div className="flex justify-between text-sm mb-2" style={{ color: 'var(--color-muted)' }}>
                      <span>Prompts used</span>
                      <span>{used} / {limit === Infinity ? '∞' : limit}</span>
                    </div>
                    <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, background: pct > 80 ? '#c0392b' : '#2563eb' }}
                      />
                    </div>
                    {userDoc?.plan === 'free' && (
                      <p className="text-xs mt-2" style={{ color: 'var(--color-muted)' }}>Resets daily. Upgrade for more prompts.</p>
                    )}
                  </div>
                )}
                <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}>
                  Current plan: <span className="font-semibold capitalize" style={{ color: 'var(--color-text)' }}>{admin ? 'Admin (Unlimited)' : userDoc?.plan || 'free'}</span>
                </div>
              </div>
            )}

            {tab === 'memory' && (
              <div className="space-y-4">
                <h3 className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>Memory & Preferences</h3>
                {userDoc?.preferences && Object.keys(userDoc.preferences).length > 0 ? (
                  <div className="rounded-xl p-3" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                    <pre className="text-xs overflow-auto" style={{ color: 'var(--color-muted)', whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(userDoc.preferences, null, 2)}
                    </pre>
                  </div>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--color-muted)' }}>No preferences stored yet. CarBot learns your preferences as you analyze vehicles.</p>
                )}
                <button
                  onClick={clearMemory}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
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
