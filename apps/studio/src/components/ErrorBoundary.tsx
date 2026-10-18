/**
 * When part of the window fails to draw, React drops everything under it and the window goes blank. This shows
 * what went wrong instead, with a way to try again and the details to send in. The engine (where the game data
 * and unsaved changes live) is a separate process, so nothing is lost.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../state/store';

declare const __APP_VERSION__: string | undefined;

interface Props {
  /** What this covers, for the message ("the AI tab", "the window"). */
  where: string;
  children: ReactNode;
  /** A change here (like switching tabs) clears the error and draws again. */
  resetKey?: unknown;
}

export class ErrorBoundary extends Component<Props, { error?: Error; stack?: string; copied?: boolean }> {
  override state: { error?: Error; stack?: string; copied?: boolean } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? undefined });
    console.error(`[${this.props.where}]`, error, info.componentStack);
    try {
      useStore.getState().addLog('error', `Couldn't show ${this.props.where}: ${error.message}`);
    } catch {
      // The store itself failed; the message on screen is enough.
    }
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined, stack: undefined, copied: false });
  }

  private details(): string {
    const e = this.state.error!;
    const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '?';
    return [`TES5 Env Editor ${version}: couldn't show ${this.props.where}`, `${e.name}: ${e.message}`, e.stack ?? '', this.state.stack ? `Components:${this.state.stack}` : ''].filter(Boolean).join('\n');
  }

  override render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="error-panel" role="alert" data-testid="error-panel">
        <h2>Something went wrong showing {this.props.where}</h2>
        <p>
          {this.props.where === 'the window'
            ? 'Your work is safe: the game data and your unsaved changes are kept by the editor. Press Try again to bring the window back.'
            : 'Your work is safe: the game data and your unsaved changes are kept by the editor, and Ctrl+S still saves. Try again, or switch to another tab and back.'}
        </p>
        <pre className="mono small">{`${e.name}: ${e.message}`}</pre>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn primary" onClick={() => this.setState({ error: undefined, stack: undefined, copied: false })} title="Draw this part of the window again" data-testid="error-retry">
            Try again
          </button>
          <button
            className="btn"
            onClick={() => void navigator.clipboard?.writeText(this.details()).then(() => this.setState({ copied: true }), () => undefined)}
            title="Copy what went wrong (with the version), to send in with a bug report"
            data-testid="error-copy"
          >
            {this.state.copied ? 'Copied' : 'Copy the details'}
          </button>
        </div>
      </div>
    );
  }
}
