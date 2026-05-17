// Curated catalog of car-buying services for the Sell-mode dealer panel.
//
// This is intentionally hand-maintained rather than fetched from an API:
//   - The list of major chains is small and stable (~10 names).
//   - Each entry's policy (in-person inspection? online quote? pickup?) is
//     a published fact, not user-supplied data.
//   - Pricing percentages are rough industry averages — Claude is asked to
//     produce a vehicle-specific offer estimate per dealer in the report,
//     which overlays these static fields when present.
//
// Categories:
//   instant_offer — online quote, lock-in price, drop-off OR pickup. Lowest
//                   friction, lowest price.
//   inspection_required — needs an in-person look at the vehicle before final
//                         offer. Usually pays more than instant_offer.
//   private_buyer — they don't buy; they connect you with private buyers
//                   (Cars.com, AutoTrader). Highest price but most work.
//   trade_in — local dealer of the same make. Best when buying a replacement.

export const DEALER_CATALOG = [
  {
    id: 'carmax',
    name: 'CarMax',
    category: 'inspection_required',
    requiresInspection: true,
    inspectionType: 'in_person',
    inspectionLocation: 'CarMax store (drop-off)',
    speed: 'Same-day quote, 7-day price lock',
    offerVsMarket: -8,
    storeLocatorUrl: 'https://www.carmax.com/stores',
    sellUrl: 'https://www.carmax.com/sell-my-car',
    blurb: 'Largest used-car retailer. Strong reputation, no haggling, fast payment.',
    pros: ['No-haggle pricing', 'Same-day payment', '7-day price lock'],
    cons: ['Must drive to a CarMax store', 'Below private-party price'],
    locationCount: '250+ US stores',
  },
  {
    id: 'carvana',
    name: 'Carvana',
    category: 'instant_offer',
    requiresInspection: false,
    inspectionType: 'video',
    inspectionLocation: 'Online — they pick up',
    speed: 'Instant online quote, pickup in 1-2 days',
    offerVsMarket: -10,
    storeLocatorUrl: 'https://www.carvana.com/sell-my-car',
    sellUrl: 'https://www.carvana.com/sell-my-car',
    blurb: 'Fully online. Quote, sign, schedule pickup — no store visit.',
    pros: ['100% online process', 'Free pickup', 'Quote locked for 7 days'],
    cons: ['Quote can drop after inspection at pickup', 'Lower than CarMax avg'],
    locationCount: 'Nationwide pickup',
  },
  {
    id: 'autonation',
    name: 'AutoNation',
    category: 'inspection_required',
    requiresInspection: true,
    inspectionType: 'in_person',
    inspectionLocation: 'AutoNation store',
    speed: 'Instant online estimate, in-person finalize',
    offerVsMarket: -7,
    storeLocatorUrl: 'https://www.autonation.com/locations',
    sellUrl: 'https://www.autonation.com/sell-or-trade-your-car',
    blurb: 'Large dealer group. Often beats CarMax slightly on offer.',
    pros: ['Competitive offers', 'Trade-in bonus if buying from AutoNation'],
    cons: ['Must drive to store', 'Finalized price after in-person inspection'],
    locationCount: '300+ US dealerships',
  },
  {
    id: 'kbb_ico',
    name: 'KBB Instant Cash Offer',
    category: 'instant_offer',
    requiresInspection: true,
    inspectionType: 'in_person',
    inspectionLocation: 'Participating dealer (varies)',
    speed: '7-day offer, redeem at partner dealer',
    offerVsMarket: -9,
    storeLocatorUrl: 'https://www.kbb.com/instant-cash-offer/',
    sellUrl: 'https://www.kbb.com/instant-cash-offer/',
    blurb: 'KBB-branded offer redeemable at thousands of partner dealers.',
    pros: ['Multiple participating dealers', 'KBB transparency'],
    cons: ['Each dealer may re-negotiate after inspection'],
    locationCount: 'Thousands of partner dealers',
  },
  {
    id: 'edmunds_ico',
    name: 'Edmunds Instant Offer',
    category: 'instant_offer',
    requiresInspection: true,
    inspectionType: 'in_person',
    inspectionLocation: 'Partner dealer',
    speed: '7-day offer at partner dealer',
    offerVsMarket: -9,
    storeLocatorUrl: 'https://www.edmunds.com/sell-car/',
    sellUrl: 'https://www.edmunds.com/sell-car/',
    blurb: 'Edmunds-aggregated offer redeemable at a local partner dealer.',
    pros: ['Aggregated from multiple buyers', 'Familiar Edmunds pricing'],
    cons: ['Finalized at dealer after inspection'],
    locationCount: 'National network',
  },
  {
    id: 'webuyanycar',
    name: 'We Buy Any Car',
    category: 'inspection_required',
    requiresInspection: true,
    inspectionType: 'in_person',
    inspectionLocation: 'Local branch (quick visit)',
    speed: 'Online quote, ~30 min in-person finalize',
    offerVsMarket: -12,
    storeLocatorUrl: 'https://www.webuyanycar.com/locations/',
    sellUrl: 'https://www.webuyanycar.com/',
    blurb: 'Fast in-person finalize. Takes any condition including non-running.',
    pros: ['Accepts almost any condition', 'Quick visit (~30 min)'],
    cons: ['Lower offers than CarMax/Carvana', 'Quote often drops in person'],
    locationCount: '150+ US branches',
  },
  {
    id: 'peddle',
    name: 'Peddle',
    category: 'instant_offer',
    requiresInspection: false,
    inspectionType: 'none',
    inspectionLocation: 'Online — tow-away pickup',
    speed: 'Instant quote, pickup in 1-3 days',
    offerVsMarket: -25,
    storeLocatorUrl: 'https://www.peddle.com/',
    sellUrl: 'https://www.peddle.com/',
    blurb: 'Best for damaged, non-running, or salvage vehicles. Tow-away pickup.',
    pros: ['Buys non-running cars', 'Free pickup', 'No inspection'],
    cons: ['Much lower offers — last resort for working cars'],
    locationCount: 'Nationwide tow-away pickup',
  },
  {
    id: 'cars_com_marketplace',
    name: 'Cars.com Marketplace',
    category: 'private_buyer',
    requiresInspection: false,
    inspectionType: 'none',
    inspectionLocation: 'Self-listed, meet buyers yourself',
    speed: 'Average 30-45 days to sell',
    offerVsMarket: 0,
    storeLocatorUrl: 'https://www.cars.com/sell/',
    sellUrl: 'https://www.cars.com/sell/',
    blurb: "List it yourself. You meet buyers. Highest possible price but most effort.",
    pros: ['Closest to KBB Private Party value', 'Full control of negotiation'],
    cons: ['You handle test drives, paperwork, payment safety'],
    locationCount: 'Online listing platform',
  },
  {
    id: 'autotrader',
    name: 'AutoTrader',
    category: 'private_buyer',
    requiresInspection: false,
    inspectionType: 'none',
    inspectionLocation: 'Self-listed, meet buyers yourself',
    speed: 'Average 30-60 days to sell',
    offerVsMarket: 0,
    storeLocatorUrl: 'https://www.autotrader.com/sell-my-car',
    sellUrl: 'https://www.autotrader.com/sell-my-car',
    blurb: 'Long-running listing platform. Strong buyer audience for enthusiast cars.',
    pros: ['Reaches enthusiast buyers', 'Listing fee, no commission'],
    cons: ['Paid listing', 'You handle the sale logistics'],
    locationCount: 'Online listing platform',
  },
];

// Approximate centroids for the top 30 US metro areas. Used as fallback
// dealer locations when we don't have real geocoded store coordinates and
// the user's geolocation hasn't been granted. These are coarse but good
// enough to draw a representative map of "where you could sell this car."
//
// In a future iteration this would be replaced by a Nominatim or Google
// Places call ("CarMax near {lat,lng}") to get real per-chain store locs.
export const MAJOR_METROS = [
  { name: 'New York, NY',          lat: 40.7128,  lng: -74.0060 },
  { name: 'Los Angeles, CA',       lat: 34.0522,  lng: -118.2437 },
  { name: 'Chicago, IL',           lat: 41.8781,  lng: -87.6298 },
  { name: 'Houston, TX',           lat: 29.7604,  lng: -95.3698 },
  { name: 'Phoenix, AZ',           lat: 33.4484,  lng: -112.0740 },
  { name: 'Philadelphia, PA',      lat: 39.9526,  lng: -75.1652 },
  { name: 'San Antonio, TX',       lat: 29.4241,  lng: -98.4936 },
  { name: 'San Diego, CA',         lat: 32.7157,  lng: -117.1611 },
  { name: 'Dallas, TX',            lat: 32.7767,  lng: -96.7970 },
  { name: 'Austin, TX',            lat: 30.2672,  lng: -97.7431 },
  { name: 'Jacksonville, FL',      lat: 30.3322,  lng: -81.6557 },
  { name: 'Fort Worth, TX',        lat: 32.7555,  lng: -97.3308 },
  { name: 'Columbus, OH',          lat: 39.9612,  lng: -82.9988 },
  { name: 'Charlotte, NC',         lat: 35.2271,  lng: -80.8431 },
  { name: 'San Francisco, CA',     lat: 37.7749,  lng: -122.4194 },
  { name: 'Indianapolis, IN',      lat: 39.7684,  lng: -86.1581 },
  { name: 'Seattle, WA',           lat: 47.6062,  lng: -122.3321 },
  { name: 'Denver, CO',            lat: 39.7392,  lng: -104.9903 },
  { name: 'Washington, DC',        lat: 38.9072,  lng: -77.0369 },
  { name: 'Boston, MA',            lat: 42.3601,  lng: -71.0589 },
  { name: 'Nashville, TN',         lat: 36.1627,  lng: -86.7816 },
  { name: 'Detroit, MI',           lat: 42.3314,  lng: -83.0458 },
  { name: 'Portland, OR',          lat: 45.5152,  lng: -122.6784 },
  { name: 'Las Vegas, NV',         lat: 36.1699,  lng: -115.1398 },
  { name: 'Atlanta, GA',           lat: 33.7490,  lng: -84.3880 },
  { name: 'Miami, FL',             lat: 25.7617,  lng: -80.1918 },
  { name: 'Minneapolis, MN',       lat: 44.9778,  lng: -93.2650 },
  { name: 'Tampa, FL',             lat: 27.9506,  lng: -82.4572 },
  { name: 'Orlando, FL',           lat: 28.5383,  lng: -81.3792 },
  { name: 'Salt Lake City, UT',    lat: 40.7608,  lng: -111.8910 },
];

// Haversine — distance between two lat/lng points in miles. Used to sort
// metros by proximity to the user.
export function distanceMiles(a, b) {
  if (!a || !b) return Infinity;
  const R = 3958.8; // Earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Resolve a list of dealer "store" pins around a user location. We don't
// have real geocoded store data here, so each pin = a nearby metro where
// the chain almost certainly has a presence. Categorized chains
// (instant_offer, inspection_required) get pins; private_buyer / online-only
// chains don't.
export function dealerPinsNearUser(userLoc, opts = {}) {
  const max = opts.max || 8;
  const sorted = [...MAJOR_METROS]
    .map((m) => ({ ...m, distance: distanceMiles(userLoc, m) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, max);
  // For each near-metro, attach the chains that almost-always have a
  // presence in major US metros.
  const PHYSICAL_CHAINS = DEALER_CATALOG.filter(
    (d) => d.category === 'inspection_required' || d.category === 'instant_offer',
  );
  return sorted.flatMap((metro) =>
    PHYSICAL_CHAINS.slice(0, 3).map((chain) => ({
      id: `${metro.name}-${chain.id}`,
      chainId: chain.id,
      chainName: chain.name,
      city: metro.name,
      lat: metro.lat + (Math.random() - 0.5) * 0.08, // small jitter so pins don't overlap
      lng: metro.lng + (Math.random() - 0.5) * 0.08,
      distance: Math.round(metro.distance),
    })),
  );
}
