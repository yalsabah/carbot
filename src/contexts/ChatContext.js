import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import {
  collection, addDoc, updateDoc, doc, serverTimestamp, getDocs, deleteDoc,
  increment, arrayUnion, arrayRemove, getDoc, setDoc, Timestamp
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

  // Called after streaming completes to persist the final assistant message.
  // Returns the new doc ID (or null if not persisted) so callers can update
  // the message later — e.g. to attach 3D-generation cost once it lands.
  const persistLastMessage = useCallback(async (sessionId, message) => {
    if (!user || !sessionId || sessionId.startsWith('local-')) return null;
    try {
      const ref = await addDoc(
        collection(db, 'users', user.uid, 'sessions', sessionId, 'messages'),
        { ...sanitizeForFirestore(message), createdAt: serverTimestamp() }
      );
      await updateDoc(doc(db, 'users', user.uid, 'sessions', sessionId), { updatedAt: serverTimestamp() });
      return ref.id;
    } catch (err) {
      console.error('persistLastMessage: Firestore write failed', err);
      return null;
    }
  }, [user]);

  // Patch a single field (or several) on a previously-persisted assistant
  // message. Used to refresh `totalCost` once 3D generation finishes after
  // the message was already saved.
  const updateMessage = useCallback(async (sessionId, messageId, patch) => {
    if (!user || !sessionId || !messageId) return;
    if (sessionId.startsWith('local-')) return;
    try {
      const clean = {};
      for (const [k, v] of Object.entries(patch || {})) {
        if (v !== undefined) clean[k] = v;
      }
      if (Object.keys(clean).length === 0) return;
      await updateDoc(
        doc(db, 'users', user.uid, 'sessions', sessionId, 'messages', messageId),
        clean
      );
    } catch (err) {
      console.error('updateMessage: Firestore write failed', err);
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

  // Record a thumbs-up / thumbs-down on an assistant message.
  // value: 'up' | 'down' | null  (null clears any existing vote)
  // Maintains:
  //   - per-message: messages/{id}.feedback + feedbackAt
  //   - per-user aggregate at users/{uid}.feedback = {
  //       thumbsUp:   { count, messages: [{ id, sessionId, preview, at }, ...] },
  //       thumbsDown: { count, messages: [...] },
  //     }
  // Toggle-aware: re-clicking the same vote clears it; switching sides
  // moves the entry from one list/counter to the other atomically.
  const recordFeedback = useCallback(async (sessionId, messageId, value) => {
    if (!messageId) return;
    const next = value === 'up' || value === 'down' ? value : null;

    // Find the message + previous feedback in local state (optimistic source of truth)
    let prev = null;
    let messageText = '';
    setMessages(curr => {
      const found = curr.find(m => m.id === messageId);
      if (found) {
        prev = found.feedback || null;
        messageText = (found.text || found.content || '').replace(/<REPORT>[\s\S]*?<\/REPORT>/g, '').trim();
      }
      return curr.map(m => m.id === messageId ? { ...m, feedback: next } : m);
    });

    if (prev === next) return;
    if (!user) return; // anonymous: optimistic-only, nothing to persist

    // Persist on the message itself (only if it lives in Firestore)
    if (sessionId && !sessionId.startsWith('local-') && !messageId.toString().match(/^\d+$/)) {
      try {
        await updateDoc(
          doc(db, 'users', user.uid, 'sessions', sessionId, 'messages', messageId),
          { feedback: next, feedbackAt: serverTimestamp() }
        );
      } catch (err) {
        console.error('recordFeedback: per-message write failed', err);
      }
    }

    // Update the per-user aggregate. We use a fixed-shape entry so arrayRemove
    // can match exactly (Firestore array elements must be deeply equal).
    // For arrayRemove to work after a later add, we must use a stable timestamp,
    // not serverTimestamp() (which resolves to different values on add vs remove).
    try {
      const userRef = doc(db, 'users', user.uid);
      const preview = messageText.slice(0, 120);

      // We need a stable entry to write/remove. We read the doc once to find any
      // existing entry for this messageId so removes match exactly.
      const snap = await getDoc(userRef);
      const fbDoc = snap.exists() ? (snap.data().feedback || {}) : {};
      const upList = Array.isArray(fbDoc.thumbsUp?.messages) ? fbDoc.thumbsUp.messages : [];
      const downList = Array.isArray(fbDoc.thumbsDown?.messages) ? fbDoc.thumbsDown.messages : [];

      const existingUp = upList.find(e => e.id === messageId) || null;
      const existingDown = downList.find(e => e.id === messageId) || null;

      const updates = {};
      const newEntry = { id: messageId, sessionId: sessionId || null, preview, at: Timestamp.now() };

      if (prev === 'up' && existingUp) {
        updates['feedback.thumbsUp.messages'] = arrayRemove(existingUp);
        updates['feedback.thumbsUp.count'] = increment(-1);
      }
      if (prev === 'down' && existingDown) {
        updates['feedback.thumbsDown.messages'] = arrayRemove(existingDown);
        updates['feedback.thumbsDown.count'] = increment(-1);
      }
      if (next === 'up' && !existingUp) {
        updates['feedback.thumbsUp.messages'] = arrayUnion(newEntry);
        updates['feedback.thumbsUp.count'] = increment(1);
      }
      if (next === 'down' && !existingDown) {
        updates['feedback.thumbsDown.messages'] = arrayUnion(newEntry);
        updates['feedback.thumbsDown.count'] = increment(1);
      }

      // Firestore disallows a single update touching the same field with both
      // arrayUnion AND arrayRemove. Our toggle/switch logic only ever hits each
      // list with one operation per call, so this is safe — but if the doc
      // doesn't have the parent map yet, ensure it exists first.
      if (!snap.exists() || !snap.data().feedback) {
        await setDoc(userRef, {
          feedback: {
            thumbsUp:   { count: 0, messages: [] },
            thumbsDown: { count: 0, messages: [] },
          },
        }, { merge: true });
      }

      if (Object.keys(updates).length > 0) {
        await updateDoc(userRef, updates);
      }
    } catch (err) {
      console.error('recordFeedback: aggregate write failed', err);
    }
  }, [user, setMessages]);

  return (
    <ChatContext.Provider value={{
      sessions, activeSessionId, messages, loadingSessions,
      loadSessions, createSession, loadSession, addMessage, persistLastMessage,
      updateLastMessage, updateMessage, deleteSession, startNewChat, setMessages,
      recordFeedback,
    }}>
      {children}
    </ChatContext.Provider>
  );
}
