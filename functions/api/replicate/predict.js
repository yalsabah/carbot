// POST /api/replicate/predict
//
// Submits a prediction job to Replicate's firtoz/trellis model (the
// hosted TRELLIS image-to-3D wrapper). Returns a Replicate prediction ID
// the client polls via /api/replicate/status.
//
// Why firtoz/trellis instead of NVIDIA's hosted TRELLIS:
//   - NVIDIA's build.nvidia.com endpoint is a playground demo that only
//     accepts 4 pre-loaded example_id values. User images get HTTP 422.
//   - firtoz/trellis on Replicate wraps the same Microsoft TRELLIS weights
//     with a real REST API that accepts arbitrary user images.
//   - $0.036/run, ~26s on A100. ~88% cheaper than Tripo3D.
//
// Replicate splits prediction endpoints into two flavors:
//   - /v1/models/{owner}/{name}/predictions  — OFFICIAL Replicate models only
//   - /v1/predictions                         — community models, requires `version` hash
//
// firtoz/trellis is community-hosted, so we use the version-pinned
// endpoint. The hash below is the latest version as of writing; override
// via REPLICATE_TRELLIS_VERSION env var to roll forward without
// redeploying.
//
// Image input: Replicate's Cog accepts data URIs for Path-type inputs.
// Passing `data:image/jpeg;base64,...` directly avoids a separate upload
// hop and works for both user-uploaded photos AND VinAudit stock images.
//
// Required env: REPLICATE_API_TOKEN
// Optional env: REPLICATE_TRELLIS_VERSION  (override the default version hash)

const REPLICATE_PREDICT = 'https://api.replicate.com/v1/predictions';
const DEFAULT_TRELLIS_VERSION = 'e8f6c45206993f297372f5436b90350817bd9b4a0d52d2a76df50c1c8afa2b3c';

export async function onRequestPost({ request, env }) {
  const token = env.REPLICATE_API_TOKEN;
  if (!token) {
    return json({ error: 'REPLICATE_API_TOKEN not configured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const {
    imageBase64,
    mediaType = 'image/png',
    imageUrl,
    seed = 0,
    // firtoz/trellis-specific knobs — defaults are tuned for car-sized
    // single-image-to-3D, which is exactly our use case.
    textureSize = 1024,
    meshSimplify = 0.95,
    generateColor = true,
    generateModel = true,
    generateNormal = false,
    ssSamplingSteps = 12,
    slatSamplingSteps = 12,
    ssGuidanceStrength = 7.5,
    slatGuidanceStrength = 3.0,
  } = body || {};

  // Resolve the image input. Prefer a direct URL (cheaper — Replicate
  // fetches it from our origin, no base64 payload roundtrip), else use
  // a data URI which Cog can decode natively.
  let image;
  if (imageUrl && /^https?:\/\//.test(imageUrl)) {
    image = imageUrl;
  } else if (imageBase64) {
    const clean = String(imageBase64).replace(/^data:[^,]+,/, '');
    image = `data:${mediaType};base64,${clean}`;
  } else {
    return json({ error: 'imageUrl or imageBase64 required' }, 400);
  }

  const replicateBody = {
    version: env.REPLICATE_TRELLIS_VERSION || DEFAULT_TRELLIS_VERSION,
    input: {
      // firtoz/trellis takes `images` as an array (it supports multi-view
      // input; we just pass our single image as a one-element array).
      // Sending the legacy `image` field gets a 422 with
      // `"images is required"`.
      images: [image],
      seed,
      texture_size: textureSize,
      mesh_simplify: meshSimplify,
      generate_color: generateColor,
      generate_model: generateModel,
      generate_normal: generateNormal,
      randomize_seed: seed === 0,
      ss_sampling_steps: ssSamplingSteps,
      slat_sampling_steps: slatSamplingSteps,
      ss_guidance_strength: ssGuidanceStrength,
      slat_guidance_strength: slatGuidanceStrength,
    },
  };

  let resp;
  try {
    resp = await fetch(REPLICATE_PREDICT, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
        // "Prefer: wait" would block until completion — we don't use it
        // because predictions take 20-40s and Cloudflare Pages Functions
        // have a 30s CPU limit. Async (poll) flow is safer.
      },
      body: JSON.stringify(replicateBody),
    });
  } catch (err) {
    return json({ error: 'replicate_fetch_failed', message: String(err?.message || err) }, 502);
  }

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data) {
    return json(
      {
        error: 'replicate_error',
        status: resp.status,
        body: data ? JSON.stringify(data).slice(0, 1500) : 'no_body',
      },
      resp.status >= 500 ? 502 : resp.status,
    );
  }

  // Successful submit. Replicate returns the prediction object with id +
  // status (usually "starting") + a self URL we'd use for polling.
  if (!data.id) {
    return json({ error: 'no_prediction_id', body: JSON.stringify(data).slice(0, 500) }, 502);
  }
  return json({
    predictionId: data.id,
    status: data.status,
    // Client doesn't need this but useful for debugging.
    self: data.urls?.get || null,
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
