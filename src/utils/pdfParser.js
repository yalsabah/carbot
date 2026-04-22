let pdfjsLib = null;

async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = `${process.env.PUBLIC_URL}/pdf.worker.min.js`;
  }
  return pdfjsLib;
}

export async function extractTextFromPDF(file) {
  const lib = await getPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: arrayBuffer }).promise;

  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    fullText += pageText + '\n';
  }

  return fullText;
}

export async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function getMediaType(file) {
  const map = {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
    'image/gif': 'image/gif',
  };
  return map[file.type] || 'image/jpeg';
}

/**
 * getDominantColor
 * Samples only the CENTER 60 % of the image (where the car body sits) and
 * rejects near-white showroom backgrounds, near-black shadows, and
 * low-saturation gray/asphalt pixels so the returned hex closely matches
 * the vehicle's actual paint colour.
 */
export async function getDominantColor(imageFile) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(imageFile);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Work on a scaled-down copy for speed
      const scale = Math.min(1, 220 / Math.max(img.width, img.height));
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Sample only the central zone where the vehicle body lives
      const x0 = Math.floor(canvas.width  * 0.18);
      const x1 = Math.floor(canvas.width  * 0.82);
      const y0 = Math.floor(canvas.height * 0.22);
      const y1 = Math.floor(canvas.height * 0.78);
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;

      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const pr = data[i], pg = data[i + 1], pb = data[i + 2];
        const brightness = (pr + pg + pb) / 3;

        // Skip near-white (showroom floor / sky / reflections)
        if (brightness > 205) continue;
        // Skip near-black (shadows, tire gaps, voids)
        if (brightness < 18) continue;
        // Skip desaturated mid-tones (concrete, gray backgrounds)
        const mx = Math.max(pr, pg, pb);
        const mn = Math.min(pr, pg, pb);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        if (sat < 0.06 && brightness > 105) continue;

        r += pr; g += pg; b += pb; count++;
      }

      URL.revokeObjectURL(url);

      if (count < 40) {
        // Sampling filtered too aggressively (e.g. very dark car) — fall back
        // to a simple center-pixel average without filters
        const cx = Math.floor(canvas.width / 2);
        const cy = Math.floor(canvas.height / 2);
        const px = ctx.getImageData(cx - 10, cy - 10, 20, 20).data;
        let fr = 0, fg = 0, fb = 0, fc = 0;
        for (let i = 0; i < px.length; i += 4) { fr += px[i]; fg += px[i+1]; fb += px[i+2]; fc++; }
        const toHex = v => Math.round(v / fc).toString(16).padStart(2, '0');
        resolve('#' + toHex(fr) + toHex(fg) + toHex(fb));
      } else {
        const toHex = v => Math.round(v / count).toString(16).padStart(2, '0');
        resolve('#' + toHex(r) + toHex(g) + toHex(b));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve('#4A4E52'); };
    img.src = url;
  });
}
