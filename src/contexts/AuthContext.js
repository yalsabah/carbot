import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase/config';

const AuthContext = createContext(null);

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [userDoc, setUserDoc] = useState(null);
  const [loading, setLoading] = useState(true);

  const createUserDoc = async (firebaseUser, extraData = {}) => {
    try {
      const ref = doc(db, 'users', firebaseUser.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || extraData.displayName || '',
          plan: 'free',
          promptsUsed: 0,
          promptsLimit: 3,
          lastReset: serverTimestamp(),
          preferences: {},
          createdAt: serverTimestamp(),
          ...extraData,
        });
      }
      const updated = await getDoc(ref);
      setUserDoc(updated.data());
    } catch (err) {
      // Firestore offline or rules not set — set a minimal local doc so the app still works
      console.warn('Firestore unavailable:', err.message);
      setUserDoc({
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName || extraData.displayName || '',
        plan: 'free',
        promptsUsed: 0,
        promptsLimit: 3,
        preferences: {},
      });
    }
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        try {
          const ref = doc(db, 'users', firebaseUser.uid);
          const snap = await getDoc(ref);
          if (snap.exists()) {
            setUserDoc(snap.data());
          } else {
            await createUserDoc(firebaseUser);
          }
        } catch {
          // Firestore offline — use minimal local state
          setUserDoc({
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName || '',
            plan: 'free',
            promptsUsed: 0,
            promptsLimit: 3,
            preferences: {},
          });
        }
      } else {
        setUserDoc(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signup = async (email, password, displayName) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    await createUserDoc(cred.user, { displayName });
    return cred;
  };

  const login = (email, password) => signInWithEmailAndPassword(auth, email, password);

  const loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    await createUserDoc(cred.user);
    return cred;
  };

  const logout = () => signOut(auth);

  const refreshUserDoc = async () => {
    if (!user) return;
    try {
      const ref = doc(db, 'users', user.uid);
      const snap = await getDoc(ref);
      if (snap.exists()) setUserDoc(snap.data());
    } catch {}
  };

  return (
    <AuthContext.Provider value={{ user, userDoc, loading, signup, login, loginWithGoogle, logout, refreshUserDoc }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
