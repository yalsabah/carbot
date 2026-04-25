import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Award, DollarSign, BarChart2, TrendingDown, Cpu, RotateCcw, Sliders, RefreshCw } from 'lucide-react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import VehicleCanvas from './VehicleCanvas';

const fmt = (n, prefix = '') => {
  if (n == null) return '—';
  if (typeof n === 'string') return n;
  return prefix + n.toLocaleString();
};
const fmtPct = n => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

function VerdictBadge({ rating, large }) {
  const cls = { Great: 'verdict-great', Good: 'verdict-good', Fair: 'verdict-fair', Bad: 'verdict-bad' }[rating] || 'verdict-gray';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-bold ${cls} ${large ? 'px-5 py-2 text-base' : 'px-3 py-1 text-sm'}`}>
      <Award size={large ? 16 : 14} />
      {rating} Deal
    </span>
  );
}

function MetricCard({ m }) {
  const colors = { green: '#1a7a45', orange: '#b7550c', red: '#c0392b', gray: 'var(--color-muted)' };
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <div className="text-xl font-bold" style={{ color: colors[m.color] || colors.gray }}>{m.value}</div>
      <div className="text-xs font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--color-muted)' }}>{m.label}</div>
      {m.sub && <div className="text-xs mt-1" style={{ color: 'var(--color-muted)' }}>{m.sub}</div>}
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>
        {icon} {title}
      </h3>
      {children}
    </div>
  );
}

function Row({ label, value, color }) {
  return (
    <div className="flex justify-between text-sm py-1" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <span style={{ color: 'var(--color-muted)' }}>{label}</span>
      <span style={{ color: color || 'var(--color-text)', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ─── Body color swatches ──────────────────────────────────────────────────────
// 8 presets that span the typical paint range. `metalness` and `roughness` are
// tuned per-color so light colors still look like paint and not plastic.
// "id" is the only thing persisted to URL/state; everything else is presentation.
const BODY_COLORS = [
  { id: 'white',  label: 'White',  hex: '#eef0f2', metalness: 0.35, roughness: 0.45 },
  { id: 'silver', label: 'Silver', hex: '#b8bdc4', metalness: 0.85, roughness: 0.30 },
  { id: 'grey',   label: 'Grey',   hex: '#5a5e63', metalness: 0.60, roughness: 0.40 },
  { id: 'black',  label: 'Black',  hex: '#1a1a1c', metalness: 0.55, roughness: 0.30 },
  { id: 'red',    label: 'Red',    hex: '#b8211c', metalness: 0.50, roughness: 0.35 },
  { id: 'blue',   label: 'Blue',   hex: '#1d3a8a', metalness: 0.50, roughness: 0.35 },
  { id: 'green',  label: 'Green',  hex: '#1e5c3a', metalness: 0.50, roughness: 0.35 },
  { id: 'yellow', label: 'Yellow', hex: '#d9a300', metalness: 0.40, roughness: 0.40 },
];

// Map a CARFAX/VIN-decoded color string to one of our preset IDs. Best effort.
function inferColorIdFromVehicle(vehicle) {
  const c = (vehicle?.color || '').toLowerCase();
  if (!c) return null;
  if (/white|pearl|ivory/.test(c)) return 'white';
  if (/silver|alumin/.test(c)) return 'silver';
  if (/black|onyx|obsidian/.test(c)) return 'black';
  if (/grey|gray|graphite|gunmetal|charcoal/.test(c)) return 'grey';
  if (/red|crimson|scarlet|maroon|burgundy/.test(c)) return 'red';
  if (/blue|navy|cobalt|azure|sapphire/.test(c)) return 'blue';
  if (/green|emerald|forest|olive/.test(c)) return 'green';
  if (/yellow|gold|amber/.test(c)) return 'yellow';
  return null;
}

// Walk the scene graph and recolor body panels only. Heuristics exclude wheels,
// glass, lights, etc. Originals are cached on first call so we always recolor
// from the source — no compounding tints if the user clicks multiple swatches.
function applyBodyColor(scene, swatch) {
  if (!scene || !swatch) return;
  const isExcluded = (mat, mesh) => {
    const name = ((mesh.name || '') + ' ' + (mat?.name || '')).toLowerCase();
    if (/wheel|tire|tyre|rim|brake|caliper|window|glass|windshield|head\s*light|tail\s*light|light|mirror|grille|emblem|logo|plate|interior|seat/.test(name)) return true;
    if (mat?.transparent || (mat?.opacity != null && mat.opacity < 0.9)) return true;
    if (mat?.color) {
      // Skip near-black materials — likely tires or trim already baked.
      const { r, g, b } = mat.color;
      if (r < 0.08 && g < 0.08 && b < 0.08) return true;
    }
    return false;
  };

  scene.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    if (!obj.userData.__originalMat) {
      obj.userData.__originalMat = Array.isArray(obj.material)
        ? obj.material.map(m => m.clone())
        : obj.material.clone();
    }
    const recolor = (origMat) => {
      if (isExcluded(origMat, obj)) return origMat.clone();
      const next = origMat.clone();
      if (next.color) next.color.set(swatch.hex);
      if ('metalness' in next) next.metalness = swatch.metalness;
      if ('roughness' in next) next.roughness = swatch.roughness;
      next.needsUpdate = true;
      return next;
    };
    obj.material = Array.isArray(obj.userData.__originalMat)
      ? obj.userData.__originalMat.map(recolor)
      : recolor(obj.userData.__originalMat);
  });
}

// GLB model renderer using @react-three/fiber. Recolors body panels whenever
// `swatch` changes — purely visual, never refetches the GLB.
function GLBScene({ url, swatch }) {
  const { scene } = useGLTF(url);
  useEffect(() => {
    if (swatch) applyBodyColor(scene, swatch);
  }, [scene, swatch]);
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[5, 8, 5]} intensity={1.3} />
      <directionalLight position={[-5, 3, -3]} intensity={0.4} color="#88aaff" />
      <primitive object={scene} scale={1.2} position={[0, -0.5, 0]} />
      <OrbitControls autoRotate autoRotateSpeed={1.5} enableZoom={false} maxPolarAngle={Math.PI / 2} />
      <Environment preset="city" />
    </>
  );
}

function ColorSwatchRow({ activeId, onSelect }) {
  return (
    <div
      className="absolute left-0 right-0 flex items-center justify-center gap-2 px-4"
      style={{ bottom: 152, zIndex: 5 }}
    >
      <div
        className="flex items-center gap-1.5 px-3 py-2 rounded-full"
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          backdropFilter: 'blur(10px)',
        }}
      >
        {BODY_COLORS.map(c => {
          const active = c.id === activeId;
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              title={c.label}
              aria-label={`Color: ${c.label}`}
              className="rounded-full transition-all"
              style={{
                width: 22,
                height: 22,
                background: c.hex,
                border: active
                  ? '2px solid var(--color-accent)'
                  : '1px solid var(--color-border)',
                boxShadow: active ? '0 0 0 2px var(--color-surface)' : 'none',
                transform: active ? 'scale(1.15)' : 'scale(1)',
                cursor: 'pointer',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Derive a Three.js-compatible bodyStyle string from the vehicle report.
// Falls back to 'coupe' so the S5 always renders correctly by default.
function inferBodyStyle(vehicle) {
  if (!vehicle) return 'coupe';
  const model = (vehicle.model || '').toLowerCase();
  const trim  = (vehicle.trim  || '').toLowerCase();
  const combined = model + ' ' + trim;
  if (/suv|crossover|cx|rx|gx|x5|q7|q8|q5|explorer|pilot|tahoe|suburban|rav4|cr-v|tucson|santa fe/.test(combined)) return 'suv';
  if (/truck|pickup|f-150|silverado|tundra|tacoma|ranger|ram 1/.test(combined)) return 'suv'; // close enough
  if (/coupe|convertible|s5|s4|s3|m4|m2|c63|amg|gt|911|corvette|mustang|camaro|challenger/.test(combined)) return 'coupe';
  return 'sedan';
}

// ─── Interactive financing calculator ────────────────────────────────────────
// Lets the user tweak price / down / APR / term and see monthly, total interest,
// and total cost recalc live. Seeded from the AI report; "Reset" restores it.

function calcMonthly(principal, aprPct, months) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = (aprPct || 0) / 100 / 12;
  if (r === 0) return principal / months;
  const pow = Math.pow(1 + r, months);
  return (principal * r * pow) / (pow - 1);
}

const TERM_PRESETS = [36, 48, 60, 72, 84];

function NumberField({ label, value, onChange, prefix, suffix, step = 1, min = 0, max }) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>{label}</span>
      <div
        className="mt-1 flex items-center rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue-500"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        {prefix && <span className="pl-2.5 text-sm" style={{ color: 'var(--color-muted)' }}>{prefix}</span>}
        <input
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : ''}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v === '' ? 0 : parseFloat(v));
          }}
          className="w-full bg-transparent px-2 py-1.5 text-sm outline-none"
          style={{ color: 'var(--color-text)' }}
        />
        {suffix && <span className="pr-2.5 text-sm" style={{ color: 'var(--color-muted)' }}>{suffix}</span>}
      </div>
    </label>
  );
}

function FinancingEditor({ financing, pricing, onConfirmEdits, isReanalyzing }) {
  // Seed values from the AI report. Fall back sensibly if missing.
  const seed = useMemo(() => ({
    price: pricing?.askingPrice ?? financing?.totalCost ?? 0,
    downPayment: financing?.downPayment ?? 0,
    apr: financing?.apr ?? 0,
    termMonths: financing?.termMonths ?? 60,
  }), [pricing, financing]);

  const [price, setPrice] = useState(seed.price);
  const [downPayment, setDownPayment] = useState(seed.downPayment);
  const [apr, setApr] = useState(seed.apr);
  const [termMonths, setTermMonths] = useState(seed.termMonths);

  // Re-seed when a new report is opened.
  useEffect(() => {
    setPrice(seed.price);
    setDownPayment(seed.downPayment);
    setApr(seed.apr);
    setTermMonths(seed.termMonths);
  }, [seed]);

  const principal = Math.max(0, (price || 0) - (downPayment || 0));
  const monthly = calcMonthly(principal, apr, termMonths);
  const totalPaid = monthly * termMonths;
  const totalInterest = Math.max(0, totalPaid - principal);
  const totalCost = totalPaid + (downPayment || 0);

  const edited =
    price !== seed.price ||
    downPayment !== seed.downPayment ||
    apr !== seed.apr ||
    termMonths !== seed.termMonths;

  const reset = () => {
    setPrice(seed.price);
    setDownPayment(seed.downPayment);
    setApr(seed.apr);
    setTermMonths(seed.termMonths);
  };

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
          <BarChart2 size={13} /> Financing
          <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-surface)', color: 'var(--color-muted)', border: '1px solid var(--color-border)' }}>
            <Sliders size={9} /> Interactive
          </span>
        </h3>
        {edited && (
          <button
            onClick={reset}
            className="flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg transition-all hover:opacity-80"
            style={{ color: 'var(--color-muted)', border: '1px solid var(--color-border)' }}
          >
            <RotateCcw size={11} /> Reset
          </button>
        )}
      </div>

      {/* Inputs */}
      <div className="grid grid-cols-2 gap-2.5 mb-3">
        <NumberField label="Sale Price" prefix="$" step={100} value={price} onChange={setPrice} />
        <NumberField label="Down Payment" prefix="$" step={100} value={downPayment} onChange={setDownPayment} max={price} />
        <NumberField label="APR" suffix="%" step={0.1} min={0} max={30} value={apr} onChange={setApr} />
        <div>
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Term</span>
          <div className="mt-1 flex gap-1">
            {TERM_PRESETS.map((t) => {
              const active = termMonths === t;
              return (
                <button
                  key={t}
                  onClick={() => setTermMonths(t)}
                  className="flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all"
                  style={{
                    background: active ? '#2563eb' : 'var(--color-surface)',
                    color: active ? '#fff' : 'var(--color-muted)',
                    border: active ? '1px solid #2563eb' : '1px solid var(--color-border)',
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Computed results */}
      <div className="grid grid-cols-3 gap-2 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>${Math.round(monthly).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Monthly</div>
        </div>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: totalInterest > 0 ? '#b7550c' : 'var(--color-text)' }}>${Math.round(totalInterest).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Interest</div>
        </div>
        <div className="rounded-lg p-2.5 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>${Math.round(totalCost).toLocaleString()}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: 'var(--color-muted)' }}>Total Cost</div>
        </div>
      </div>

      {edited && (
        <div className="mt-3 pt-3 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          <p className="text-[11px] italic flex-1" style={{ color: 'var(--color-muted)' }}>
            Custom scenario — AI rating not yet updated.
          </p>
          {onConfirmEdits && (
            <button
              onClick={() => onConfirmEdits({ price, downPayment, apr, termMonths, monthly, totalInterest, totalCost })}
              disabled={isReanalyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all whitespace-nowrap"
            >
              <RefreshCw size={12} className={isReanalyzing ? 'animate-spin' : ''} />
              {isReanalyzing ? 'Re-analyzing…' : 'Re-analyze with these numbers'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LeftPanel({ vehicleColor, glbUrl, modelStatus, vehicle, wheelColor, activeColorId, onColorSelect }) {
  const showGLB = !!glbUrl;
  const bodyStyle = inferBodyStyle(vehicle);
  const activeSwatch = BODY_COLORS.find(c => c.id === activeColorId) || null;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {showGLB ? (
        // Tier 1 — AI-generated GLB from Tripo3D, persisted in R2 by trim
        <Canvas camera={{ position: [3, 1.5, 4], fov: 45 }} style={{ background: 'transparent' }}>
          <GLBScene url={glbUrl} swatch={activeSwatch} />
        </Canvas>
      ) : (
        // Tier 2 — Pipeline procedural 3D (always — never fall back to photo)
        <VehicleCanvas
          vehicleColor={vehicleColor}
          wheelColor={wheelColor || 'gunmetal'}
          bodyStyle={bodyStyle}
        />
      )}

      {/* Color swatches — only meaningful when a real GLB is rendered */}
      {showGLB && (
        <ColorSwatchRow activeId={activeColorId} onSelect={onColorSelect} />
      )}

      {/* Hyper3D job status pill */}
      {!showGLB && modelStatus && modelStatus !== 'Done' && modelStatus !== 'Failed' && (
        <div
          className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium model-loading"
          style={{ background: 'var(--color-bg)', color: 'var(--color-text)', border: '1px solid var(--color-border)', backdropFilter: 'blur(8px)' }}
        >
          <Cpu size={11} />
          {modelStatus === 'Pending' ? 'Queued for 3D…' : 'Rendering 3D model…'}
        </div>
      )}

      {/* Pipeline badge */}
      {!showGLB && (
        <div
          className="absolute top-4 left-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
          style={{ background: 'var(--color-bg)', color: 'var(--color-muted)', backdropFilter: 'blur(10px)', border: '1px solid var(--color-border)' }}
        >
          <Cpu size={10} />
          Pipeline 3D · Procedural
        </div>
      )}
    </div>
  );
}

export default function ReportModal({ report, vehicleColor, vehicleLabel, imageBase64, imageMediaType, glbUrl, modelStatus, onClose, onConfirmEdits, isReanalyzing }) {
  const [exiting, setExiting] = useState(false);
  const closeTimer = useRef(null);
  // Color picker state. Seeded from the CARFAX/decoded color when possible so
  // the GLB opens with a tint that matches the actual car; user can override.
  const inferredColorId = inferColorIdFromVehicle(report?.vehicle);
  const [activeColorId, setActiveColorId] = useState(inferredColorId || 'white');

  const handleClose = () => {
    setExiting(true);
    closeTimer.current = setTimeout(onClose, 180);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!report) return null;
  const { vehicle, pricing, financing, depreciation, verdict, metrics } = report;

  return (
    <div
      className={`fixed inset-0 z-50 flex ${exiting ? 'modal-backdrop-exit' : 'modal-backdrop-enter'}`}
      style={{ background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(12px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className={`flex w-full h-full ${exiting ? '' : 'modal-content-enter'}`}
      >
        {/* Left: Vehicle visual — theme-aware (white in light, dark in dark) */}
        <div
          className="relative flex-shrink-0 overflow-hidden"
          style={{ width: '42%', background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)' }}
        >
          <LeftPanel
            vehicleColor={vehicleColor}
            glbUrl={glbUrl}
            modelStatus={modelStatus}
            vehicle={vehicle}
            wheelColor="gunmetal"
            activeColorId={activeColorId}
            onColorSelect={setActiveColorId}
          />

          {/* Bottom gradient + info — theme-aware fade so text stays legible */}
          <div
            className="absolute bottom-0 left-0 right-0 p-6"
            style={{ background: 'linear-gradient(transparent, var(--color-surface) 55%)' }}
          >
            <div className="font-bold text-xl leading-tight" style={{ color: 'var(--color-text)' }}>
              {vehicleLabel || `${vehicle?.year} ${vehicle?.make} ${vehicle?.model}`}
            </div>
            {vehicle?.trim && <div className="text-sm mt-0.5" style={{ color: 'var(--color-muted)' }}>{vehicle.trim}</div>}
            {vehicle?.mileage && <div className="text-sm mt-1" style={{ color: 'var(--color-muted)', opacity: 0.8 }}>{vehicle.mileage.toLocaleString()} miles</div>}
            <div className="mt-3">{verdict?.rating && <VerdictBadge rating={verdict.rating} large />}</div>
            <p className="text-xs mt-2" style={{ color: 'var(--color-muted)', opacity: 0.7 }}>Drag to rotate · auto-spins</p>
          </div>
        </div>

        {/* Right: Report */}
        <div className="flex-1 overflow-y-auto relative" style={{ background: 'var(--color-surface)' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-10" style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
            <div className="flex items-center justify-between px-6 py-4">
              <div>
                <h1 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
                  {vehicle?.year} {vehicle?.make} {vehicle?.model} {vehicle?.trim}
                </h1>
                {vehicle?.vin && <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--color-muted)' }}>VIN: {vehicle.vin}</p>}
              </div>
              <button onClick={handleClose} className="w-9 h-9 rounded-full flex items-center justify-center transition-all hover:opacity-70" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <X size={16} style={{ color: 'var(--color-muted)' }} />
              </button>
            </div>
            {isReanalyzing && (
              <div className="px-6 pb-3 -mt-1 flex items-center gap-2 text-xs font-medium" style={{ color: '#2563eb' }}>
                <RefreshCw size={12} className="animate-spin" />
                Re-analyzing with your updated financing terms…
              </div>
            )}
          </div>

          <div className="p-6 space-y-4">
            {verdict && (
              <div className="rounded-xl p-5" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
                <div className="flex items-center gap-3 mb-3"><VerdictBadge rating={verdict.rating} /></div>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>{verdict.summary}</p>
                {(verdict.pros?.length > 0 || verdict.cons?.length > 0) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    {verdict.pros?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#1a7a45' }}>Pros</p>
                        <ul className="space-y-1.5">
                          {verdict.pros.map((p, i) => <li key={i} className="flex gap-2 text-sm" style={{ color: 'var(--color-text)' }}><span style={{ color: '#1a7a45', flexShrink: 0 }}>+</span>{p}</li>)}
                        </ul>
                      </div>
                    )}
                    {verdict.cons?.length > 0 && (
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#c0392b' }}>Cons</p>
                        <ul className="space-y-1.5">
                          {verdict.cons.map((c, i) => <li key={i} className="flex gap-2 text-sm" style={{ color: 'var(--color-text)' }}><span style={{ color: '#c0392b', flexShrink: 0 }}>−</span>{c}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {metrics?.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>Key Metrics</h3>
                {/* 2x2 on small screens, 1x4 on large — both layouts stay
                    visually balanced regardless of metric count. */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {metrics.slice(0, 4).map((m, i) => <MetricCard key={i} m={m} />)}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {pricing && (
                <Section icon={<DollarSign size={13} />} title="Price Analysis">
                  <Row label="Asking Price" value={fmt(pricing.askingPrice, '$')} />
                  <Row label="KBB Value" value={fmt(pricing.kbbValue, '$')} />
                  <Row label="Market Average" value={fmt(pricing.marketAvg, '$')} />
                  <Row label="vs. Market" value={fmtPct(pricing.priceVsMarketPct)} color={pricing.priceVsMarketPct > 5 ? '#c0392b' : pricing.priceVsMarketPct < -5 ? '#1a7a45' : '#b7550c'} />
                </Section>
              )}
              {(financing || pricing) && (
                <FinancingEditor
                  financing={financing}
                  pricing={pricing}
                  onConfirmEdits={onConfirmEdits}
                  isReanalyzing={isReanalyzing}
                />
              )}
            </div>

            {depreciation && (
              <Section icon={<TrendingDown size={13} />} title="Depreciation Curve">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
                  {[
                    { label: 'Annual Rate', val: depreciation.annualRatePct != null ? `${depreciation.annualRatePct}%` : '—' },
                    { label: '1 Year', val: fmt(depreciation.projectedValue1yr, '$') },
                    { label: '3 Years', val: fmt(depreciation.projectedValue3yr, '$') },
                    { label: '5 Years', val: fmt(depreciation.projectedValue5yr, '$') },
                  ].map((d, i) => (
                    <div key={i} className="rounded-lg p-3 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
                      <div className="text-base font-bold" style={{ color: 'var(--color-text)' }}>{d.val}</div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--color-muted)' }}>{d.label}</div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {vehicle?.dealer && <p className="text-xs text-center pb-2" style={{ color: 'var(--color-muted)' }}>Listed by: {vehicle.dealer}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
