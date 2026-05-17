// Small "Report an issue" affordance that lives in the bottom info bar
// of the 3D model viewer. Lets users flag bad renders (wrong color,
// distorted geometry, etc.) with a one-line comment. On submit the
// current 3D viewport is screenshotted and the payload is persisted to
// `modelFeedback/{auto-id}` in Firestore for triage.

import React, { useEffect, useRef, useState } from 'react';
import { Flag, X, Check } from 'lucide-react';
import { FEEDBACK_ISSUES, submitModelFeedback } from '../utils/modelFeedback';
import { useAuth } from '../contexts/AuthContext';

export default function ModelFeedbackButton({
  // What the user is reporting on:
  vehicle = null,
  modelProvider = null,
  glbUrl = null,
  glbUrlSource = null,
  userImages = [],
  sessionId = null,
  messageId = null,
  // Returns a data: URL of the current 3D viewport, or null.
  // Wired up by ReportModal via a child component inside <Canvas>.
  captureScreenshot = null,
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState([]);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [toastVisible, setToastVisible] = useState(false);
  const popoverRef = useRef(null);
  const toastTimerRef = useRef(null);

  // Close popover on outside click + Escape. We register in capture so the
  // outer modal's Escape handler doesn't also fire (would close the report
  // along with the popover, which is jarring).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        setOpen(false);
      }
    };
    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey, true);
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const toggleIssue = (id) => {
    setIssues((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setErrorMsg(null);
  };

  const canSubmit = issues.length > 0 && !submitting && !!user;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMsg(null);
    let screenshotDataUrl = null;
    try {
      if (typeof captureScreenshot === 'function') {
        screenshotDataUrl = captureScreenshot();
      }
    } catch {
      // Screenshot is best-effort — submit the report anyway.
      screenshotDataUrl = null;
    }
    try {
      await submitModelFeedback({
        userId: user.uid,
        issues,
        comment,
        screenshotDataUrl,
        vehicle,
        modelProvider,
        glbUrl,
        glbUrlSource,
        sourceImageNames: (userImages || [])
          .filter((i) => i?.name)
          .map((i) => i.name),
        sessionId,
        messageId,
      });
      // Reset form + close + flash toast
      setIssues([]);
      setComment('');
      setOpen(false);
      setToastVisible(true);
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => setToastVisible(false), 2000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[feedback] submit failed', err);
      setErrorMsg(
        err?.code === 'permission-denied'
          ? 'Submission blocked by security rules — please tell the developer.'
          : 'Could not send report. Try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  // Compact icon-only trigger so it slots into the existing bottom-info
  // row without making it feel crowded.
  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Report an issue with this 3D model"
        aria-label="Report an issue with this 3D model"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all hover:opacity-100"
        style={{
          color: 'var(--color-muted)',
          opacity: 0.6,
          background: 'transparent',
          border: '1px solid var(--color-border)',
        }}
      >
        <Flag size={10} />
        Report
      </button>

      {/* Popover form — fixed + centered so the position is layout-agnostic
          (works in both side-by-side and full-screen report modes). A light
          dimmer behind makes the form pop out of the modal background. */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-[55]"
            style={{ background: 'rgba(0,0,0,0.35)' }}
            onClick={() => setOpen(false)}
          />
          <div
            ref={popoverRef}
            className="fixed z-[60] rounded-xl shadow-2xl"
            style={{
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 400,
              maxWidth: 'calc(100vw - 32px)',
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Report an issue</div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="w-6 h-6 rounded flex items-center justify-center hover:opacity-70"
              style={{ color: 'var(--color-muted)' }}
            >
              <X size={14} />
            </button>
          </div>

          <div className="px-4 py-3 space-y-3">
            <div className="text-xs" style={{ color: 'var(--color-muted)' }}>
              What's wrong with this 3D model? Select all that apply.
            </div>

            <div className="space-y-1.5">
              {FEEDBACK_ISSUES.map((opt) => {
                const checked = issues.includes(opt.id);
                return (
                  <label
                    key={opt.id}
                    className="flex items-start gap-2 text-xs cursor-pointer select-none py-0.5"
                    style={{ color: 'var(--color-text)' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleIssue(opt.id)}
                      className="mt-0.5 flex-shrink-0"
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })}
            </div>

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              placeholder={
                issues.length === 0
                  ? 'Select an issue above first'
                  : 'Tell us a bit more (optional)…'
              }
              disabled={issues.length === 0}
              rows={3}
              className="w-full rounded-md px-2 py-1.5 text-xs resize-none"
              style={{
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text)',
                opacity: issues.length === 0 ? 0.5 : 1,
                outline: 'none',
              }}
            />

            {!user && (
              <div className="text-[11px]" style={{ color: '#c0392b' }}>
                Please sign in to submit feedback.
              </div>
            )}
            {errorMsg && (
              <div className="text-[11px]" style={{ color: '#c0392b' }}>{errorMsg}</div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 rounded-md text-xs font-medium"
                style={{
                  color: 'var(--color-muted)',
                  background: 'transparent',
                  border: '1px solid var(--color-border)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-3 py-1.5 rounded-md text-xs font-semibold text-white transition-opacity"
                style={{
                  background: 'var(--color-accent)',
                  opacity: canSubmit ? 1 : 0.5,
                  cursor: canSubmit ? 'pointer' : 'not-allowed',
                }}
              >
                {submitting ? 'Sending…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
        </>
      )}

      {/* Success toast — fixed at bottom-center, fades in/out. Lives
          outside the popover so it survives the popover closing. */}
      {toastVisible && (
        <div
          className="fixed z-[70] inline-flex items-center gap-2 px-4 py-2 rounded-full shadow-xl"
          style={{
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            background: '#15803d',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            animation: 'feedback-toast-in 200ms ease-out',
          }}
        >
          <Check size={14} />
          Report sent
        </div>
      )}
    </>
  );
}
