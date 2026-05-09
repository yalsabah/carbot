import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  fetchSignInMethodsForEmail,
  verifyBeforeUpdateEmail,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
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
  // `signingIn` is set briefly when a fresh login starts. We hold it true
  // for ~1s after the auth state resolves so the UI can show a "welcome
  // back" loading screen instead of jump-cutting straight from auth modal
  // to the populated chat. Tracks the LATEST uid we showed the spinner
  // for, so re-renders during that window don't re-trigger it.
  const [signingIn, setSigningIn] = useState(false);
  const lastSignInUidRef = useRef(null);

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
          // cycleStartedAt is null until the user makes their first prompt;
          // incrementUserUsage stamps it then. Reset window is 24h from
          // that timestamp.
          cycleStartedAt: null,
          preferences: {},
          feedback: {
            thumbsUp:   { count: 0, messages: [] },
            thumbsDown: { count: 0, messages: [] },
          },
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
        // First time we observe this uid, hold the welcome-loading state
        // for ~1s. This gives the chat list / preferences time to hydrate
        // and matches the smoother "logging you in…" feel the user expects
        // instead of an instant jump-cut from auth modal → populated app.
        if (lastSignInUidRef.current !== firebaseUser.uid) {
          lastSignInUidRef.current = firebaseUser.uid;
          setSigningIn(true);
          setTimeout(() => setSigningIn(false), 1000);
        }
      } else {
        setUserDoc(null);
        // Reset the tracker so the next login (possibly a different user)
        // re-triggers the welcome screen.
        lastSignInUidRef.current = null;
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

  // Change the user's email. Two-step:
  //   1. Pre-flight check via fetchSignInMethodsForEmail — fast UI feedback
  //      when an account already exists for the new email.
  //   2. verifyBeforeUpdateEmail sends a confirmation link to the NEW
  //      address; the email only actually changes after the user clicks
  //      that link. This is Firebase's secure path (the old updateEmail
  //      is deprecated for accounts without recent verification).
  // Returns one of: { ok: true }, { ok: false, code, message }.
  const updateUserEmail = async (newEmail) => {
    if (!user) return { ok: false, code: 'no-user', message: 'Not signed in.' };
    const trimmed = String(newEmail || '').trim().toLowerCase();
    if (!trimmed) return { ok: false, code: 'invalid', message: 'Email is required.' };
    if (trimmed === (user.email || '').toLowerCase()) {
      return { ok: false, code: 'same', message: 'That is already your email.' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return { ok: false, code: 'invalid', message: 'Please enter a valid email address.' };
    }

    try {
      // Best-effort pre-flight. With email-enumeration protection enabled
      // this may always return [] — in that case we still rely on
      // verifyBeforeUpdateEmail's auth/email-already-in-use error below.
      const methods = await fetchSignInMethodsForEmail(auth, trimmed);
      if (Array.isArray(methods) && methods.length > 0) {
        return {
          ok: false,
          code: 'auth/email-already-in-use',
          message: 'An account already exists with this email.',
        };
      }
    } catch {
      // Network blip — let the actual update call surface the error.
    }

    try {
      await verifyBeforeUpdateEmail(user, trimmed);
      // Mirror to Firestore on a best-effort basis. Auth email is the source
      // of truth; this is just so the userDoc display is in sync after the
      // user confirms the link. Real switch happens on next auth state.
      try {
        await updateDoc(doc(db, 'users', user.uid), { pendingEmail: trimmed });
      } catch {}
      return {
        ok: true,
        message: `Verification link sent to ${trimmed}. Click it to finish the change.`,
      };
    } catch (err) {
      const code = err?.code || 'auth/unknown';
      const map = {
        'auth/email-already-in-use': 'An account already exists with this email.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/requires-recent-login':
          'For security, sign out and sign back in, then try again.',
        'auth/operation-not-allowed': 'Email change is not enabled for this project.',
        'auth/too-many-requests': 'Too many attempts — please wait a moment.',
      };
      return { ok: false, code, message: map[code] || err.message || 'Could not change email.' };
    }
  };

  // Re-verify the user's identity for sensitive operations (email change,
  // delete account, billing changes). Returns:
  //   { ok: true } on success
  //   { ok: false, code: 'needs-password' } when the account uses email/password
  //                                          and the caller didn't pass one yet
  //   { ok: false, code, message } on failure
  // Caller pattern: try once with no args; if `needs-password`, render an
  // inline password input and call again with that password.
  const reauthenticate = async (passwordIfNeeded) => {
    if (!user) return { ok: false, code: 'no-user', message: 'Not signed in.' };
    const providerId = user.providerData?.[0]?.providerId || 'password';
    try {
      if (providerId === 'google.com') {
        await reauthenticateWithPopup(user, new GoogleAuthProvider());
        return { ok: true };
      }
      if (providerId === 'password') {
        if (!passwordIfNeeded) {
          return {
            ok: false,
            code: 'needs-password',
            message: 'Enter your current password to continue.',
          };
        }
        const cred = EmailAuthProvider.credential(user.email, passwordIfNeeded);
        await reauthenticateWithCredential(user, cred);
        return { ok: true };
      }
      return {
        ok: false,
        code: 'unsupported-provider',
        message: `Re-authentication for ${providerId} is not supported here.`,
      };
    } catch (err) {
      const code = err?.code || 'auth/unknown';
      const map = {
        'auth/wrong-password': 'Incorrect password.',
        'auth/invalid-credential': 'Incorrect password.',
        'auth/popup-closed-by-user': 'Sign-in window was closed before finishing.',
        'auth/cancelled-popup-request': 'Another sign-in is already open.',
        'auth/user-mismatch':
          'You signed in with a different account. Use your original email.',
        'auth/too-many-requests': 'Too many attempts — please wait a moment.',
      };
      return { ok: false, code, message: map[code] || err.message || 'Could not verify.' };
    }
  };

  return (
    <AuthContext.Provider value={{ user, userDoc, loading, signingIn, signup, login, loginWithGoogle, logout, refreshUserDoc, updateUserEmail, reauthenticate }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
