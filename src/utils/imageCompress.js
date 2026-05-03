// Client-side image downscaling + JPEG re-encoding.
//
// Why: raw screenshots and modern phone photos run 2–5 MB each. Sending 6 of
// those to /api/claude as base64 (×1.33 inflation) easily produces a 20 MB
// request body, which hits Anthropic's per-image policy bouncer and our
// Cloudflare Pages function size limits — manifesting as a generic 500.
// 1568 px on the long edge matches Claude's vision-tile sweet spot
// (1568×1568 ≈ 1568 input tokens), and JPEG q≈0.82 keeps quality good
// while typically landing each image under 300 KB.

const MAX_LONG_EDGE = 1568;
const JPEG_QUALITY = 0.82;

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Compress an image File. Returns a NEW File (jpeg) sized down to fit within
 * MAX_LONG_EDGE on its longest dimension. Skips work for tiny inputs.
 *
 * Falls back to the original File if anything throws (decode fail, OOM, etc.)
 * — caller's pipeline still works, just with a larger payload.
 */
export async function compressImageFile(file) {
  if (!file || !(file instanceof Blob)) return file;
  // Skip non-images and tiny ones — nothing to gain.
  if (!file.type || !file.type.startsWith('image/')) return file;
  if (file.size <= 200 * 1024) return file;

  try {
    const img = await readImage(file);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // White matte under the image so transparent PNGs become flat JPEGs
    // instead of black blocks.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITY);
    if (!blob) return file;

    // Don't replace the original if the "compressed" version is somehow larger
    // (rare, but possible on already-tiny JPEGs).
    if (blob.size >= file.size) return file;

    const baseName = (file.name || 'image').replace(/\.[^.]+$/, '');
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export async function compressImageFiles(files) {
  const out = [];
  for (const f of files || []) {
    out.push(await compressImageFile(f));
  }
  return out;
}
