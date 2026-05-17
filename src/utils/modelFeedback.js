// Feedback / "Report an issue" submissions for generated 3D models.
//
// Persists to Firestore `modelFeedback/{auto-id}` with everything a
// developer needs to triage a bad render:
//   - the user's selected issue tags + freeform comment
//   - a JPEG screenshot of the current 3D viewport (captured client-side)
//   - the glbUrl + slug so the actual model can be re-loaded
//   - vehicle metadata (year/make/model/trim/VIN)
//   - which provider generated this model (tripo / replicate-trellis / ...)
//   - source image filenames the user uploaded (for "wrong color" triage)
//   - userId + sessionId + messageId so the conversation can be jumped to
//
// The GLB binary itself is never copied — too large for Firestore's 1MB
// doc limit. The URL is enough to re-load it inside the dashboard.

import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config';

// Stable issue identifiers. The UI maps these to human labels; the
// dashboard / triage tools query by these keys so renaming the user-
// facing label doesn't break analytics.
export const FEEDBACK_ISSUES = [
  { id: 'not_like_vehicle',  label: "Doesn't look like the vehicle" },
  { id: 'wrong_body_style',  label: 'Wrong body style (sedan/SUV/truck/etc.)' },
  { id: 'wrong_color',       label: 'Wrong color or paint pattern' },
  { id: 'distorted',         label: 'Distorted or broken geometry' },
  { id: 'missing_parts',     label: 'Missing parts (no wheels, floating hood, etc.)' },
  { id: 'failed_to_generate', label: 'Failed to generate / stuck loading' },
  { id: 'other',             label: 'Other' },
];

const MAX_COMMENT = 500;
// Roughly 280KB of base64 PNG/JPEG; stays comfortably under Firestore's
// 1MB doc limit while still leaving room for the rest of the payload.
const MAX_SCREENSHOT_LEN = 360_000;

/**
 * Submit a single feedback report. Throws on failure so the UI can react.
 *
 * @param {object} args
 * @param {string} args.userId          Firebase auth uid (required)
 * @param {string[]} args.issues        Subset of FEEDBACK_ISSUES ids (≥1)
 * @param {string} [args.comment]       Freeform note, ≤MAX_COMMENT chars
 * @param {string|null} [args.screenshotDataUrl]  data:image/* base64 PNG/JPEG
 * @param {object} [args.vehicle]       { year, make, model, trim, vin }
 * @param {string|null} [args.modelProvider]  'tripo' | 'replicate-trellis' | …
 * @param {string|null} [args.glbUrl]
 * @param {string|null} [args.glbUrlSource]
 * @param {string[]} [args.sourceImageNames]  Filenames the user uploaded
 * @param {string|null} [args.sessionId]
 * @param {string|null} [args.messageId]
 * @returns {Promise<string>} The new Firestore doc id
 */
export async function submitModelFeedback({
  userId,
  issues,
  comment = '',
  screenshotDataUrl = null,
  vehicle = null,
  modelProvider = null,
  glbUrl = null,
  glbUrlSource = null,
  sourceImageNames = [],
  sessionId = null,
  messageId = null,
}) {
  if (!userId) throw new Error('userId is required');
  if (!Array.isArray(issues) || issues.length === 0) {
    throw new Error('at least one issue tag is required');
  }
  // Sanity-cap the screenshot so a runaway data URL can't blow the doc
  // limit. If it overflows, drop it — the rest of the payload is still
  // useful for triage even without the image.
  const safeShot =
    typeof screenshotDataUrl === 'string' && screenshotDataUrl.length <= MAX_SCREENSHOT_LEN
      ? screenshotDataUrl
      : null;

  const payload = {
    userId,
    issues: issues.slice(0, 16),
    comment: typeof comment === 'string' ? comment.slice(0, MAX_COMMENT) : '',
    screenshotDataUrl: safeShot,
    vehicle: vehicle
      ? {
          year:  vehicle.year  ?? null,
          make:  vehicle.make  ?? null,
          model: vehicle.model ?? null,
          trim:  vehicle.trim  ?? null,
          vin:   vehicle.vin   ?? null,
        }
      : null,
    modelProvider: modelProvider || null,
    glbUrl: glbUrl || null,
    glbUrlSource: glbUrlSource || null,
    sourceImageNames: Array.isArray(sourceImageNames) ? sourceImageNames.slice(0, 12) : [],
    sessionId: sessionId || null,
    messageId: messageId || null,
    createdAt: serverTimestamp(),
  };

  const ref = await addDoc(collection(db, 'modelFeedback'), payload);
  return ref.id;
}
