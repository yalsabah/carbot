import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  MessageSquare,
  Trash2,
  Sun,
  Moon,
  User,
  Car,
  PanelLeft,
  PanelLeftClose,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';

const COLLAPSED_WIDTH = 56;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 280;
const STORAGE_KEY = 'vincritiq.sidebar.width';

function readStoredWidth() {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
}

export default function Sidebar({ onOpenSettings, onOpenAuth, collapsed, onToggle }) {
  const { user, userDoc } = useAuth();
  const { sessions, activeSessionId, loadSessions, loadSession, deleteSession, startNewChat } = useChat();
  const { dark, toggle } = useTheme();
  const [hoverId, setHoverId] = useState(null);
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (user) loadSessions();
  }, [user, loadSessions]);

  // Persist width whenever it changes (and we're not mid-drag spamming setItem)
  useEffect(() => {
    if (resizing) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(width));
    } catch {}
  }, [width, resizing]);

  // Drag-to-resize handlers
  const onResizeStart = useCallback((e) => {
    if (collapsed) return;
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = width;
    setResizing(true);
  }, [collapsed, width]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e) => {
      const delta = e.clientX - startXRef.current;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
      setWidth(next);
    };
    const onUp = () => setResizing(false);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  const effectiveWidth = collapsed ? COLLAPSED_WIDTH : width;

  return (
    <div
      className="flex flex-col h-full relative"
      style={{
        width: effectiveWidth,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        flexShrink: 0,
        transition: resizing ? 'none' : 'width 200ms ease',
      }}
    >
      {/* Header */}
      <div
        className="px-3 py-3 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--color-border)', minHeight: 56 }}
      >
        {collapsed ? (
          <button
            onClick={onToggle}
            className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors hover:opacity-80"
            style={{ color: 'var(--color-muted)' }}
            title="Open sidebar"
            aria-label="Open sidebar"
          >
            <PanelLeft size={18} />
          </button>
        ) : (
          <>
            <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
              <Car size={16} className="text-white" />
            </div>
            <span className="font-bold text-base flex-1 truncate" style={{ color: 'var(--color-text)' }}>
              VinCritiq
            </span>
            <button
              onClick={onToggle}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:opacity-80"
              style={{ color: 'var(--color-muted)' }}
              title="Close sidebar"
              aria-label="Close sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          </>
        )}
      </div>

      {/* New chat */}
      <div className="p-3">
        <button
          onClick={startNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
          style={{ background: 'var(--color-accent)', color: '#fff', justifyContent: collapsed ? 'center' : 'flex-start' }}
          title="New Assessment"
        >
          <Plus size={16} />
          {!collapsed && 'New Assessment'}
        </button>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
        {!collapsed && sessions.length > 0 && (
          <p className="px-2 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            History
          </p>
        )}
        {!collapsed && sessions.map(s => (
          <div
            key={s.id}
            onMouseEnter={() => setHoverId(s.id)}
            onMouseLeave={() => setHoverId(null)}
            className="group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all"
            style={{
              background: activeSessionId === s.id ? 'var(--color-bg)' : 'transparent',
              color: 'var(--color-text)',
            }}
            onClick={() => loadSession(s.id)}
          >
            <MessageSquare size={14} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
            <span className="text-sm flex-1 truncate">{s.title || 'Assessment'}</span>
            {hoverId === s.id && (
              <button
                onClick={e => { e.stopPropagation(); deleteSession(s.id); }}
                className="opacity-60 hover:opacity-100 transition-opacity"
              >
                <Trash2 size={12} style={{ color: 'var(--color-muted)' }} />
              </button>
            )}
          </div>
        ))}
        {!collapsed && user && sessions.length === 0 && (
          <p className="px-2 py-4 text-xs text-center" style={{ color: 'var(--color-muted)' }}>No assessments yet</p>
        )}
        {!collapsed && !user && (
          <p className="px-2 py-4 text-xs text-center" style={{ color: 'var(--color-muted)' }}>Sign in to save history</p>
        )}
      </div>

      {/* Bottom controls */}
      <div className="p-3 space-y-1" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          onClick={toggle}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
          style={{ color: 'var(--color-muted)', justifyContent: collapsed ? 'center' : 'flex-start' }}
          title={dark ? 'Light mode' : 'Dark mode'}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
          {!collapsed && (dark ? 'Light mode' : 'Dark mode')}
        </button>

        {user ? (
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: 'var(--color-text)', justifyContent: collapsed ? 'center' : 'flex-start' }}
            title="Settings"
          >
            <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {(userDoc?.displayName || user.email || 'U')[0].toUpperCase()}
            </div>
            {!collapsed && (
              <span className="truncate text-sm">{userDoc?.displayName || user.email}</span>
            )}
          </button>
        ) : (
          <button
            onClick={onOpenAuth}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: 'var(--color-muted)', justifyContent: collapsed ? 'center' : 'flex-start' }}
            title="Sign in"
          >
            <User size={16} />
            {!collapsed && 'Sign in'}
          </button>
        )}
      </div>

      {/* Drag handle (right edge) — hidden when collapsed */}
      {!collapsed && (
        <div
          onMouseDown={onResizeStart}
          className="absolute top-0 right-0 h-full"
          style={{
            width: 6,
            transform: 'translateX(50%)',
            cursor: 'col-resize',
            zIndex: 10,
          }}
          aria-label="Resize sidebar"
          role="separator"
        >
          <div
            className="h-full mx-auto transition-colors"
            style={{
              width: 2,
              background: resizing ? 'var(--color-accent)' : 'transparent',
            }}
          />
        </div>
      )}
    </div>
  );
}
