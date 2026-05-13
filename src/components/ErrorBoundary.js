import React from 'react';

// Top-level error boundary. Catches uncaught render errors (including the
// ones Three.js throws when it can't load a GLB, which historically have
// taken down the entire app with a white screen).
//
// We deliberately render a minimal recovery UI rather than trying to
// reconstruct the page — anything more complex risks re-throwing. The
// "Reload" button is the escape hatch; the boundary state itself doesn't
// reset automatically because if we keep mounting the same broken
// children we'd just loop the same error.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface to the console so we can debug in prod. Cloudflare's logs
    // don't capture client-side errors, but this at least makes them
    // visible to anyone with DevTools open. Worth wiring Sentry/PostHog
    // here eventually.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);
    this.setState({ info });
  }

  render() {
    if (!this.state.error) return this.props.children;

    const reload = () => window.location.reload();
    const reset = () => {
      try {
        // Best-effort: clear in-progress 3D generations and the active
        // theme override so a hot reload doesn't immediately re-crash.
        localStorage.removeItem('vincritiq_pending_3d_jobs_v1');
      } catch {}
      reload();
    };

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          background: '#0a0a0a',
          color: '#f0efe9',
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica Neue, sans-serif',
          zIndex: 999999,
        }}
      >
        <div
          style={{
            maxWidth: 480,
            textAlign: 'center',
            padding: '32px 28px',
            borderRadius: 16,
            background: '#1c1c1a',
            border: '1px solid #2e2e2b',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 13, color: '#888882', marginBottom: 20, lineHeight: 1.5 }}>
            VinCritiq hit an unexpected error and couldn't continue. Your data
            is safe — reloading the page usually clears this.
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              onClick={reload}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: '#2563eb',
                color: '#fff',
                fontWeight: 600,
                fontSize: 13,
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <button
              onClick={reset}
              style={{
                padding: '10px 18px',
                borderRadius: 10,
                background: 'transparent',
                color: '#f0efe9',
                fontWeight: 600,
                fontSize: 13,
                border: '1px solid #2e2e2b',
                cursor: 'pointer',
              }}
            >
              Reset & Reload
            </button>
          </div>
          {process.env.NODE_ENV !== 'production' && (
            <details style={{ marginTop: 20, textAlign: 'left' }}>
              <summary
                style={{ cursor: 'pointer', fontSize: 11, color: '#888882' }}
              >
                Stack (dev only)
              </summary>
              <pre
                style={{
                  fontSize: 10,
                  whiteSpace: 'pre-wrap',
                  marginTop: 8,
                  color: '#dc2626',
                  maxHeight: 240,
                  overflow: 'auto',
                }}
              >
                {String(this.state.error?.stack || this.state.error)}
                {this.state.info?.componentStack || ''}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
