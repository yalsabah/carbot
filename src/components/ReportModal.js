import React, { useEffect, useRef, useState } from 'react';
import { X, Award, DollarSign, BarChart2, TrendingDown, Cpu } from 'lucide-react';
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

// GLB model renderer using @react-three/fiber
function GLBScene({ url }) {
  const { scene } = useGLTF(url);
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

function LeftPanel({ vehicleColor, glbUrl, modelStatus, vehicle, wheelColor }) {
  const showGLB = !!glbUrl;
  const bodyStyle = inferBodyStyle(vehicle);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {showGLB ? (
        // Tier 1 — AI-generated GLB from Hyper3D
        <Canvas camera={{ position: [3, 1.5, 4], fov: 45 }} style={{ background: 'transparent' }}>
          <GLBScene url={glbUrl} />
        </Canvas>
      ) : (
        // Tier 2 — Pipeline procedural 3D (always — never fall back to photo)
        <VehicleCanvas
          vehicleColor={vehicleColor}
          wheelColor={wheelColor || 'gunmetal'}
          bodyStyle={bodyStyle}
        />
      )}

      {/* Hyper3D job status pill */}
      {!showGLB && modelStatus && modelStatus !== 'Done' && modelStatus !== 'Failed' && (
        <div
          className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium model-loading"
          style={{ background: 'rgba(0,0,0,0.5)', color: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(8px)' }}
        >
          <Cpu size={11} />
          {modelStatus === 'Pending' ? 'Queued for 3D…' : 'Rendering 3D model…'}
        </div>
      )}

      {/* Pipeline badge */}
      {!showGLB && (
        <div
          className="absolute top-4 left-4 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.72)', backdropFilter: 'blur(10px)', border: '1px solid rgba(255,255,255,0.10)' }}
        >
          <Cpu size={10} />
          Pipeline 3D · Procedural
        </div>
      )}
    </div>
  );
}

export default function ReportModal({ report, vehicleColor, vehicleLabel, imageBase64, imageMediaType, glbUrl, modelStatus, onClose }) {
  const [exiting, setExiting] = useState(false);
  const closeTimer = useRef(null);

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
        {/* Left: Vehicle visual */}
        <div
          className="relative flex-shrink-0 overflow-hidden"
          style={{ width: '42%', background: '#0a0f1a' }}
        >
          <LeftPanel
            vehicleColor={vehicleColor}
            glbUrl={glbUrl}
            modelStatus={modelStatus}
            vehicle={vehicle}
            wheelColor="gunmetal"
          />

          {/* Bottom gradient + info */}
          <div
            className="absolute bottom-0 left-0 right-0 p-6"
            style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.88) 55%)' }}
          >
            <div className="text-white font-bold text-xl leading-tight drop-shadow">
              {vehicleLabel || `${vehicle?.year} ${vehicle?.make} ${vehicle?.model}`}
            </div>
            {vehicle?.trim && <div className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>{vehicle.trim}</div>}
            {vehicle?.mileage && <div className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.5)' }}>{vehicle.mileage.toLocaleString()} miles</div>}
            <div className="mt-3">{verdict?.rating && <VerdictBadge rating={verdict.rating} large />}</div>
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,0.3)' }}>Drag to rotate · auto-spins</p>
          </div>
        </div>

        {/* Right: Report */}
        <div className="flex-1 overflow-y-auto relative" style={{ background: 'var(--color-surface)' }}>
          {/* Sticky header */}
          <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4" style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
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
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {metrics.map((m, i) => <MetricCard key={i} m={m} />)}
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
              {financing && (
                <Section icon={<BarChart2 size={13} />} title="Financing">
                  <Row label="APR" value={financing.apr != null ? `${financing.apr}%` : '—'} />
                  <Row label="Term" value={financing.termMonths ? `${financing.termMonths} mo` : '—'} />
                  <Row label="Down Payment" value={fmt(financing.downPayment, '$')} />
                  <Row label="Monthly" value={fmt(financing.monthlyPayment, '$')} />
                  <Row label="Total Interest" value={fmt(financing.totalInterest, '$')} />
                  <Row label="Total Cost" value={fmt(financing.totalCost, '$')} />
                </Section>
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
