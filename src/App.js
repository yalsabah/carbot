import React, { useState, useRef, useEffect } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import { recoverPendingJobs } from './utils/model3d';
import { ThemeProvider } from './contexts/ThemeContext';
import { ChatProvider, useChat } from './contexts/ChatContext';
import Sidebar from './components/Sidebar';
import ChatInterface from './components/ChatInterface';
import RightSidebar from './components/RightSidebar';
import AuthModal from './components/AuthModal';
import SettingsModal from './components/SettingsModal';
import UpgradeModal from './components/UpgradeModal';

function AppInner() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [previewImage, setPreviewImage] = useState(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const { messages } = useChat();

  // ChatInterface exposes a triggerCompact function via this ref so the
  // sidebar's "Compact Chat" button can invoke the same code path as typing
  // /compact in the input.
  const compactTriggerRef = useRef(null);

  // On boot, recover any Tripo 3D jobs that were in-flight when the user
  // refreshed/closed the tab. This polls each saved task_id and persists
  // the result so we never waste a paid-for Tripo generation.
  useEffect(() => {
    recoverPendingJobs().catch(() => {});
  }, []);

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
          compactTriggerRef={compactTriggerRef}
          onCompactingChange={setIsCompacting}
        />
      </div>

      <RightSidebar
        messages={messages}
        collapsed={rightSidebarCollapsed}
        onToggle={() => setRightSidebarCollapsed((c) => !c)}
        onPreviewImage={(url) => setPreviewImage(url)}
        onCompact={() => compactTriggerRef.current && compactTriggerRef.current()}
        isCompacting={isCompacting}
      />

      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          className="fixed inset-0 z-[80] flex items-center justify-center cursor-zoom-out"
          style={{ background: 'rgba(0,0,0,0.9)', backdropFilter: 'blur(8px)' }}
          role="dialog"
          aria-label="Image preview"
        >
          <img
            src={previewImage}
            alt="Attached"
            className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
            style={{ objectFit: 'contain' }}
          />
        </div>
      )}

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
