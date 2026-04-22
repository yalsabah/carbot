const RODIN_KEY = process.env.REACT_APP_HYPER3D_API_KEY;

// Submit an image to Hyper3D Rodin for 3D model generation.
// Returns { taskUuid, jobUuid } or null if key not configured.
export async function submitRodinJob(imageBase64, imageMediaType, prompt) {
  if (!RODIN_KEY) return null;

  const blob = await (await fetch(`data:${imageMediaType};base64,${imageBase64}`)).blob();
  const form = new FormData();
  form.append('images', blob, 'vehicle.jpg');
  form.append('prompt', prompt || 'car vehicle exterior');
  form.append('geometry_file_format', 'glb');
  form.append('material', 'PBR');
  form.append('quality', 'medium');
  form.append('use_hyper', 'false');

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

// Poll job status. Returns { status, glbUrl } where status is 'Pending'|'Running'|'Done'|'Failed'.
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
  const INTERVAL = 8000; // poll every 8s
  const TIMEOUT = 10 * 60 * 1000; // 10 min max
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
