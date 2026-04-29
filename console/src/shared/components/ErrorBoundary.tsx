import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Fire-and-forget telemetry for client-side errors.
 * POST /api/system/client-errors with a small JSON payload. Keep it tiny — the
 * server enforces 8KB limit and truncates stack to ~4KB. Never throws.
 */
export function reportClientError(err: Error | string, context?: string): void {
  try {
    const payload = JSON.stringify({
      message: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      stack: (err instanceof Error ? err.stack ?? '' : '').slice(0, 4000),
      url: typeof window !== 'undefined' ? window.location.href : '',
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ts: new Date().toISOString(),
      context: context?.slice(0, 200),
    });
    // Use keepalive so reports aren't dropped on page unload
    fetch('/api/system/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => { /* never propagate */ });
  } catch {
    /* serialize error — drop */
  }
}

/** Install global error + unhandledrejection hooks. Call once at app boot. */
export function installGlobalErrorReporters(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (e) => {
    reportClientError(e.error ?? e.message ?? 'unknown error', 'window.error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    reportClientError(
      reason instanceof Error ? reason : String(reason),
      'unhandledrejection',
    );
  });
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // v0.49: ship error to server log for post-hoc debugging
    reportClientError(error, `ErrorBoundary: ${info.componentStack?.slice(0, 200) ?? ''}`);
    // Dev console still helpful for live iteration
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="p-6">
          <div className="nb-card max-w-2xl bg-[var(--color-crashed-bg)]">
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
              💥 UI crashed
            </h2>
            <p className="text-sm mb-3 text-[var(--color-text-muted)]">
              {this.state.error.message}
            </p>
            <details className="text-xs mb-4">
              <summary className="cursor-pointer font-semibold">stack</summary>
              <pre className="mt-2 font-[family-name:var(--font-mono)] overflow-auto max-h-60 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-md p-3">
                {this.state.error.stack ?? '(no stack)'}
              </pre>
            </details>
            <button
              className="nb-btn nb-btn-mint"
              type="button"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
