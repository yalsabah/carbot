import React from 'react';
import { X, Zap } from 'lucide-react';
import { PLANS } from '../utils/usage';

export default function UpgradeModal({ onClose, onSignIn }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <button onClick={onClose} className="absolute top-4 right-4 p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10">
          <X size={18} style={{ color: 'var(--color-muted)' }} />
        </button>

        <div className="text-center mb-5">
          <div className="w-12 h-12 rounded-2xl bg-orange-100 flex items-center justify-center mx-auto mb-3">
            <Zap size={22} className="text-orange-500" />
          </div>
          <h2 className="font-bold text-lg mb-1" style={{ color: 'var(--color-text)' }}>You've reached your limit</h2>
          <p className="text-sm" style={{ color: 'var(--color-muted)' }}>
            Upgrade to continue analyzing vehicle deals with CarBot.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-2 mb-4">
          {PLANS.filter(p => p.id !== 'free').map(plan => (
            <div
              key={plan.id}
              className="flex items-center justify-between rounded-xl px-4 py-3 transition-all"
              style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
            >
              <div>
                <div className="font-semibold text-sm" style={{ color: 'var(--color-text)' }}>{plan.name}</div>
                <div className="text-xs" style={{ color: 'var(--color-muted)' }}>{plan.prompts} · {plan.description}</div>
              </div>
              <div className="text-right">
                <div className="font-bold text-sm" style={{ color: 'var(--color-text)' }}>{plan.price}</div>
                <button
                  className="text-xs text-blue-500 opacity-60 cursor-not-allowed"
                  disabled
                >
                  Coming soon
                </button>
              </div>
            </div>
          ))}
        </div>

        {onSignIn && (
          <div className="text-center">
            <p className="text-sm mb-2" style={{ color: 'var(--color-muted)' }}>Already have an account?</p>
            <button
              onClick={onSignIn}
              className="text-blue-500 text-sm font-medium hover:underline"
            >
              Sign in for more prompts
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
