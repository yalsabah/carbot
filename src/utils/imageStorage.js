// Firebase Storage upload helper for user-attached vehicle photos.
//
// Why this exists: the in-session `_attachments` array carries data URLs so
// the UI can show real thumbnails immediately, but underscore-prefixed fields
// are stripped before Firestore writes (image bytes would blow past the 1MB
// per-doc limit anyway). Without persistence, refreshing the page or
// switching to the same chat from the sidebar shows only the textual chips
// and forces a 3D-model regeneration if the user opens the report — both
// of which the user explicitly complained about.
//
// What we do instead:
//   - Upload each File to users/{uid}/sessions/{sessionId}/{ts}-{i}-{name}
//   - Get a download URL
//   - Caller writes the URL list to the user message in Firestore
//   - On history load, the URL list is read back and fed to the UI as a
//     drop-in replacement for the in-memory data URLs.
//
// Failure mode: if the upload errors (Storage rules, network, etc.) we just
// return what succeeded; the message still saves and the in-session
// `_attachments` keep working until the page refreshes. Worst case the user
// re-uploads — same as before this change.

import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase/config';

const dlog = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('%c[storage]', 'color:#0d9488;font-weight:bold', ...args);
  }
};

function safeName(name) {
  return String(name || 'image').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/**
 * Upload an array of vehicle-photo Files to Firebase Storage.
 * @param {string} uid
 * @param {string} sessionId
 * @param {File[]} files
 * @returns {Promise<Array<{ url: string, name: string, path: string }>>}
 */
export async function uploadVehicleImages(uid, sessionId, files) {
  if (!uid || !sessionId || !Array.isArray(files) || files.length === 0) return [];
  const out = [];
  const ts = Date.now();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file) continue;
    const path = `users/${uid}/sessions/${sessionId}/vehicle-${ts}-${i}-${safeName(file.name)}`;
    try {
      const ref = storageRef(storage, path);
      await uploadBytes(ref, file, { contentType: file.type || 'image/jpeg' });
      const url = await getDownloadURL(ref);
      out.push({ url, name: file.name || `image-${i}`, path });
      dlog('uploaded', { path, size: file.size });
    } catch (err) {
      dlog('upload failed (continuing with the rest)', { path, err: err?.message });
    }
  }
  return out;
}
