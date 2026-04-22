import React, { useEffect, useState } from 'react';
import { Plus, MessageSquare, Trash2, Sun, Moon, User, ChevronLeft, ChevronRight, Car } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useChat } from '../contexts/ChatContext';
import { useTheme } from '../contexts/ThemeContext';

export default function Sidebar({ onOpenSettings, onOpenAuth, collapsed, onToggle }) {
  const { user, userDoc } = useAuth();
  const { sessions, activeSessionId, loadSessions, loadSession, deleteSession, startNewChat } = useChat();
  const { dark, toggle } = useTheme();
  const [hoverId, setHoverId] = useState(null);

  useEffect(() => {
    if (user) loadSessions();
  }, [user, loadSessions]);

  return (
    <div
      className="flex flex-col h-full transition-all duration-300 relative"
      style={{
        width: collapsed ? 56 : 260,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        flexShrink: 0,
      }}
    >
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="absolute -right-3 top-6 z-10 w-6 h-6 rounded-full flex items-center justify-center shadow-md transition-colors"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-muted)' }}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Header */}
      <div className="p-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
          <Car size={16} className="text-white" />
        </div>
        {!collapsed && (
          <span className="font-bold text-base" style={{ color: 'var(--color-text)' }}>CarBot</span>
        )}
      </div>

      {/* New chat */}
      <div className="p-3">
        <button
          onClick={startNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
          style={{ background: 'var(--color-accent)', color: '#fff' }}
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
          style={{ color: 'var(--color-muted)' }}
          title={dark ? 'Light mode' : 'Dark mode'}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
          {!collapsed && (dark ? 'Light mode' : 'Dark mode')}
        </button>

        {user ? (
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: 'var(--color-text)' }}
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
            style={{ color: 'var(--color-muted)' }}
            title="Sign in"
          >
            <User size={16} />
            {!collapsed && 'Sign in'}
          </button>
        )}
      </div>
    </div>
  );
}
