import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown above the reload button. */
  title?: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * A render error below this point shows a Thai panel instead of a white page.
 * A class component because React still has no hook for this. It has no
 * componentDidCatch and logs nothing
 * on purpose: an error thrown on these screens can carry customer data
 * (CLAUDE.md §12 — never log customer data), and the stack is not for staff.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <p>{this.props.title ?? 'เกิดข้อผิดพลาด โหลดหน้าใหม่'}</p>
        <button type="button" className="btn secondary" onClick={() => window.location.reload()}>
          โหลดหน้าใหม่
        </button>
      </div>
    );
  }
}
