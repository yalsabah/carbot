import React, { useState } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ChatProvider } from './contexts/ChatContext';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import AuthModal from './components/AuthModal';
import SettingsModal from './components/SettingsModal';
import UpgradeModal from './components/UpgradeModal';

function AppInner() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(c => !c)}
        onOpenSettings={() => setShowSettings(true)}
        onOpenAuth={() => setShowAuth(true)}
      />

      <div className="flex-1 overflow-hidden">
        <ChatInterface
          onShowUpgrade={() => setShowUpgrade(true)}
          onShowAuth={() => setShowAuth(true)}
        />
      </div>

      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showUpgrade && (
        <UpgradeModal
          onClose={() => setShowUpgrade(false)}
          onSignIn={() => { setShowUpgrade(false); setShowAuth(true); }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ChatProvider>
          <AppInner />
        </ChatProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
