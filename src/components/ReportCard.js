import React from 'react';
import { TrendingDown, DollarSign, BarChart2, Award } from 'lucide-react';

const fmt = (n, prefix = '') => {
  if (n == null) return '—';
  if (typeof n === 'string') return n;
  return prefix + n.toLocaleString();
};

const fmtPct = n => n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

function VerdictBadge({ rating }) {
  const cls = {
    Great: 'verdict-great',
    Good: 'verdict-good',
    Fair: 'verdict-fair',
    Bad: 'verdict-bad',
  }[rating] || 'verdict-gray';

  return (
    <span className={`inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-bold ${cls}`}>
      <Award size={14} />
      {rating} Deal
    </span>
  );
}

export default function ReportCard({ report }) {
  if (!report) return null;
  const { vehicle, pricing, financing, depreciation, verdict, metrics } = report;

  return (
    <div className="rounded-2xl overflow-hidden mt-3" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>
      {/* Header */}
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
              {vehicle?.year} {vehicle?.make} {vehicle?.model} {vehicle?.trim}
              <span className="ml-2 text-sm font-normal" style={{ color: 'var(--color-muted)' }}>— Professional Deal Analysis</span>
            </h2>
            <div className="flex flex-wrap gap-3 mt-1 text-sm" style={{ color: 'var(--color-muted)' }}>
              {vehicle?.mileage && <span>{vehicle.mileage.toLocaleString()} mi</span>}
              {pricing?.askingPrice && <span>Asking {fmt(pricing.askingPrice, '$')}</span>}
              {vehicle?.dealer && <span>{vehicle.dealer}</span>}
              {vehicle?.vin && <span className="font-mono text-xs">VIN: {vehicle.vin}</span>}
            </div>
          </div>
          {verdict?.rating && <VerdictBadge rating={verdict.rating} />}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Metric grid */}
        {metrics?.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>Key Metrics</h3>
            <div className="metrics-grid">
              {metrics.map((m, i) => (
                <div key={i} className={`metric-card metric-${m.color}`}>
                  <div className="metric-val">{m.value}</div>
                  <div className="metric-label">{m.label}</div>
                  {m.sub && <div className="metric-sub">{m.sub}</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Price Analysis */}
          {pricing && (
            <Section icon={<DollarSign size={14} />} title="Price Analysis">
              <Row label="Asking Price" value={fmt(pricing.askingPrice, '$')} />
              <Row label="KBB Value" value={fmt(pricing.kbbValue, '$')} />
              <Row label="Market Average" value={fmt(pricing.marketAvg, '$')} />
              <Row
                label="vs. Market"
                value={fmtPct(pricing.priceVsMarketPct)}
                valueColor={pricing.priceVsMarketPct > 5 ? '#c0392b' : pricing.priceVsMarketPct < -5 ? '#1a7a45' : '#b7550c'}
              />
            </Section>
          )}

          {/* Financing */}
          {financing && (
            <Section icon={<BarChart2 size={14} />} title="Financing Breakdown">
              <Row label="APR" value={financing.apr != null ? `${financing.apr}%` : '—'} />
              <Row label="Term" value={financing.termMonths ? `${financing.termMonths} months` : '—'} />
              <Row label="Down Payment" value={fmt(financing.downPayment, '$')} />
              <Row label="Monthly Payment" value={fmt(financing.monthlyPayment, '$')} />
              <Row label="Total Interest" value={fmt(financing.totalInterest, '$')} />
              <Row label="Total Cost" value={fmt(financing.totalCost, '$')} />
            </Section>
          )}
        </div>

        {/* Depreciation */}
        {depreciation && (
          <Section icon={<TrendingDown size={14} />} title="Depreciation Curve">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { label: 'Annual Rate', val: depreciation.annualRatePct != null ? `${depreciation.annualRatePct}%` : '—' },
                { label: '1 Year', val: fmt(depreciation.projectedValue1yr, '$') },
                { label: '3 Years', val: fmt(depreciation.projectedValue3yr, '$') },
                { label: '5 Years', val: fmt(depreciation.projectedValue5yr, '$') },
              ].map((d, i) => (
                <div key={i} className="metric-card metric-gray">
                  <div className="metric-val" style={{ fontSize: 16 }}>{d.val}</div>
                  <div className="metric-label">{d.label}</div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Verdict */}
        {verdict && (
          <div className="rounded-xl p-4" style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)' }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>Verdict</h3>
              <VerdictBadge rating={verdict.rating} />
            </div>
            <p className="text-sm mb-3" style={{ color: 'var(--color-text)' }}>{verdict.summary}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {verdict.pros?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5" style={{ color: '#1a7a45' }}>Pros</p>
                  <ul className="space-y-1">
                    {verdict.pros.map((p, i) => (
                      <li key={i} className="text-sm flex gap-1.5" style={{ color: 'var(--color-text)' }}>
                        <span style={{ color: '#1a7a45' }}>+</span> {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {verdict.cons?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1.5" style={{ color: '#c0392b' }}>Cons</p>
                  <ul className="space-y-1">
                    {verdict.cons.map((c, i) => (
                      <li key={i} className="text-sm flex gap-1.5" style={{ color: 'var(--color-text)' }}>
                        <span style={{ color: '#c0392b' }}>−</span> {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ icon, title, children }) {
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--color-muted)' }}>
        {icon} {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value, valueColor }) {
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: 'var(--color-muted)' }}>{label}</span>
      <span style={{ color: valueColor || 'var(--color-text)', fontWeight: 500 }}>{value}</span>
    </div>
  );
}
