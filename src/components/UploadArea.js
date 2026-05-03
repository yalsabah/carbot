import React, { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, X, CheckCircle, Plus } from 'lucide-react';

// Shared button styling for the chip-style upload buttons.
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

// One thumbnail tile. Renders the file as a data URL via FileReader rather
// than URL.createObjectURL — blob: URLs were getting revoked mid-render when
// the parent unmounted Thumbnails (e.g. after sending the message), which
// flooded the console with `net::ERR_FILE_NOT_FOUND` for blob URLs. Data
// URLs have no lifecycle to mismanage.
function Thumbnail({ file, onRemove, onClick }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => { if (!cancelled) setUrl(reader.result); };
    reader.readAsDataURL(file);
    return () => { cancelled = true; };
  }, [file]);

  if (!url) {
    return (
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 8,
          border: '1px solid var(--color-border)',
          background: 'var(--color-bg)',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <div
      className="relative group"
      style={{
        width: 44,
        height: 44,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg)',
        flexShrink: 0,
      }}
    >
      <img
        src={url}
        alt={file.name}
        title={file.name}
        onClick={() => onClick?.(url)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          cursor: 'zoom-in',
          display: 'block',
        }}
      />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove?.();
        }}
        title="Remove image"
        aria-label={`Remove ${file.name}`}
        className="absolute top-0.5 right-0.5 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100 focus:opacity-100"
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.65)',
          color: 'white',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <X size={10} />
      </button>
    </div>
  );
}

export default function UploadArea({
  carfaxFile,
  vehicleImages = [],
  onCarfaxChange,
  onVehicleImagesChange,
  onPreviewImage,
}) {
  const carfaxRef = useRef(null);
  const imageRef = useRef(null);

  const handleAddImages = (newFiles) => {
    if (!newFiles || newFiles.length === 0) return;
    const accepted = Array.from(newFiles).filter((f) => f && f.type.startsWith('image/'));
    if (accepted.length === 0) return;
    onVehicleImagesChange([...vehicleImages, ...accepted]);
    if (imageRef.current) imageRef.current.value = '';
  };

  const handleRemoveImage = (idx) => {
    const next = vehicleImages.slice();
    next.splice(idx, 1);
    onVehicleImagesChange(next);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* CARFAX upload — single PDF, unchanged */}
      <input
        ref={carfaxRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => onCarfaxChange(e.target.files[0] || null)}
      />
      <button
        style={{
          ...btnBase,
          ...(carfaxFile
            ? { borderColor: '#16a34a', color: '#16a34a', background: '#f0fdf4' }
            : {}),
        }}
        onClick={() => carfaxRef.current.click()}
        title="Upload CARFAX PDF"
      >
        {carfaxFile ? <CheckCircle size={14} /> : <FileText size={14} />}
        {carfaxFile
          ? carfaxFile.name.slice(0, 18) + (carfaxFile.name.length > 18 ? '…' : '')
          : 'Upload CARFAX'}
        {carfaxFile && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onCarfaxChange(null);
              if (carfaxRef.current) carfaxRef.current.value = '';
            }}
            style={{ marginLeft: 2, opacity: 0.6, cursor: 'pointer' }}
          >
            <X size={12} />
          </span>
        )}
      </button>

      {/* Vehicle image(s) — multi-select. Renders as a strip of thumbnails
          when the user has attached any; otherwise as a single chip. */}
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleAddImages(e.target.files)}
      />

      {vehicleImages.length === 0 ? (
        <button
          style={btnBase}
          onClick={() => imageRef.current.click()}
          title="Upload one or more vehicle photos"
        >
          <ImageIcon size={14} />
          Vehicle Photos
        </button>
      ) : (
        <div className="flex items-center gap-1.5">
          {vehicleImages.map((file, i) => (
            <Thumbnail
              key={`${file.name}-${i}`}
              file={file}
              onRemove={() => handleRemoveImage(i)}
              onClick={(url) => onPreviewImage?.(url)}
            />
          ))}
          <button
            onClick={() => imageRef.current.click()}
            title="Add another image"
            aria-label="Add another image"
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              border: '1px dashed var(--color-border)',
              background: 'transparent',
              color: 'var(--color-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.15s',
            }}
          >
            <Plus size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
