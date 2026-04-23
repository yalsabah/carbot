import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
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
  const autoResumedRef = useRef(false);

  // Reset auto-resume on sign-out/user switch so a subsequent sign-in resumes correctly.
  useEffect(() => {
    if (!user) autoResumedRef.current = false;
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

  const loadSessions = useCallback(async () => {
    if (!user) return;
    setLoadingSessions(true);
    try {
      const snap = await getDocs(collection(db, 'users', user.uid, 'sessions'));
      const sorted = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = a.updatedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0;
          const tb = b.updatedAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
      setSessions(sorted);

      // On first load after sign-in / page refresh, resume the most recent session
      // so the user lands where they left off instead of a blank new chat.
      if (!autoResumedRef.current && sorted.length > 0) {
        autoResumedRef.current = true;
        await loadSession(sorted[0].id);
      }
    } catch (err) {
      console.error('loadSessions: Firestore read failed', err);
    } finally {
      setLoadingSessions(false);
    }
  }, [user, loadSession]);

  // Firestore rejects `undefined` values — strip large/ephemeral fields and any undefined entries.
  // Drops: isStreaming (transient), steps (transient UI), _img64/_imgMt (too large for Firestore 1MB doc limit).
  // Keeps: _carfaxText (usually <50KB, needed for regenerate) and report (needed to re-open modal from history).
  const sanitizeForFirestore = (message) => {
    const { isStreaming, steps, _img64, _imgMt, ...rest } = message;
    const clean = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) clean[k] = v;
    }
    return clean;
  };

  const addMessage = useCallback(async (sessionId, message) => {
    const optimistic = { ...message, id: Date.now().toString() };
    setMessages(prev => [...prev, optimistic]);

    // Never persist streaming placeholders — they'll be saved when streaming ends
    if (message.isStreaming) return;

    if (user && sessionId && !sessionId.startsWith('local-')) {
      try {
        const ref = await addDoc(
          collection(db, 'users', user.uid, 'sessions', sessionId, 'messages'),
          { ...sanitizeForFirestore(message), createdAt: serverTimestamp() }
        );
        await updateDoc(doc(db, 'users', user.uid, 'sessions', sessionId), {
          updatedAt: serverTimestamp(),
          ...(message.role === 'user' && message.text ? { title: message.text.slice(0, 50) } : {}),
        });
        setMessages(prev => prev.map(m => m.id === optimistic.id ? { ...m, id: ref.id } : m));
      } catch (err) {
        console.error('addMessage: Firestore write failed', err);
      }
    }
  }, [user]);

  // Called after streaming completes to persist the final assistant message
  const persistLastMessage = useCallback(async (sessionId, message) => {
    if (!user || !sessionId || sessionId.startsWith('local-')) return;
    try {
      await addDoc(
        collection(db, 'users', user.uid, 'sessions', sessionId, 'messages'),
        { ...sanitizeForFirestore(message), createdAt: serverTimestamp() }
      );
      await updateDoc(doc(db, 'users', user.uid, 'sessions', sessionId), { updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('persistLastMessage: Firestore write failed', err);
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
