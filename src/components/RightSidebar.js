import React, { useMemo } from 'react';
import {
  PanelRightClose,
  PanelRightOpen,
  FileText,
  Image as ImageIcon,
  Coins,
  Gauge,
  Sparkles,
} from 'lucide-react';
import { aggregateContextStats, CLAUDE_CONTEXT_WINDOW } from '../utils/contextStats';
import { formatUsd } from '../utils/pricing';

// Right-hand companion sidebar for the chat. Shows:
//   - All files attached across the current session (PDFs + image thumbnails)
//   - Token usage running totals
//   - "Reaching context limit" warning when input fill gets close to Claude's
//     200k window
//   - Compact Chat button (runs /compact without typing)
//
// Collapses to a thin rail by default on narrow viewports — driven by the
// `collapsed` prop owned by App.js so the layout flexbox knows the width.

function fmtNum(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function FilesPanel({ messages, onPreviewImage }) {
  // Walk every message in order; collect attachments. Prefer the in-session
  // _attachments array (real data URLs); fall back to the textual `files`
  // chips for messages loaded from history.
  const items = useMemo(() => {
    const collected = [];
    for (const m of messages) {
      const list = Array.isArray(m._attachments) && m._attachments.length > 0
        ? m._attachments
        : (Array.isArray(m.files) ? m.files.map((f) => ({
            kind: typeof f === 'string' && f.includes('📄') ? 'pdf' : 'image',
            name: typeof f === 'string' ? f.replace(/^[^a-zA-Z0-9]*\s*/, '') : 'file',
            dataUrl: null,
          })) : []);
      for (const a of list) collected.push({ ...a, msgId: m.id });
    }
    return collected;
  }, [messages]);

  const pdfs = items.filter((i) => i.kind === 'pdf');
  const imgs = items.filter((i) => i.kind === 'image');

  if (items.length === 0) {
    return (
      <div className="text-xs px-3 py-4 text-center" style={{ color: 'var(--color-muted)' }}>
        No files attached yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {imgs.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5 px-1" style={{ color: 'var(--color-muted)' }}>
            Images ({imgs.length})
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {imgs.map((img, i) => (
              <button
                key={i}
                onClick={() => img.dataUrl && onPreviewImage?.(img.dataUrl)}
                title={img.name}
                disabled={!img.dataUrl}
                className="rounded-md overflow-hidden transition-transform hover:scale-105 disabled:cursor-not-allowed"
                style={{
                  aspectRatio: '1 / 1',
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg)',
                  padding: 0,
                  cursor: img.dataUrl ? 'zoom-in' : 'default',
                  opacity: img.dataUrl ? 1 : 0.6,
                }}
              >
                {img.dataUrl ? (
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <ImageIcon size={14} style={{ color: 'var(--color-muted)' }} />
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {pdfs.length > 0 && (
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5 px-1" style={{ color: 'var(--color-muted)' }}>
            Documents ({pdfs.length})
          </div>
          <div className="space-y-1">
            {pdfs.map((p, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md"
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}
                title={p.name}
              >
                <FileText size={12} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContextMeter({ stats, onCompact, isCompacting }) {
  const pct = Math.round(stats.contextPct * 100);
  const barColor = stats.nearLimit ? '#dc2626' : pct > 40 ? '#b7550c' : '#16a34a';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
          Context window
        </span>
        <span className="font-mono" style={{ color: 'var(--color-muted)' }}>
          {pct}%
        </span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-bg)' }}>
        <div
          style={{
            width: `${Math.max(2, pct)}%`,
            height: '100%',
            background: barColor,
            transition: 'width 0.3s, background 0.3s',
          }}
        />
      </div>
      <div className="text-[10px] flex items-center justify-between" style={{ color: 'var(--color-muted)' }}>
        <span>Latest input: {fmtNum(stats.contextPct * CLAUDE_CONTEXT_WINDOW)} tok</span>
        <span>Limit: {fmtNum(CLAUDE_CONTEXT_WINDOW)}</span>
      </div>

      {stats.nearLimit && (
        <div
          className="rounded-lg p-2 text-[11px] leading-relaxed"
          style={{
            background: 'rgba(220, 38, 38, 0.08)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            color: '#dc2626',
          }}
        >
          Reaching context limit. Compact the chat to keep responses fast.
        </div>
      )}

      <button
        onClick={onCompact}
        disabled={isCompacting}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        style={{
          background: stats.nearLimit ? 'var(--color-accent)' : 'var(--color-bg)',
          color: stats.nearLimit ? '#fff' : 'var(--color-text)',
          border: '1px solid var(--color-border)',
        }}
      >
        <Sparkles size={12} />
        {isCompacting ? 'Compacting…' : 'Compact Chat'}
      </button>
      <div className="text-[10px] text-center" style={{ color: 'var(--color-muted)' }}>
        Or send <code>/compact</code> in chat.
      </div>
    </div>
  );
}

export default function RightSidebar({
  messages,
  collapsed,
  onToggle,
  onPreviewImage,
  onCompact,
  isCompacting,
}) {
  const stats = useMemo(() => aggregateContextStats(messages), [messages]);

  if (collapsed) {
    return (
      <aside
        className="flex flex-col items-center py-3 flex-shrink-0"
        style={{
          width: 44,
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
        }}
      >
        <button
          onClick={onToggle}
          title="Show side panel"
          aria-label="Show side panel"
          className="p-1.5 rounded-lg hover:opacity-80 transition-opacity"
          style={{ color: 'var(--color-muted)' }}
        >
          <PanelRightOpen size={16} />
        </button>
        {stats.nearLimit && (
          <div
            title="Context near limit"
            className="mt-3 w-2 h-2 rounded-full"
            style={{ background: '#dc2626' }}
          />
        )}
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col flex-shrink-0 overflow-hidden"
      style={{
        width: 280,
        background: 'var(--color-surface)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
          Session
        </div>
        <button
          onClick={onToggle}
          title="Hide side panel"
          aria-label="Hide side panel"
          className="p-1 rounded-md hover:opacity-80 transition-opacity"
          style={{ color: 'var(--color-muted)' }}
        >
          <PanelRightClose size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Tokens & cost */}
        <section>
          <div
            className="text-[10px] font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5"
            style={{ color: 'var(--color-muted)' }}
          >
            <Gauge size={11} /> Tokens spent
          </div>
          <div
            className="rounded-lg p-3 space-y-1"
            style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}
          >
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--color-muted)' }}>Input</span>
              <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                {fmtNum(stats.inputTokens)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: 'var(--color-muted)' }}>Output</span>
              <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                {fmtNum(stats.outputTokens)}
              </span>
            </div>
            <div
              className="flex items-center justify-between text-xs pt-1.5 mt-1.5 font-semibold"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <span style={{ color: 'var(--color-text)' }} className="flex items-center gap-1">
                <Coins size={11} /> Cost
              </span>
              <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                {formatUsd(stats.totalCostUsd)}
              </span>
            </div>
          </div>
        </section>

        {/* Context meter + compact */}
        <section>
          <ContextMeter stats={stats} onCompact={onCompact} isCompacting={isCompacting} />
        </section>

        {/* Files */}
        <section>
          <div
            className="text-[10px] font-bold uppercase tracking-wider mb-2"
            style={{ color: 'var(--color-muted)' }}
          >
            Attachments
          </div>
          <FilesPanel messages={messages} onPreviewImage={onPreviewImage} />
        </section>
      </div>
    </aside>
  );
}
