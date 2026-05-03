// VinAudit Vehicle Images API client.
//
// STATUS: stubbed. As of 2026-05, the VinAudit Vehicle Images API requires a
// paid subscription tier and we have not yet provisioned access (see emails
// w/ marinel@vinaudit.com). The function shape and call-site wiring are in
// place so that the only change required when access lands is replacing the
// body of `fetchVinAuditImages` with a real fetch against the documented
// endpoint, plus adding a Cloudflare Pages Function at /api/vinaudit-images
// that injects the API key.
//
// Until then this returns an empty array, which the UI gracefully handles by
// rendering only user-uploaded photos in the Car Images tab.

const dlog = (...args) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('%c[vinaudit]', 'color:#9333ea;font-weight:bold', ...args);
  }
};

// Module-level cache so re-opening the same report doesn't re-hit the network.
const _cache = new Map();

/**
 * Fetch VinAudit stock images for a VIN.
 * @param {string} vin
 * @returns {Promise<Array<{ url: string, source: 'vinaudit', width?: number, height?: number }>>}
 */
export async function fetchVinAuditImages(vin) {
  if (!vin || typeof vin !== 'string') return [];
  if (_cache.has(vin)) return _cache.get(vin);

  // TODO(vinaudit-paid): replace stub with real call once API key is provisioned.
  // Expected shape (from /api/vinaudit-images?vin=...):
  //   { images: [{ url, width, height }, ...] }
  //
  // try {
  //   const res = await fetch(`/api/vinaudit-images?vin=${encodeURIComponent(vin)}`);
  //   if (!res.ok) return [];
  //   const data = await res.json();
  //   const images = Array.isArray(data?.images)
  //     ? data.images.map((i) => ({ url: i.url, source: 'vinaudit', width: i.width, height: i.height }))
  //     : [];
  //   _cache.set(vin, images);
  //   return images;
  // } catch (err) {
  //   dlog('fetchVinAuditImages threw', err);
  //   return [];
  // }

  dlog('fetchVinAuditImages stub — returning [] (VinAudit API key not provisioned)', { vin });
  _cache.set(vin, []);
  return [];
}

export function isVinAuditConfigured() {
  // Flip this once /api/vinaudit-images is wired up + key set in wrangler.toml.
  return false;
}
