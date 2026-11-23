import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryState {
  readonly errorMessage: string | null;
}

/** Top-level error boundary preventing unhandled render exceptions from blanking the desktop UI. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { errorMessage: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { errorMessage: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[ntc-ui] Erro de renderização capturado:', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.errorMessage) {
      return (
        <main className="main-content">
          <section className="card" role="alert">
            <h2>Erro inesperado na interface NT Conformidade</h2>
            <p className="alert alert-danger">{this.state.errorMessage}</p>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
