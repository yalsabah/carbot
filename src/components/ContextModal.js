import React from 'react';
import { X, Zap, MessageSquare } from 'lucide-react';

export default function ContextModal({ onAddContext, onBeginAnalysis, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-sm rounded-2xl p-6 shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <button onClick={onClose} className="absolute top-4 right-4 p-1 rounded-lg hover:bg-black/10 dark:hover:bg-white/10">
          <X size={18} style={{ color: 'var(--color-muted)' }} />
        </button>

        <h2 className="font-bold text-base mb-1" style={{ color: 'var(--color-text)' }}>Files ready</h2>
        <p className="text-sm mb-5" style={{ color: 'var(--color-muted)' }}>
          Both files are uploaded. Would you like to add more context before analysis?
        </p>

        <div className="space-y-2">
          <button
            onClick={onAddContext}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text)', background: 'var(--color-bg)' }}
          >
            <MessageSquare size={16} style={{ color: 'var(--color-muted)' }} />
            <div className="text-left">
              <div className="font-medium">Add more context</div>
              <div className="text-xs" style={{ color: 'var(--color-muted)' }}>Provide asking price, APR, loan term, etc.</div>
            </div>
          </button>
          <button
            onClick={onBeginAnalysis}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm transition-all text-white bg-blue-600 hover:bg-blue-700"
          >
            <Zap size={16} />
            <div className="text-left">
              <div className="font-medium">Begin Analysis</div>
              <div className="text-xs opacity-80">Analyze with uploaded files now</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
