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
// In production, persistGlbToR2 rewrites the URL to our R2 origin, which
// doesn't expire. In dev, the lack of R2 means stuck Tripo URLs can pollute
// Firestore. This predicate skips them defensively at every read site.
function isExpiringTripoUrl(url) {
  return typeof url === 'string' && TRIPO_CDN_RE.test(url);
}

// Passive cache lookup — read-only, no claim, no generation. Use this when
// re-opening a previously analyzed report (e.g. clicking an old chat in the
// sidebar after a refresh) to surface the cached GLB without re-running
// Tripo3D. Returns null on any miss so the caller can fall through to the
// procedural placeholder cleanly.
export async function lookupCachedModel(vehicle) {
  const slug = buildModelSlug(vehicle);
  if (!slug) return null;
  try {
    const snap = await getDoc(doc(db, 'models3d', slug));
    if (!snap.exists()) {
      dlog('lookupCachedModel: no doc for slug', slug);
      return null;
    }
    const data = snap.data();
    if (data.status !== 'ready' || !data.glbUrl) {
      dlog('lookupCachedModel: doc not ready', { slug, status: data.status });
      return null;
    }
    if (isExpiringTripoUrl(data.glbUrl)) {
      dlog('lookupCachedModel: ignoring expiring Tripo URL — re-generation required', slug);
      return null;
    }
    dlog('lookupCachedModel: cache hit', { slug });
    return { glbUrl: maybeProxyForDev(data.glbUrl), slug, fromCache: true };
  } catch (err) {
    dwarn('lookupCachedModel: read failed', err);
    return null;
  }
}

async function attemptClaim(slug, vehicle) {
  const ref = doc(db, 'models3d', slug);
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const data = snap.data();
      if (data.status === 'ready' && data.glbUrl) {
        // Skip ready entries whose URL points at Tripo's CDN — those are
        // signed CloudFront URLs that expire after ~24h and would 403 the
        // modal. Pretend it's a stale claim so we re-generate cleanly.
        if (isExpiringTripoUrl(data.glbUrl)) {
          dlog('attemptClaim: ignoring expired Tripo URL on ready doc, re-claiming', slug);
        } else {
          return { action: 'cache_hit', glbUrl: data.glbUrl };
        }
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
    if (slug && claim?.action === 'claim') await markFailed(slug, err?.message || 'submit_failed');
    return null;
  }
  if (!job) {
    if (slug && claim?.action === 'claim') await markFailed(slug, 'no_source_image');
    return null;
  }
  // Costs are committed at submit time — Tripo doesn't refund failed jobs.
  if (job.source === 'vinaudit') {
    onCost?.({ label: 'VinAudit (image lookup)', amount: 0.05, detail: 'stock photo for 3D' });
  }
  onCost?.({ label: 'Tripo3D image-to-3D', amount: 0.30, detail: `source: ${job.source}` });
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

  dlog('Tripo returned glbUrl', { tripoGlbUrl: tripoGlbUrl.slice(0, 80) });

  // 3. Persist to R2 (only if we have a slug — i.e. we know the trim well enough to share)
  let finalUrl = tripoGlbUrl;
  if (slug && claim?.action === 'claim') {
    try {
      const r2Url = await persistGlbToR2(slug, tripoGlbUrl);
      if (r2Url) {
        finalUrl = r2Url;
        await markReady(slug, r2Url, vin || null);
        dlog('R2 persist OK; markReady with R2 URL', { r2Url: r2Url.slice(0, 80) });
      } else {
        // Dev mode (no R2 binding) returns null. Caching the raw Tripo URL
        // would set up a 403 the next day when the signed URL expires, so
        // we explicitly mark the slug as failed instead. The current session
        // still gets the live Tripo URL through `finalUrl`; subsequent
        // analyses for this trim will simply re-generate.
        await markFailed(slug, 'dev_no_r2_persistence');
        dlog('R2 returned null (dev mode); marked failed (Tripo URL is short-lived)');
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
