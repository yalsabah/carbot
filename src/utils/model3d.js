// 3D vehicle model pipeline — trim-cache-first.
//
// Flow:
//   1. Build a slug from the decoded vehicle's year/make/model/trim + MODEL_VERSION.
//   2. Look up models3d/{slug} in Firestore.
//        - status === 'ready' → use cached glbUrl from R2, done.
//        - status === 'pending' → another client is already generating, poll until ready.
//        - missing or stale → claim it (transactionally), then generate.
//   3. Generate via Tripo3D (image-to-model from user photo, or VinAudit stock photo).
//   4. POST the temporary Tripo URL to /api/models/upload — server fetches it
//      and writes it to R2 at the slug-derived key. Return the permanent R2 URL.
//   5. Update models3d/{slug} → { status: 'ready', glbUrl, generatedAt }.
//
// Two users analyzing different VINs of the same trim share one GLB.
// Bumping MODEL_VERSION (e.g. 'v1' → 'v2') causes new slugs to be generated
// while old ones stay accessible — no eviction, no breakage.

import {
  doc, getDoc, runTransaction, serverTimestamp, updateDoc,
} from 'firebase/firestore';
import { db } from '../firebase/config';

// ─── Versioning ───────────────────────────────────────────────────────────────
// Bump this when you change Tripo3D quality settings, post-processing, or
// anything else that should produce a fresh GLB. Old versions remain in R2
// and Firestore — they're never deleted; new traffic just generates new slugs.
export const MODEL_VERSION = 'v1';

// ─── Slug builder ─────────────────────────────────────────────────────────────
// Two cars sharing year/make/model/trim share a slug. Trim is optional — many
// VINs decode without one, in which case we drop it from the slug.
const PENDING_STALE_MS = 7 * 60 * 1000; // claim becomes re-claimable after 7 min

function normSegment(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildModelSlug(vehicle) {
  if (!vehicle) return null;
  const { year, make, model, trim } = vehicle;
  if (!year || !make || !model) return null;
  const parts = [String(year), normSegment(make), normSegment(model)];
  const t = normSegment(trim);
  if (t) parts.push(t);
  parts.push(MODEL_VERSION);
  const slug = parts.join('-');
  // Final safety: strict pattern (matches the server-side regex)
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120 ? slug : null;
}

// ─── Tripo3D primitives (unchanged from before) ───────────────────────────────

async function tripoSubmitFromFile(imageBase64, imageMediaType) {
  const blob = await (await fetch(`data:${imageMediaType};base64,${imageBase64}`)).blob();
  const form = new FormData();
  form.append('file', blob, 'vehicle.jpg');

  const uploadRes = await fetch('/api/tripo/upload', { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error(`Tripo upload failed: ${uploadRes.status}`);
  const { data: { image_token } } = await uploadRes.json();
  return tripoCreateTask({ type: 'image_to_model', file: { type: 'jpg', file_token: image_token } });
}

async function tripoSubmitFromUrl(imageUrl) {
  return tripoCreateTask({ type: 'image_to_model', file: { type: 'jpg', url: imageUrl } });
}

async function tripoCreateTask(input) {
  const res = await fetch('/api/tripo/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Tripo task failed: ${res.status}`);
  const { data: { task_id } } = await res.json();
  return task_id;
}

async function tripoPoll(taskId) {
  const res = await fetch(`/api/tripo/task/${taskId}`);
  if (!res.ok) throw new Error(`Tripo poll failed: ${res.status}`);
  const { data } = await res.json();
  const glbUrl = data.output?.model ?? null;
  return { status: data.status, progress: data.progress ?? 0, glbUrl };
}

async function fetchVinAuditPhotoUrl(vin) {
  if (!vin) return null;
  try {
    const res = await fetch(`/api/vinaudit?vin=${encodeURIComponent(vin)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.images?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Tripo3D submit + wait (kept exported; legacy callers still work) ─────────

export async function submit3DJob(imageBase64, imageMediaType, vin) {
  if (imageBase64 && imageMediaType) {
    const taskId = await tripoSubmitFromFile(imageBase64, imageMediaType);
    return { taskId, source: 'photo' };
  }
  if (vin) {
    const photoUrl = await fetchVinAuditPhotoUrl(vin);
    if (photoUrl) {
      const taskId = await tripoSubmitFromUrl(photoUrl);
      return { taskId, source: 'vinaudit', photoUrl };
    }
  }
  return null;
}

export async function wait3DModel(taskId, onProgress, signal) {
  const INTERVAL = 4000;
  const TIMEOUT = 5 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const { status, progress, glbUrl } = await tripoPoll(taskId);
      onProgress?.({ status, progress });
      if (status === 'success' && glbUrl) return glbUrl;
      if (status === 'failed') return null;
    } catch {
      // transient — keep polling
    }
  }
  return null;
}

// ─── Asset library (Firestore + R2) ───────────────────────────────────────────

async function attemptClaim(slug, vehicle) {
  const ref = doc(db, 'models3d', slug);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) {
        return { action: 'cache_hit', glbUrl: data.glbUrl };
      }
      if (data.status === 'pending') {
        const claimedAt = data.claimedAt?.toMillis?.() ?? 0;
        const stale = Date.now() - claimedAt > PENDING_STALE_MS;
        if (!stale) return { action: 'wait' };
        // fall through and re-claim
      }
      // 'failed' or stale 'pending' — re-claim
    }
    tx.set(ref, {
      status: 'pending',
      claimedAt: serverTimestamp(),
      version: MODEL_VERSION,
      year:  vehicle?.year ?? null,
      make:  vehicle?.make ?? null,
      model: vehicle?.model ?? null,
      trim:  vehicle?.trim ?? null,
    });
    return { action: 'claim' };
  });
}

async function pollCacheUntilReady(slug, signal) {
  const ref = doc(db, 'models3d', slug);
  const TIMEOUT = 7 * 60 * 1000;
  const INTERVAL = 4000;
  const start = Date.now();
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) return null;
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) return data.glbUrl;
      if (data.status === 'failed') return null;
    } catch {
      // transient — keep polling
    }
  }
  return null;
}

async function persistGlbToR2(slug, sourceUrl) {
  const res = await fetch('/api/models/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, sourceUrl }),
  });
  if (!res.ok) throw new Error(`models/upload failed: ${res.status}`);
  const data = await res.json();
  return data?.glbUrl ?? null;
}

async function markReady(slug, glbUrl, sourceVin) {
  try {
    await updateDoc(doc(db, 'models3d', slug), {
      status: 'ready',
      glbUrl,
      generatedAt: serverTimestamp(),
      sourceVin: sourceVin || null,
    });
  } catch (err) {
    console.warn('models3d markReady failed', err);
  }
}

async function markFailed(slug, reason) {
  try {
    await updateDoc(doc(db, 'models3d', slug), {
      status: 'failed',
      failureReason: String(reason).slice(0, 200),
      failedAt: serverTimestamp(),
    });
  } catch {}
}

// ─── Orchestrator: the new entry point ────────────────────────────────────────
//
// Use this from the chat flow instead of submit3DJob/wait3DModel directly.
// It handles the cache check, claim, generation, and R2 persistence.
//
// Args:
//   vehicle         { year, make, model, trim }   — for slug. If absent or
//                                                    incomplete, we skip caching
//                                                    and just generate per-session.
//   imageBase64,
//   imageMediaType  user-uploaded photo (optional, takes priority over VIN photo)
//   vin             VIN for VinAudit fallback path
//   onProgress      ({ status, progress }) → void
//   signal          AbortSignal
//
// Returns: { glbUrl, slug, fromCache } | null
//
export async function generateOrFetch3D({
  vehicle,
  imageBase64,
  imageMediaType,
  vin,
  onProgress,
  signal,
} = {}) {
  const slug = buildModelSlug(vehicle);

  // 1. Cache lookup + claim (only if we have a slug)
  let claim = null;
  if (slug) {
    try {
      claim = await attemptClaim(slug, vehicle);
    } catch (err) {
      // Firestore unavailable / rules block / offline — degrade to no-cache mode
      console.warn('3D cache claim failed, generating without cache', err);
      claim = null;
    }

    if (claim?.action === 'cache_hit') {
      onProgress?.({ status: 'CacheHit', progress: 100 });
      return { glbUrl: claim.glbUrl, slug, fromCache: true };
    }
    if (claim?.action === 'wait') {
      onProgress?.({ status: 'WaitingForOther', progress: 0 });
      const glbUrl = await pollCacheUntilReady(slug, signal);
      if (glbUrl) return { glbUrl, slug, fromCache: true };
      // The other client failed — we fall through and try ourselves.
    }
  }

  // 2. Generate via Tripo3D
  let job;
  try {
    job = await submit3DJob(imageBase64, imageMediaType, vin);
  } catch (err) {
    if (slug && claim?.action === 'claim') await markFailed(slug, err?.message || 'submit_failed');
    return null;
  }
  if (!job) {
    if (slug && claim?.action === 'claim') await markFailed(slug, 'no_source_image');
    return null;
  }
  onProgress?.({ status: 'Pending', progress: 0 });

  let tripoGlbUrl;
  try {
    tripoGlbUrl = await wait3DModel(job.taskId, onProgress, signal);
  } catch (err) {
    if (slug && claim?.action === 'claim') await markFailed(slug, err?.message || 'wait_failed');
    return null;
  }
  if (!tripoGlbUrl) {
    if (slug && claim?.action === 'claim') await markFailed(slug, 'tripo_no_url');
    return null;
  }

  // 3. Persist to R2 (only if we have a slug — i.e. we know the trim well enough to share)
  let finalUrl = tripoGlbUrl;
  if (slug && claim?.action === 'claim') {
    try {
      const r2Url = await persistGlbToR2(slug, tripoGlbUrl);
      if (r2Url) {
        finalUrl = r2Url;
        await markReady(slug, r2Url, vin || null);
      } else {
        // Dev mode (no R2 binding) returns null. Mark ready with the Tripo URL
        // anyway so the in-progress doc unblocks any waiting client; cache hit
        // will work for the rest of the session even if the URL is short-lived.
        await markReady(slug, tripoGlbUrl, vin || null);
      }
    } catch (err) {
      console.warn('R2 persist failed; using Tripo URL for this session', err);
      // Don't markFailed — the URL still works for *this* session, and the next
      // run will re-attempt. We do release the claim so others can re-try.
      try {
        await updateDoc(doc(db, 'models3d', slug), {
          status: 'failed',
          failureReason: 'r2_upload_failed',
          failedAt: serverTimestamp(),
        });
      } catch {}
    }
  }

  return { glbUrl: finalUrl, slug, fromCache: false };
}
