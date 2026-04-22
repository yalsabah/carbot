import React from 'react';
import { X } from 'lucide-react';
import VehicleCanvas from './VehicleCanvas';

export default function VehicleViewer({ vehicleColor, vehicleLabel, onClose }) {
  return (
    <div
      className="fixed bottom-6 left-6 z-40 rounded-2xl overflow-hidden shadow-2xl"
      style={{ width: 260, height: 185, background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
    >
      <button
        onClick={onClose}
        className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full flex items-center justify-center bg-black/25 hover:bg-black/40 transition-colors"
      >
        <X size={11} className="text-white" />
      </button>
      {vehicleLabel && (
        <div className="absolute bottom-2 left-0 right-0 text-center text-xs font-medium px-2 truncate z-10" style={{ color: 'var(--color-muted)' }}>
          {vehicleLabel}
        </div>
      )}
      <VehicleCanvas vehicleColor={vehicleColor} />
    </div>
  );
}
