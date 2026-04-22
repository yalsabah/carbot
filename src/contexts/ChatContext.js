import React, { createContext, useContext, useState, useCallback } from 'react';
import {
  collection, addDoc, updateDoc, doc, serverTimestamp, getDocs, deleteDoc
} from 'firebase/firestore';
import { db } from '../firebase/config';
import { useAuth } from './AuthContext';

const ChatContext = createContext(null);
export const useChat = () => useContext(ChatContext);

export function ChatProvider({ children }) {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  const loadSessions = useCallback(async () => {
    if (!user) return;
    setLoadingSessions(true);
    try {
      // Use simple collection read (no orderBy) to avoid requiring a Firestore composite index.
      // Sort by updatedAt/createdAt client-side instead.
      const snap = await getDocs(collection(db, 'users', user.uid, 'sessions'));
      const sorted = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = a.updatedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;
          const tb = b.updatedAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
      setSessions(sorted);
    } catch {
      // Firestore offline — silently skip
    } finally {
      setLoadingSessions(false);
    }
  }, [user]);

  const createSession = useCallback(async (title = 'New Assessment') => {
    const localId = `local-${Date.now()}`;
    const newSession = { id: localId, title };
    setSessions(prev => [newSession, ...prev]);
    setActiveSessionId(localId);
    setMessages([]);

    if (user) {
      try {
        const ref = await addDoc(collection(db, 'users', user.uid, 'sessions'), {
          title,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        setSessions(prev => prev.map(s => s.id === localId ? { ...s, id: ref.id } : s));
        setActiveSessionId(ref.id);
        return ref.id;
      } catch {
        // Firestore offline — keep local session
      }
    }
    return localId;
  }, [user]);

  const loadSession = useCallback(async (sessionId) => {
    if (!user) return;
    setActiveSessionId(sessionId);
    try {
      const snap = await getDocs(
        collection(db, 'users', user.uid, 'sessions', sessionId, 'messages')
      );
      const msgs = snap.docs
        .map(d => ({ id: d.id, ...d.data(), isStreaming: false }))
        .filter(m => !(m.role === 'assistant' && !m.text))
        .sort((a, b) => {
          const ta = a.createdAt?.toMillis?.() ?? 0;
          const tb = b.createdAt?.toMillis?.() ?? 0;
          return ta - tb;
        });
      setMessages(msgs);
    } catch {
      setMessages([]);
    }
  }, [user]);

  const addMessage = useCallback(async (sessionId, message) => {
    const optimistic = { ...message, id: Date.now().toString() };
    setMessages(prev => [...prev, optimistic]);

    // Never persist streaming placeholders — they'll be saved when streaming ends
    if (message.isStreaming) return;

    if (user && sessionId && !sessionId.startsWith('local-')) {
      try {
        const ref = await addDoc(
          collection(db, 'users', user.uid, 'sessions', sessionId, 'messages'),
          { ...message, createdAt: serverTimestamp() }
        );
        await updateDoc(doc(db, 'users', user.uid, 'sessions', sessionId), {
          updatedAt: serverTimestamp(),
          ...(message.role === 'user' && message.text ? { title: message.text.slice(0, 50) } : {}),
        });
        setMessages(prev => prev.map(m => m.id === optimistic.id ? { ...m, id: ref.id } : m));
      } catch {
        // Firestore offline — message stays in local state only
      }
    }
  }, [user]);

  // Called after streaming completes to persist the final assistant message
  const persistLastMessage = useCallback(async (sessionId, message) => {
    if (!user || !sessionId || sessionId.startsWith('local-')) return;
    try {
      await addDoc(
        collection(db, 'users', user.uid, 'sessions', sessionId, 'messages'),
        { ...message, isStreaming: false, steps: undefined, createdAt: serverTimestamp() }
      );
      await updateDoc(doc(db, 'users', user.uid, 'sessions', sessionId), { updatedAt: serverTimestamp() });
    } catch {
      // Firestore offline — skip persistence
    }
  }, [user]);

  const updateLastMessage = useCallback((updater) => {
    setMessages(prev => {
      const copy = [...prev];
      copy[copy.length - 1] = updater(copy[copy.length - 1]);
      return copy;
    });
  }, []);

  const deleteSession = useCallback(async (sessionId) => {
    if (!user) return;
    try { await deleteDoc(doc(db, 'users', user.uid, 'sessions', sessionId)); } catch {}
    setSessions(prev => prev.filter(s => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
    }
  }, [user, activeSessionId]);

  const startNewChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
  }, []);

  return (
    <ChatContext.Provider value={{
      sessions, activeSessionId, messages, loadingSessions,
      loadSessions, createSession, loadSession, addMessage, persistLastMessage,
      updateLastMessage, deleteSession, startNewChat, setMessages,
    }}>
      {children}
    </ChatContext.Provider>
  );
}
