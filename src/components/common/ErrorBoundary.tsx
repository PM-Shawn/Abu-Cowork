/**
 * ErrorBoundary — catches render-time exceptions to prevent app white-screen.
 *
 * This is intentionally a class component — React does not support
 * componentDidCatch in function components as of React 18.
 * Uses getI18n() (non-hook) for i18n access in class components.
 */

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { getI18n } from '@/i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      const t = getI18n();
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <p className="text-[14px] text-[var(--abu-text-tertiary)] mb-3">
            {t.errorBoundary.renderError}
          </p>
          <p className="text-[12px] text-[var(--abu-text-placeholder)] mb-4 max-w-[300px]">
            {this.state.error?.message?.slice(0, 100) ?? t.errorBoundary.unknownError}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 text-[13px] rounded-lg bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
          >
            {t.common.retry}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export class MessageErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error('[MessageErrorBoundary] Message render failed:', error.message);
  }

  render() {
    if (this.state.hasError) {
      const t = getI18n();
      return (
        <div className="px-3 py-2 text-[12px] text-[var(--abu-text-placeholder)] bg-[var(--abu-bg-muted)] rounded-lg border border-[var(--abu-bg-active)]">
          {t.errorBoundary.messageError}
          <button
            onClick={() => this.setState({ hasError: false })}
            className="ml-2 text-[var(--abu-clay)] hover:underline"
          >
            {t.common.retry}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
