// VinAudit Vehicle Images API client + cache.
//
// Hits our own /api/vinaudit-images Pages Function (which holds the
// VinAudit key server-side) and adds two layers of caching:
//
//   L1 — module-level Map, keyed by VIN. Survives within a session, lost
//        on page reload. Fastest possible hit.
//
//   L2 — Firestore `vinAuditImages/{year-make-model-pose-color-size}`.
//        SHARED across users + devices. Same trim → same year/make/model →
//        same cache hit, even from a different VIN. Per the user's
//        request: "if a vehicle is similar but different trim, we should
//        reuse the images rather than generate new ones."
//
// VinAudit charges $1.00 per call. Combined with the Tripo3D / Replicate
// slug cache that already amortizes 3D generation, this cache turns the
// per-trim VinAudit cost into a per-year-make-model cost — typically
// 3-5x fewer paid calls.

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase/config';

const dlog = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('%c[vinaudit]', 'color:#9333ea;font-weight:bold', ...args);
  }
};
const dwarn = (...args) => {
  // eslint-disable-next-line no-console
  console.warn('%c[vinaudit]', 'color:#dc2626;font-weight:bold', ...args);
};

// L1: in-session cache. Keyed by VIN + cosmetic options so two different
// pose/color requests for the same VIN both get cached.
const _l1 = new Map();

// Normalize year/make/model into a Firestore doc ID. Mirrors the
// buildModelSlug helper in model3d.js but stops at model (no trim).
// Result is kebab-case ASCII like "2022-audi-s5".
function buildVehicleKey(vehicle, opts = {}) {
  if (!vehicle) return null;
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const year = vehicle.year ? String(vehicle.year) : null;
  const make = vehicle.make ? norm(vehicle.make) : null;
  const model = vehicle.model ? norm(vehicle.model) : null;
  if (!year || !make || !model) return null;
  const pose = opts.pose || 'front_right';
  const color = opts.color || 'white';
  const size = opts.size || 'medium';
  return `${year}-${make}-${model}-${pose}-${color}-${size}`;
}

// L2 read — checks Firestore for a cached image set.
async function readFirestoreCache(key) {
  if (!key) return null;
  try {
    const snap = await getDoc(doc(db, 'vinAuditImages', key));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (!Array.isArray(data?.images) || data.images.length === 0) return null;
    return data.images;
  } catch (err) {
    dwarn('readFirestoreCache failed', err?.message || err);
    return null;
  }
}

// L2 write — store the fetched images under the year-make-model key.
async function writeFirestoreCache(key, images, sourceVin) {
  if (!key || !Array.isArray(images) || images.length === 0) return;
  try {
    // Cap each image's base64 length to ~700KB (Firestore doc limit is
    // 1MB; we leave headroom for metadata + the URL field). At size=medium
    // PNG with white background a typical car image is ~200-500KB base64,
    // so this is rarely a problem.
    const safeImages = images.map((i) => ({
      base64: typeof i.base64 === 'string' ? i.base64.slice(0, 700000) : '',
      mediaType: i.mediaType || 'image/png',
      url: i.url || null,
      source: 'vinaudit',
    }));
    await setDoc(doc(db, 'vinAuditImages', key), {
      images: safeImages,
      cachedAt: serverTimestamp(),
      sourceVin: sourceVin || null,
    });
    dlog('L2 cache write', { key, count: safeImages.length });
  } catch (err) {
    dwarn('writeFirestoreCache failed', err?.message || err);
  }
}

/**
 * Fetch a stock photo for the given VIN, ready to feed Tripo3D / Replicate.
 *
 * @param {string} vin
 * @param {object} [opts]
 * @param {string} [opts.pose]    — front_right (default), front_left, front, back_left, back_right, back, right, left
 * @param {string} [opts.size]    — medium (default), small, large, xlarge, full
 * @param {string} [opts.color]   — white (default), black, gray, silver, blue, red, ...
 * @param {object} [opts.vehicle] — { year, make, model } from the parsed report; enables L2 caching across VINs of the same trim group
 * @returns {Promise<Array<{ base64, mediaType, url, source: 'vinaudit' }>>}
 */
export async function fetchVinAuditImages(vin, opts = {}) {
  if (!vin || typeof vin !== 'string') return [];
  const l1Key = `${vin}|${opts.pose || 'front_right'}|${opts.size || 'medium'}|${opts.color || 'white'}`;
  if (_l1.has(l1Key)) return _l1.get(l1Key);

  // L2: Firestore by year-make-model
  const l2Key = buildVehicleKey(opts.vehicle, opts);
  if (l2Key) {
    const cached = await readFirestoreCache(l2Key);
    if (cached) {
      dlog('L2 cache hit', { vin, l2Key, count: cached.length });
      _l1.set(l1Key, cached);
      return cached;
    }
  }

  // L3: hit the proxy (which hits VinAudit + costs us $1).
  const params = new URLSearchParams({ vin });
  if (opts.pose) params.set('pose', opts.pose);
  if (opts.size) params.set('size', opts.size);
  if (opts.color) params.set('color', opts.color);

  try {
    const res = await fetch(`/api/vinaudit-images?${params.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // 400 with "not supported" is expected data-gap (new model years etc.)
      // — log calmly, not as a warning. Other statuses still warn.
      const isUnsupportedVin =
        res.status === 400 &&
        Array.isArray(body?.error) &&
        body.error.some((m) => typeof m === 'string' && m.toLowerCase().includes('not supported'));
      if (isUnsupportedVin) {
        dlog('fetchVinAuditImages: VIN not in supported YMMT list', { vin });
      } else {
        dwarn('fetchVinAuditImages non-OK', { status: res.status, error: body?.error });
      }
      _l1.set(l1Key, []);
      return [];
    }
    const data = await res.json();
    // Two consumers need different shapes off the same response:
    //   - Tripo / Replicate pipelines want { base64, mediaType }
    //   - <img src> in Car Images wants a URL — synthesized as a data URL
    const images = Array.isArray(data?.images)
      ? data.images
          .filter((i) => i?.base64 && i?.mediaType)
          .map((i) => ({
            base64: i.base64,
            mediaType: i.mediaType,
            url: `data:${i.mediaType};base64,${i.base64}`,
            source: 'vinaudit',
          }))
      : [];
    dlog('fetchVinAuditImages ok (paid)', { vin, count: images.length });
    _l1.set(l1Key, images);

    // Write-through to L2 so future analyses on the same trim group skip
    // the paid call. Fire-and-forget — don't block the return.
    if (l2Key && images.length > 0) {
      writeFirestoreCache(l2Key, images, vin);
    }
    return images;
  } catch (err) {
    dwarn('fetchVinAuditImages threw', err);
    _l1.set(l1Key, []);
    return [];
  }
}

export function isVinAuditConfigured() {
  return true;
}
