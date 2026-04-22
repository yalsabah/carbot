import React, { useRef } from 'react';
import { FileText, Image, X, CheckCircle } from 'lucide-react';

export default function UploadArea({ carfaxFile, vehicleImage, onCarfaxChange, onVehicleImageChange }) {
  const carfaxRef = useRef(null);
  const imageRef = useRef(null);

  const btnBase = {
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
    color: 'var(--color-muted)',
    borderRadius: 10,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* CARFAX upload */}
      <input ref={carfaxRef} type="file" accept=".pdf" className="hidden" onChange={e => onCarfaxChange(e.target.files[0] || null)} />
      <button
        style={{
          ...btnBase,
          ...(carfaxFile ? { borderColor: '#16a34a', color: '#16a34a', background: '#f0fdf4' } : {}),
        }}
        onClick={() => carfaxRef.current.click()}
        title="Upload CARFAX PDF"
      >
        {carfaxFile ? <CheckCircle size={14} /> : <FileText size={14} />}
        {carfaxFile ? carfaxFile.name.slice(0, 18) + (carfaxFile.name.length > 18 ? '…' : '') : 'Upload CARFAX'}
        {carfaxFile && (
          <span
            onClick={e => { e.stopPropagation(); onCarfaxChange(null); if (carfaxRef.current) carfaxRef.current.value = ''; }}
            style={{ marginLeft: 2, opacity: 0.6, cursor: 'pointer' }}
          >
            <X size={12} />
          </span>
        )}
      </button>

      {/* Vehicle image upload */}
      <input ref={imageRef} type="file" accept="image/*" className="hidden" onChange={e => onVehicleImageChange(e.target.files[0] || null)} />
      <button
        style={{
          ...btnBase,
          ...(vehicleImage ? { borderColor: '#2563eb', color: '#2563eb', background: '#eff6ff' } : {}),
        }}
        onClick={() => imageRef.current.click()}
        title="Upload vehicle screenshot"
      >
        {vehicleImage ? <CheckCircle size={14} /> : <Image size={14} />}
        {vehicleImage ? vehicleImage.name.slice(0, 18) + (vehicleImage.name.length > 18 ? '…' : '') : 'Vehicle Photo'}
        {vehicleImage && (
          <span
            onClick={e => { e.stopPropagation(); onVehicleImageChange(null); if (imageRef.current) imageRef.current.value = ''; }}
            style={{ marginLeft: 2, opacity: 0.6, cursor: 'pointer' }}
          >
            <X size={12} />
          </span>
        )}
      </button>
    </div>
  );
}
