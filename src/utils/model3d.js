// Conditional Image-to-3D pipeline
//
// Priority:
//   1. User uploaded photo  → upload to Tripo3D
//   2. VIN available        → fetch stock photo URL via VinAudit → send URL to Tripo3D
//   3. Neither              → return null (VehicleCanvas procedural fallback renders)
//
// All upstream API keys are held server-side by Cloudflare Pages Functions.
// Client talks to /api/tripo/* and /api/vinaudit only.

// ─── Tripo3D ──────────────────────────────────────────────────────────────────

async function tripoSubmitFromFile(imageBase64, imageMediaType) {
  // Upload image file, get a Tripo image_token, then create task
  const blob = await (await fetch(`data:${imageMediaType};base64,${imageBase64}`)).blob();
  const form = new FormData();
  form.append('file', blob, 'vehicle.jpg');

  const uploadRes = await fetch('/api/tripo/upload', {
    method: 'POST',
    body: form,
  });
  if (!uploadRes.ok) throw new Error(`Tripo upload failed: ${uploadRes.status}`);
  const { data: { image_token } } = await uploadRes.json();
  return tripoCreateTask({ type: 'image_to_model', file: { type: 'jpg', file_token: image_token } });
}

async function tripoSubmitFromUrl(imageUrl) {
  return tripoCreateTask({ type: 'image_to_model', file: { type: 'jpg', url: imageUrl } });
}

async function tripoCreateTask(input) {
  const res = await fetch('/api/tripo/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Tripo task failed: ${res.status}`);
  const { data: { task_id } } = await res.json();
  return task_id;
}

async function tripoPoll(taskId) {
  const res = await fetch(`/api/tripo/task/${taskId}`);
  if (!res.ok) throw new Error(`Tripo poll failed: ${res.status}`);
  const { data } = await res.json();
  // status: 'queued' | 'running' | 'success' | 'failed'
  const glbUrl = data.output?.model ?? null;
  return { status: data.status, progress: data.progress ?? 0, glbUrl };
}

// ─── VinAudit stock photo ─────────────────────────────────────────────────────

async function fetchVinAuditPhotoUrl(vin) {
  if (!vin) return null;
  try {
    const res = await fetch(`/api/vinaudit?vin=${encodeURIComponent(vin)}`);
    if (!res.ok) return null;
    const data = await res.json();
    // VinAudit Images API returns array of photo URLs under data.images
    return data?.images?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Submit a 3D generation job.
 *   imageBase64 + imageMediaType → direct file upload (user photo)
 *   vin (no image)               → fetch VinAudit stock URL → URL job
 *   neither                      → returns null (use procedural fallback)
 */
export async function submit3DJob(imageBase64, imageMediaType, vin) {
  if (imageBase64 && imageMediaType) {
    // Path 1: user photo
    const taskId = await tripoSubmitFromFile(imageBase64, imageMediaType);
    return { taskId, source: 'photo' };
  }

  if (vin) {
    // Path 2: VIN → VinAudit stock photo URL → Tripo URL job
    const photoUrl = await fetchVinAuditPhotoUrl(vin);
    if (photoUrl) {
      const taskId = await tripoSubmitFromUrl(photoUrl);
      return { taskId, source: 'vinaudit', photoUrl };
    }
  }

  // Path 3: no image, no VIN photo — signal caller to use procedural fallback
  return null;
}

/**
 * Poll until done. Calls onProgress({ status, progress }) and resolves with glbUrl or null.
 * Pass an AbortSignal to cancel early.
 */
export async function wait3DModel(taskId, onProgress, signal) {
  const INTERVAL = 4000;  // Tripo3D is fast — poll every 4s
  const TIMEOUT  = 5 * 60 * 1000; // 5 min max
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const { status, progress, glbUrl } = await tripoPoll(taskId);
      onProgress?.({ status, progress });
      if (status === 'success' && glbUrl) return glbUrl;
      if (status === 'failed') return null;
    } catch {
      // transient — keep polling
    }
  }
  return null;
}
