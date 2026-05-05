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

// Dev-only diagnostic logger. Stripped in production builds.
// Filter by typing `[3d]` in the DevTools console filter box.
const dlog = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('%c[3d]', 'color:#2563eb;font-weight:bold', ...args);
  }
};
const dwarn = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('%c[3d]', 'color:#dc2626;font-weight:bold', ...args);
  }
};

// ─── Versioning ───────────────────────────────────────────────────────────────
// Bump this when you change Tripo3D quality settings, post-processing, or
// anything else that should produce a fresh GLB. Old versions remain in R2
// and Firestore — they're never deleted; new traffic just generates new slugs.
export const MODEL_VERSION = 'v1';

// ─── Dev-only CORS bypass for Tripo CDN ───────────────────────────────────────
// Tripo3D's CDN (tripo-data.rg1.data.tripo3d.com) doesn't send
// Access-Control-Allow-Origin, so loading the GLB directly from localhost is
// blocked by the browser. In production we never hit this path because R2
// serves from models.vincritiq.com with CORS configured. In dev we route
// through /dev-glb-proxy (defined in setupProxy.js) which fetches from Tripo
// server-side and re-emits the bytes with permissive CORS.
//
// Important: we DO NOT apply this rewrite before persisting to Firestore —
// the database always stores raw Tripo / R2 URLs. The proxy URL is a
// transient client-side concern.
const TRIPO_CDN_RE = /^https:\/\/[a-z0-9-]+\.(?:rg1\.)?data\.tripo3d\.com\//i;

function maybeProxyForDev(url) {
  if (!url) return url;
  if (typeof window === 'undefined') return url;
  if (process.env.NODE_ENV === 'production') return url;
  if (!TRIPO_CDN_RE.test(url)) return url;
  return `/dev-glb-proxy?url=${encodeURIComponent(url)}`;
}

// Exported alias so callers outside this module (e.g. ChatInterface) can
// route a stored Tripo URL through the dev-only CORS-bypass proxy when
// reading it back from Firestore. Production builds short-circuit and
// return the URL unchanged, so this is safe to call unconditionally.
export const proxyForDevIfNeeded = maybeProxyForDev;
export function isTripoCdnUrl(url) {
  return typeof url === 'string' && TRIPO_CDN_RE.test(url);
}

// ─── Slug builder ─────────────────────────────────────────────────────────────
// Two cars sharing year/make/model/trim share a slug. Trim is optional — many
// VINs decode without one, in which case we drop it from the slug.
// Claim becomes re-claimable after 12 min. Must be > wait3DModel TIMEOUT
// below so the original generator's claim doesn't expire while it's still
// working — otherwise a second client would re-claim and double-spend.
const PENDING_STALE_MS = 12 * 60 * 1000;

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
  const out = data?.output ?? {};
  // Tripo3D image-to-model has shipped several output field names across
  // API versions. v2.5 returns the textured GLB on `pbr_model`; older
  // versions used `model`. Try them in priority order and accept any
  // non-empty URL so a successful job is never reported as 'no_url'.
  const glbUrl =
       out.pbr_model       // v2.5 textured GLB (preferred)
    || out.model           // legacy textured GLB
    || out.base_model      // untextured base mesh fallback
    || out.glb             // some endpoints
    || null;
  if (data?.status === 'success') {
    dlog('tripoPoll success', { taskId, fieldsAvailable: Object.keys(out), glbUrl });
  }
  return { status: data?.status, progress: data?.progress ?? 0, glbUrl };
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
  // Multi-image support: callers can pass an array as the first arg
  // ([{ base64, mediaType }, ...]) and we'll pick the best candidate.
  // Tripo3D's image_to_model takes one image; if/when we wire up
  // multiview_to_model (which requires labeled front/back/left/right views),
  // this is where the routing would live.
  if (Array.isArray(imageBase64)) {
    const list = imageBase64.filter((i) => i && i.base64 && i.mediaType);
    if (list.length > 0) {
      const first = list[0];
      const taskId = await tripoSubmitFromFile(first.base64, first.mediaType);
      return { taskId, source: 'photo', imagesUsed: 1, imagesProvided: list.length };
    }
  } else if (imageBase64 && imageMediaType) {
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
  // Tripo3D image-to-3D commonly takes 2–7 minutes; allow 10 to absorb spikes.
  // PENDING_STALE_MS above must remain > this value.
  const TIMEOUT = 10 * 60 * 1000;
  const start = Date.now();
  let lastStatus = null;
  dlog('wait3DModel start', { taskId, timeoutMin: TIMEOUT / 60000 });
  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) { dlog('wait3DModel aborted'); return null; }
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) { dlog('wait3DModel aborted (post-sleep)'); return null; }
    try {
      const { status, progress, glbUrl } = await tripoPoll(taskId);
      if (status !== lastStatus) {
        dlog('wait3DModel status', { status, progress, hasGlbUrl: !!glbUrl });
        lastStatus = status;
      }
      onProgress?.({ status, progress });
      if (status === 'success' && glbUrl) {
        dlog('wait3DModel resolved', { taskId, elapsedMs: Date.now() - start });
        return glbUrl;
      }
      if (status === 'success' && !glbUrl) {
        dwarn('wait3DModel: status=success but no glbUrl — Tripo response shape may have changed');
      }
      if (status === 'failed') {
        dwarn('wait3DModel: tripo reported failed');
        return null;
      }
    } catch (err) {
      dwarn('wait3DModel poll threw (will retry)', err);
    }
  }
  dwarn('wait3DModel timed out', { taskId, elapsedMs: Date.now() - start });
  return null;
}

// ─── Asset library (Firestore + R2) ───────────────────────────────────────────

// Tripo3D's CDN serves GLBs as AWS CloudFront signed URLs that expire after
// ~24 hours. We must NEVER trust one as a permanent cache entry — even if
// Firestore says status='ready', a Tripo URL that's a day old will 403.
//
// Two policies:
//   - PRODUCTION: persistGlbToR2 rewrites to R2, so a Tripo URL appearing on
//     a 'ready' doc means R2 is misconfigured. Reject it on read so the
//     procedural placeholder shows (no broken-modal). The slug re-claims and
//     re-runs Tripo, but at least nothing 403s in the user's face.
//   - DEV: no R2 binding, so Tripo URLs are the only thing we can cache.
//     Persist them with `glbUrlExpiresAt` (22h out) and accept them on read
//     until that timestamp passes. After expiry the doc gets re-claimed.
function isUsableCachedDoc(data) {
  if (!data || data.status !== 'ready' || !data.glbUrl) return false;
  if (!isTripoCdnUrl(data.glbUrl)) return true;   // R2 / other — always fine
  // From here on it IS a Tripo URL
  if (process.env.NODE_ENV === 'production') return false;
  const expiresAt = typeof data.glbUrlExpiresAt === 'number' ? data.glbUrlExpiresAt : 0;
  return Date.now() < expiresAt;
}

// Passive cache lookup — read-only, no claim, no generation. Use this when
// re-opening a previously analyzed report (e.g. clicking an old chat in the
// sidebar after a refresh) to surface the cached GLB without re-running
// Tripo3D. Returns null on any miss so the caller can fall through to the
// procedural placeholder cleanly.
export async function lookupCachedModel(vehicle) {
  const slug = buildModelSlug(vehicle);
  if (!slug) return null;
  const ref = doc(db, 'models3d', slug);

  // Firestore's WebChannel sometimes isn't connected the instant this fires
  // (page just loaded / auth just finished). The SDK then throws
  // code:'unavailable' "client is offline" — a transient state, not a real
  // network failure. One quick retry usually clears it; if it doesn't, we
  // fall through to attemptClaim's transaction, which forces a connection
  // and recovers on its own.
  const readOnce = () => getDoc(ref);
  let snap;
  try {
    snap = await readOnce();
  } catch (err) {
    if (err?.code === 'unavailable') {
      dlog('lookupCachedModel: transient offline, retrying once', { slug });
      await new Promise((r) => setTimeout(r, 250));
      try {
        snap = await readOnce();
      } catch (err2) {
        if (err2?.code === 'unavailable') {
          dlog('lookupCachedModel: still offline after retry — falling through to claim', { slug });
          return null;
        }
        dwarn('lookupCachedModel: read failed (after retry)', err2);
        return null;
      }
    } else {
      dwarn('lookupCachedModel: read failed', err);
      return null;
    }
  }

  if (!snap.exists()) {
    dlog('lookupCachedModel: no doc for slug', slug);
    return null;
  }
  const data = snap.data();
  if (!isUsableCachedDoc(data)) {
    dlog('lookupCachedModel: doc not usable', {
      slug,
      status: data.status,
      hasUrl: !!data.glbUrl,
      isTripo: isTripoCdnUrl(data.glbUrl),
      expiresAt: data.glbUrlExpiresAt,
    });
    return null;
  }
  dlog('lookupCachedModel: cache hit', { slug });
  return { glbUrl: maybeProxyForDev(data.glbUrl), slug, fromCache: true };
}

async function attemptClaim(slug, vehicle) {
  const ref = doc(db, 'models3d', slug);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) {
        // In prod, never trust a stored Tripo URL — those CloudFront
        // signatures expire ~24h. In dev, allow them up to glbUrlExpiresAt
        // so cross-session cache works without R2.
        if (isUsableCachedDoc(data)) {
          return { action: 'cache_hit', glbUrl: data.glbUrl };
        }
        dlog('attemptClaim: ready doc not usable (expired Tripo or prod-Tripo), re-claiming', slug);
      }
      if (data.status === 'pending') {
        const claimedAt = data.claimedAt?.toMillis?.() ?? 0;
        const stale = Date.now() - claimedAt > PENDING_STALE_MS;
        if (!stale) return { action: 'wait' };
        // fall through and re-claim
      }
      // 'failed', stale 'pending', or 'ready' with an expired Tripo URL — re-claim
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
  // Should comfortably exceed wait3DModel TIMEOUT so a follower client doesn't
  // give up before the original generator finishes.
  const TIMEOUT = 12 * 60 * 1000;
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
  dlog('persistGlbToR2 → POST /api/models/upload', { slug, sourceUrl: sourceUrl?.slice(0, 80) });
  let res;
  try {
    res = await fetch('/api/models/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, sourceUrl }),
    });
  } catch (err) {
    dwarn('persistGlbToR2 fetch threw (network or proxy down)', err);
    throw err;
  }
  if (!res.ok) {
    // Surface the response body when possible so we can tell apart a 404
    // (route missing — dev server not restarted) from a 502 (R2 upstream
    // failed) from a 400 (bad slug shape).
    let bodyText = '';
    try { bodyText = await res.text(); } catch {}
    dwarn('persistGlbToR2 non-OK response', {
      status: res.status,
      statusText: res.statusText,
      body: bodyText.slice(0, 200),
    });
    throw new Error(`models/upload failed: ${res.status}`);
  }
  const data = await res.json();
  dlog('persistGlbToR2 ok', data);
  return data?.glbUrl ?? null;
}

async function markReady(slug, glbUrl, sourceVin, opts = {}) {
  try {
    const patch = {
      status: 'ready',
      glbUrl,
      generatedAt: serverTimestamp(),
      sourceVin: sourceVin || null,
      glbUrlSource: opts.source || (isTripoCdnUrl(glbUrl) ? 'tripo' : 'r2'),
    };
    // expiresAt is only set for Tripo URLs in dev; R2 URLs never expire so
    // we explicitly omit the field rather than carrying a stale one over.
    if (typeof opts.expiresAt === 'number') {
      patch.glbUrlExpiresAt = opts.expiresAt;
    }
    await updateDoc(doc(db, 'models3d', slug), patch);
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

// ─── Refresh-resilient Tripo job recovery ───────────────────────────────────
// Tripo3D charges per submitted task, NOT per poll. So when a user refreshes
// mid-generation the cheap fix is NOT to abandon the task — it's to poll the
// SAME task_id on the next page load and pick up the result. If Tripo
// finished while we were gone, we get the GLB for free; if it's still
// running, we keep waiting.
//
// We persist the active task list to localStorage (per-tab, per-user, NOT
// shared across users — only the originating client knows the task_id).
// On next page load `recoverPendingJobs()` polls each entry and either
// markReady's the GLB or drops it.
//
// We deliberately do NOT mark the slug doc as failed on unload anymore.
// Letting it sit at status="pending" with a recoverable task_id is the only
// path that doesn't waste $0.30 every refresh.
const PENDING_JOBS_KEY = 'vincritiq_pending_3d_jobs_v1';
// Tripo task_ids stay valid roughly as long as the source images do — give
// ourselves 30 min to recover before we give up and re-claim.
const RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;

function readPendingJobs() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_JOBS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function writePendingJobs(list) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PENDING_JOBS_KEY, JSON.stringify(list));
  } catch {}
}

function recordPendingJob(slug, taskId, vin) {
  if (!slug || !taskId) return;
  const list = readPendingJobs().filter((j) => j.slug !== slug);
  list.push({ slug, taskId, vin: vin || null, savedAt: Date.now() });
  writePendingJobs(list);
}

function clearPendingJob(slug) {
  if (!slug) return;
  writePendingJobs(readPendingJobs().filter((j) => j.slug !== slug));
}

/**
 * Resume any Tripo jobs that were interrupted by a previous page refresh.
 * Called once on app boot. For each saved task:
 *   - poll Tripo
 *   - if success → persist to R2 / markReady (+clear from localStorage)
 *   - if failed → markFailed (+clear)
 *   - if still running → leave it; we'll try again next boot
 *   - if older than RECOVERY_MAX_AGE_MS → drop the entry; next claim attempt
 *     will re-run Tripo from scratch
 *
 * Safe to call multiple times. Idempotent. Catches all errors so it can never
 * break the rest of the app boot.
 */
export async function recoverPendingJobs() {
  const list = readPendingJobs();
  if (list.length === 0) return;
  dlog('recoverPendingJobs: scanning', { count: list.length });

  for (const job of list) {
    const ageMs = Date.now() - (job.savedAt || 0);
    if (ageMs > RECOVERY_MAX_AGE_MS) {
      dlog('recoverPendingJobs: dropping aged entry', { slug: job.slug, ageMin: Math.round(ageMs / 60000) });
      clearPendingJob(job.slug);
      continue;
    }
    try {
      const { status, glbUrl } = await tripoPoll(job.taskId);
      dlog('recoverPendingJobs: poll result', { slug: job.slug, status, hasUrl: !!glbUrl });
      if (status === 'success' && glbUrl) {
        // Try to persist to R2; fall back to dev / markFailed branches the
        // same way generateOrFetch3D does.
        try {
          const r2Url = await persistGlbToR2(job.slug, glbUrl);
          if (r2Url) {
            await markReady(job.slug, r2Url, job.vin || null, { source: 'r2' });
            dlog('recoverPendingJobs: recovered with R2 URL', { slug: job.slug });
          } else if (process.env.NODE_ENV !== 'production') {
            const expiresAt = Date.now() + 22 * 60 * 60 * 1000;
            await markReady(job.slug, glbUrl, job.vin || null, { source: 'tripo', expiresAt });
            dlog('recoverPendingJobs: recovered with Tripo URL (dev)', { slug: job.slug });
          } else {
            await markFailed(job.slug, 'recovery_r2_returned_null_in_prod');
          }
        } catch (err) {
          dwarn('recoverPendingJobs: persist threw', err);
          await markFailed(job.slug, 'recovery_persist_failed');
        }
        clearPendingJob(job.slug);
      } else if (status === 'failed') {
        await markFailed(job.slug, 'recovery_tripo_failed');
        clearPendingJob(job.slug);
      }
      // else: still running/queued — leave for the next boot.
    } catch (err) {
      dwarn('recoverPendingJobs: poll threw', err);
      // network blip — leave the entry, retry next time
    }
  }
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
  images,            // optional: array of { base64, mediaType }; takes precedence
  vin,
  onProgress,
  onCost,    // optional ({ label, amount, detail }) — fires once per paid event
  signal,
} = {}) {
  const slug = buildModelSlug(vehicle);
  dlog('generateOrFetch3D start', {
    slug,
    hasUserPhoto: !!imageBase64,
    vin: vin || null,
    vehicle: vehicle ? { year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim } : null,
  });

  // 1. Cache lookup + claim (only if we have a slug)
  let claim = null;
  if (slug) {
    try {
      claim = await attemptClaim(slug, vehicle);
      dlog('attemptClaim →', claim);
    } catch (err) {
      // Firestore unavailable / rules block / offline — degrade to no-cache mode
      dwarn('attemptClaim threw — falling back to no-cache mode', err);
      claim = null;
    }

    if (claim?.action === 'cache_hit') {
      onProgress?.({ status: 'CacheHit', progress: 100 });
      dlog('cache hit — returning early', { slug, glbUrl: claim.glbUrl });
      // Cache hit — no costs incurred at all (no Tripo3D, no VinAudit image lookup).
      return { glbUrl: maybeProxyForDev(claim.glbUrl), slug, fromCache: true };
    }
    if (claim?.action === 'wait') {
      onProgress?.({ status: 'WaitingForOther', progress: 0 });
      dlog('claim is pending elsewhere, polling cache');
      const glbUrl = await pollCacheUntilReady(slug, signal);
      if (glbUrl) {
        dlog('follower poll resolved', { glbUrl });
        return { glbUrl: maybeProxyForDev(glbUrl), slug, fromCache: true };
      }
      dwarn('follower poll exhausted — falling through to self-generate');
      // The other client failed — we fall through and try ourselves.
    }
  }

  // 2. Generate via Tripo3D. Prefer the multi-image array if provided so the
  //    caller can pass several photos and we pick the best one.
  let job;
  try {
    if (Array.isArray(images) && images.length > 0) {
      job = await submit3DJob(images, null, vin);
    } else {
      job = await submit3DJob(imageBase64, imageMediaType, vin);
    }
  } catch (err) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, err?.message || 'submit_failed');
    }
    return null;
  }
  if (!job) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'no_source_image');
    }
    return null;
  }
  // Costs are committed at submit time — Tripo doesn't refund failed jobs.
  if (job.source === 'vinaudit') {
    onCost?.({ label: 'VinAudit (image lookup)', amount: 0.05, detail: 'stock photo for 3D' });
  }
  onCost?.({ label: 'Tripo3D image-to-3D', amount: 0.30, detail: `source: ${job.source}` });
  onProgress?.({ status: 'Pending', progress: 0 });

  // Record this Tripo task to localStorage IMMEDIATELY after submit so a
  // refresh-during-polling next page load can recover it (re-poll the same
  // task_id) instead of re-submitting and double-charging.
  if (slug && claim?.action === 'claim' && job.taskId) {
    recordPendingJob(slug, job.taskId, vin || null);
  }

  let tripoGlbUrl;
  try {
    tripoGlbUrl = await wait3DModel(job.taskId, onProgress, signal);
  } catch (err) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, err?.message || 'wait_failed');
      clearPendingJob(slug);
    }
    return null;
  }
  if (!tripoGlbUrl) {
    if (slug && claim?.action === 'claim') {
      await markFailed(slug, 'tripo_no_url');
      clearPendingJob(slug);
    }
    return null;
  }

  dlog('Tripo returned glbUrl', { tripoGlbUrl: tripoGlbUrl.slice(0, 80) });

  // 3. Persist to R2 (only if we have a slug — i.e. we know the trim well enough to share)
  let finalUrl = tripoGlbUrl;
  if (slug && claim?.action === 'claim') {
    try {
      const r2Url = await persistGlbToR2(slug, tripoGlbUrl);
      if (r2Url) {
        finalUrl = r2Url;
        await markReady(slug, r2Url, vin || null, { source: 'r2' });
        dlog('R2 persist OK; markReady with R2 URL', { r2Url: r2Url.slice(0, 80) });
      } else if (process.env.NODE_ENV !== 'production') {
        // Dev mode (no R2 binding). Persist the raw Tripo URL with a 22h
        // expiry — that's the lifetime of Tripo's CloudFront signature, and
        // the read-side `isUsableCachedDoc` will reject it once we cross
        // glbUrlExpiresAt. This makes cross-session cache work in dev: a
        // second analysis of the same year/make/model/trim within the day
        // hits the slug doc and reuses the GLB instead of re-running Tripo.
        const expiresAt = Date.now() + 22 * 60 * 60 * 1000;
        await markReady(slug, tripoGlbUrl, vin || null, { source: 'tripo', expiresAt });
        dlog('Dev: markReady with Tripo URL + expiresAt', {
          tripoUrl: tripoGlbUrl.slice(0, 80),
          expiresInH: 22,
        });
      } else {
        // Production with R2 returning null = MODELS_PUBLIC_BASE missing.
        // Persist nothing; mark failed so the next request re-claims and the
        // user sees the procedural fallback rather than a guaranteed-CORS
        // error from a Tripo URL.
        await markFailed(slug, 'r2_returned_null_in_prod');
        dlog('Prod: R2 returned null — MODELS_PUBLIC_BASE likely unset; marked failed');
      }
    } catch (err) {
      dwarn('R2 persist threw; falling back to Tripo URL for this session', err);
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
    // Generation finished (success or terminal failure) — drop the
    // localStorage recovery entry so we don't re-poll a finalized task on
    // the next page load.
    clearPendingJob(slug);
  }

  // Final URL the caller hands to <GLBScene>. In production this is an R2
  // URL that loads cleanly. In dev (where finalUrl is the raw Tripo URL)
  // route through the dev proxy so the browser doesn't bounce on CORS.
  const displayUrl = maybeProxyForDev(finalUrl);
  dlog('generateOrFetch3D returning', {
    fromCache: false,
    finalUrl: finalUrl?.slice(0, 80),
    displayUrl: displayUrl?.slice(0, 80),
    proxiedForDev: displayUrl !== finalUrl,
    slug,
  });
  return { glbUrl: displayUrl, slug, fromCache: false };
}
