// VinAudit Vehicle Images API client.
//
// Hits our own /api/vinaudit-images Pages Function, which holds the
// VinAudit key server-side and proxies to the upstream
// https://images.vinaudit.com/v3/images endpoint.
//
// VinAudit charges per API call ($0.50). The slug-keyed 3D model cache
// is what protects us from re-charging: a successful Tripo run on the
// returned image lands a GLB in R2, and every future user of the same
// trim hits R2 without re-calling here. So this function gets invoked
// at most once per unique trim (year/make/model/trim) across the entire
// userbase lifetime.

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

// Module-level cache. Keyed by VIN so the same report-reopen during a
// session doesn't even hit our own proxy. Stays empty across page
// reloads — by then the GLB is in R2 and we shouldn't be calling at all.
const _cache = new Map();

/**
 * Fetch a stock photo for the given VIN, ready to feed Tripo3D.
 *
 * @param {string} vin
 * @param {object} [opts]
 * @param {string} [opts.pose]   - front_right (default), front_left, front, back_left, back_right, back, right, left
 * @param {string} [opts.size]   - medium (default), small, large, xlarge, full
 * @param {string} [opts.color]  - white (default), black, gray, silver, blue, red, ...
 * @returns {Promise<Array<{ base64: string, mediaType: string, source: 'vinaudit' }>>}
 */
export async function fetchVinAuditImages(vin, opts = {}) {
  if (!vin || typeof vin !== 'string') return [];
  const cacheKey = `${vin}|${opts.pose || 'front_right'}|${opts.size || 'medium'}|${opts.color || 'white'}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  const params = new URLSearchParams({ vin });
  if (opts.pose) params.set('pose', opts.pose);
  if (opts.size) params.set('size', opts.size);
  if (opts.color) params.set('color', opts.color);

  try {
    const res = await fetch(`/api/vinaudit-images?${params.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      dwarn('fetchVinAuditImages non-OK', { status: res.status, error: body?.error });
      _cache.set(cacheKey, []);
      return [];
    }
    const data = await res.json();
    // Two consumers need different shapes off the same response:
    //   - Tripo pipeline wants { base64, mediaType } to submit directly
    //   - The Car Images <img src> tag wants a URL (use a data URL so
    //     the browser doesn't need a second fetch).
    // Build both so neither consumer has to care which one it gets.
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
    dlog('fetchVinAuditImages ok', { vin, count: images.length });
    _cache.set(cacheKey, images);
    return images;
  } catch (err) {
    dwarn('fetchVinAuditImages threw', err);
    _cache.set(cacheKey, []);
    return [];
  }
}

export function isVinAuditConfigured() {
  // The client can't directly probe whether the server has VINAUDIT_API_KEY
  // configured (that's by design — secrets stay server-side). We assume
  // configured and let fetchVinAuditImages return [] gracefully on the
  // upstream 500 if the key is missing. Toggle this off only if you want
  // the UI to hide VinAudit features entirely.
  return true;
}
