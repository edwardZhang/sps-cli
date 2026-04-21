import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 仅在开发时打印，prod 留给 server log 收集（M6 加）
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="p-6">
          <div className="nb-card max-w-2xl bg-[var(--color-crashed-bg)]">
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
              💥 UI 崩了
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
              刷新页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
