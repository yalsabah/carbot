const RODIN_KEY = process.env.REACT_APP_HYPER3D_API_KEY;

// Build a rich text prompt from a vehicle report object (VIN fallback path).
function buildVehiclePrompt(vehicle) {
  const parts = [
    vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.trim,
  ].filter(Boolean);
  const base = parts.join(' ') || 'car';
  return `${base} exterior, front three-quarter view, studio automotive photography, high detail`;
}

// Submit an image (or text prompt only) to Hyper3D Rodin Gen-2 for 3D model generation.
// imageBase64 / imageMediaType are optional — omit both for text-to-3D from vehicle data.
// Returns { taskUuid, jobUuid } or null if key not configured.
export async function submitRodinJob(imageBase64, imageMediaType, prompt) {
  if (!RODIN_KEY) return null;

  const form = new FormData();

  if (imageBase64 && imageMediaType) {
    const blob = await (await fetch(`data:${imageMediaType};base64,${imageBase64}`)).blob();
    form.append('images', blob, 'vehicle.jpg');
  }

  form.append('prompt', prompt || 'car vehicle exterior, high detail');
  form.append('tier', 'Gen-2');
  form.append('mesh_mode', 'Quad');
  form.append('quality', 'High');
  form.append('addons', 'HighPack');
  form.append('geometry_file_format', 'glb');
  form.append('material', 'PBR');

  const res = await fetch('/api/rodin/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RODIN_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Rodin submit failed: ${res.status}`);
  const data = await res.json();
  const taskUuid = data.uuid;
  const jobUuid = data.jobs?.[0]?.uuid;
  if (!taskUuid || !jobUuid) throw new Error('Rodin: missing uuid in response');
  return { taskUuid, jobUuid };
}

// Submit using only vehicle report data (no photo available).
export async function submitRodinJobFromVehicle(vehicle) {
  return submitRodinJob(null, null, buildVehiclePrompt(vehicle));
}

// Poll job status. Returns { status, glbUrl }.
// status is one of: 'Pending' | 'Running' | 'Done' | 'Failed'
export async function pollRodinJob(taskUuid, jobUuid) {
  if (!RODIN_KEY) return { status: 'Failed' };

  const res = await fetch('/api/rodin/download_notification/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RODIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_uuid: taskUuid, job_uuid: jobUuid }),
  });
  if (!res.ok) throw new Error(`Rodin poll failed: ${res.status}`);
  const data = await res.json();
  const status = data.status ?? data[jobUuid]?.status ?? 'Pending';
  const glbUrl = data.urls?.base?.[0] ?? data[jobUuid]?.urls?.base?.[0] ?? null;
  return { status, glbUrl };
}

// Full polling loop. Calls onProgress(status) and resolves with glbUrl or null.
export async function waitForRodinModel(taskUuid, jobUuid, onProgress, signal) {
  const INTERVAL = 10000; // Gen-2 / HighPack jobs take longer — poll every 10s
  const TIMEOUT  = 15 * 60 * 1000; // 15 min max
  const start = Date.now();

  while (Date.now() - start < TIMEOUT) {
    if (signal?.aborted) return null;
    await new Promise(r => setTimeout(r, INTERVAL));
    if (signal?.aborted) return null;
    try {
      const { status, glbUrl } = await pollRodinJob(taskUuid, jobUuid);
      onProgress?.(status);
      if (status === 'Done' && glbUrl) return glbUrl;
      if (status === 'Failed') return null;
    } catch {
      // transient error — keep polling
    }
  }
  return null;
}
