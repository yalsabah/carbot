import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Loader } from 'lucide-react';

export default function ThinkingPanel({ steps = [], done = false }) {
  const [open, setOpen] = useState(true);

  if (steps.length === 0) return null;

  return (
    <div
      className="rounded-xl mb-3 overflow-hidden text-xs"
      style={{ border: '1px solid var(--color-border)', background: 'var(--color-bg)' }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left transition-all hover:opacity-80"
        style={{ color: 'var(--color-muted)' }}
      >
        {!done ? (
          <Loader size={12} className="animate-spin flex-shrink-0" style={{ color: 'var(--color-accent)' }} />
        ) : (
          <span style={{ color: '#16a34a', fontSize: 12 }}>✓</span>
        )}
        <span className="flex-1 font-medium" style={{ color: 'var(--color-text)' }}>
          {done ? 'Analysis complete' : 'Analyzing…'}
        </span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-1.5 border-t" style={{ borderColor: 'var(--color-border)' }}>
          {steps.map((step, i) => (
            <div
              key={i}
              className="flex items-start gap-2 pt-1.5"
              style={{
                color: step.status === 'done' ? 'var(--color-muted)'
                  : step.status === 'error' ? '#c0392b'
                  : 'var(--color-text)',
              }}
            >
              <span className="flex-shrink-0 mt-0.5" style={{ width: 14, textAlign: 'center' }}>
                {step.status === 'done' ? '✓'
                  : step.status === 'error' ? '✗'
                  : step.status === 'running' ? <Loader size={10} className="animate-spin inline" style={{ color: 'var(--color-accent)' }} />
                  : '·'}
              </span>
              <span className="leading-snug">{step.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
