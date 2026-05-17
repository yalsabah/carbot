import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Store, MapPin, Loader2 } from 'lucide-react';
import { DEALER_CATALOG, dealerPinsNearUser } from '../utils/dealerCatalog';

// Leaflet ships with broken default-marker URLs in webpack builds (the
// asset paths get rewritten and 404). Override globally so default markers
// don't try to load. We render custom SVG-based DivIcons below anyway.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: '',
  iconUrl: '',
  shadowUrl: '',
});

// Custom marker for a dealer chain pin. SVG-based so it inherits CSS colors
// and stays sharp on retina without an external asset. Uses the chain's
// brand-ish color and the store glyph used elsewhere in the modal.
const dealerIcon = (color = '#2563eb') =>
  L.divIcon({
    className: 'dealer-pin',
    html: `
      <div style="
        width: 28px; height: 28px;
        border-radius: 999px;
        background: ${color};
        border: 2px solid #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        display: flex; align-items: center; justify-content: center;
      ">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
             stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 7l1-4h18l1 4M2 7v13a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7M2 7h20"/>
        </svg>
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

// User location pin — bigger, accented, with a pulse so it stands out.
const userIcon = L.divIcon({
  className: 'user-pin',
  html: `
    <div style="position: relative; width: 18px; height: 18px;">
      <div style="
        position: absolute; inset: -8px;
        border-radius: 999px;
        background: rgba(37,99,235,0.25);
        animation: dealer-map-pulse 2s ease-out infinite;
      "></div>
      <div style="
        position: relative;
        width: 18px; height: 18px;
        border-radius: 999px;
        background: #2563eb;
        border: 3px solid #fff;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
      "></div>
    </div>
    <style>
      @keyframes dealer-map-pulse {
        0%   { transform: scale(0.6); opacity: 0.9; }
        100% { transform: scale(2.2); opacity: 0; }
      }
    </style>
  `,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// Helper that flies the map to the user's location once we have it. Lives
// inside the MapContainer so it can hook into the leaflet instance.
function RecenterOnUser({ userLoc }) {
  const map = useMap();
  useEffect(() => {
    if (userLoc) {
      map.flyTo([userLoc.lat, userLoc.lng], 6, { duration: 0.8 });
    }
  }, [userLoc, map]);
  return null;
}

// Critical: when the modal slides the map pane in/out, the container's
// width animates from 0 → 46% over ~450ms. Leaflet measures its canvas
// ONCE on mount and never resizes on its own, so pins drift outside the
// visible tiles and big empty bands appear next to a too-narrow map.
// ResizeObserver fires for every intermediate size during the CSS
// transition, and `map.invalidateSize()` re-renders the tile grid +
// reprojects markers at the new dimensions.
//
// Guards needed: the modal's close animation tears down the map mid-pan,
// so a queued requestAnimationFrame callback can fire after Leaflet has
// already nulled out internal state. Without the try/catch + mounted
// flag, this throws "Cannot read properties of undefined (reading
// '_leaflet_pos')" from inside the invalidateSize chain.
function ResizeHandler() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (!container || typeof ResizeObserver === 'undefined') return;
    let mounted = true;
    const safeInvalidate = () => {
      if (!mounted) return;
      try {
        // Confirm the map is still attached to the DOM before measuring —
        // if its container has been detached we'd hit the _leaflet_pos
        // crash deep inside Leaflet.
        const el = map.getContainer && map.getContainer();
        if (!el || !el.parentNode) return;
        map.invalidateSize({ animate: false });
      } catch {
        // Map is being torn down — swallow the race.
      }
    };
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(safeInvalidate);
    });
    ro.observe(container);
    // Belt-and-suspenders: also invalidate right after mount in case the
    // very-first paint had a weird transient size.
    requestAnimationFrame(safeInvalidate);
    return () => {
      mounted = false;
      ro.disconnect();
    };
  }, [map]);
  return null;
}

// Pick a brand-ish color for each chain so pins are distinguishable. Falls
// back to neutral blue.
const CHAIN_COLOR = {
  carmax:        '#fbbf24', // amber
  carvana:       '#06b6d4', // cyan
  autonation:    '#dc2626', // red
  kbb_ico:       '#16a34a', // green
  edmunds_ico:   '#a855f7', // purple
  webuyanycar:   '#f97316', // orange
  peddle:        '#888882', // gray (last-resort)
};

export default function DealersMap({ height = 360 }) {
  const [userLoc, setUserLoc] = useState(null);
  const [geoStatus, setGeoStatus] = useState('pending'); // pending | granted | denied | unsupported

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeoStatus('unsupported');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoStatus('granted');
      },
      () => setGeoStatus('denied'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  }, []);

  // If the user denied geolocation, fall back to a US-centered view with
  // pins distributed across major metros. Still useful to see the chain
  // footprint even without precise location.
  const fallbackCenter = { lat: 39.5, lng: -98.35 };
  const center = userLoc || fallbackCenter;

  const pins = useMemo(
    () => dealerPinsNearUser(userLoc || fallbackCenter, { max: 8 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userLoc?.lat, userLoc?.lng],
  );

  return (
    <div
      className="rounded-xl overflow-hidden relative"
      style={{ height, border: '1px solid var(--color-border)' }}
    >
      {geoStatus === 'pending' && (
        <div
          className="absolute inset-0 z-[1000] flex items-center justify-center gap-2 text-xs"
          style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}
        >
          <Loader2 size={14} className="animate-spin" />
          Locating you…
        </div>
      )}
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={userLoc ? 6 : 4}
        // Native scroll-wheel zoom + trackpad pinch + double-click zoom
        // all enabled. Leaflet defaults already include doubleClickZoom
        // and touchZoom; we just need to flip scrollWheelZoom on.
        // `wheelPxPerZoomLevel: 80` makes each notch zoom about one full
        // level instead of Leaflet's default ~60 which felt sluggish.
        scrollWheelZoom
        wheelPxPerZoomLevel={80}
        // Smooth zoom animation between levels. Off by default in some
        // builds; on makes pinch + wheel feel native.
        zoomAnimation
        style={{ height: '100%', width: '100%' }}
      >
        {/* Dark-themed map tiles — CartoDB's "dark_all" matches the
            screenshot the user shared (deep navy land, white labels).
            No API key required. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
        />

        <ResizeHandler />

        {userLoc && (
          <Marker position={[userLoc.lat, userLoc.lng]} icon={userIcon}>
            <Popup>You are here</Popup>
          </Marker>
        )}
        <RecenterOnUser userLoc={userLoc} />

        {pins.map((pin) => {
          const chain = DEALER_CATALOG.find((d) => d.id === pin.chainId);
          return (
            <Marker
              key={pin.id}
              position={[pin.lat, pin.lng]}
              icon={dealerIcon(CHAIN_COLOR[pin.chainId] || '#2563eb')}
            >
              <Popup>
                <div style={{ minWidth: 180 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>
                    {pin.chainName}
                  </div>
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>
                    {pin.city} · ~{pin.distance} mi
                  </div>
                  {chain && (
                    <>
                      <div style={{ fontSize: 11, marginBottom: 6 }}>{chain.blurb}</div>
                      <a
                        href={chain.storeLocatorUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: '#2563eb', fontWeight: 600 }}
                      >
                        Find nearest store →
                      </a>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Bottom-left disclaimer: pin locations are approximate. Once we
          wire up Nominatim or Google Places this disclaimer can go. */}
      <div
        className="absolute bottom-2 left-2 px-2 py-1 rounded text-[10px] z-[400]"
        style={{
          background: 'rgba(0,0,0,0.7)',
          color: '#cbcbcb',
          pointerEvents: 'none',
          backdropFilter: 'blur(6px)',
        }}
      >
        <MapPin size={9} className="inline mr-1" />
        Approximate locations. Use the chain locator for exact addresses.
      </div>

      {/* Geolocation denied/unsupported fallback message */}
      {(geoStatus === 'denied' || geoStatus === 'unsupported') && (
        <div
          className="absolute top-2 left-2 px-3 py-1.5 rounded-lg text-[11px] z-[400]"
          style={{
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            backdropFilter: 'blur(6px)',
          }}
        >
          <Store size={11} className="inline mr-1" />
          {geoStatus === 'denied'
            ? 'Location blocked — showing US-wide view'
            : 'Geolocation not supported — showing US-wide view'}
        </div>
      )}
    </div>
  );
}
