import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error boundary caught:', error, info);
  }

  reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="empty">
          <h2>Une erreur est survenue</h2>
          <pre style={{ textAlign: 'left', background: 'var(--bg-elev-2)', padding: 12, borderRadius: 6, overflow: 'auto' }}>
            {this.state.error.message}
          </pre>
          <button className="primary" onClick={this.reset}>Réessayer</button>
        </div>
      );
    }
    return this.props.children;
  }
}
