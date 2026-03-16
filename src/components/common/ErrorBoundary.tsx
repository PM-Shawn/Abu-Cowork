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
          <p className="text-[14px] text-[#656358] mb-3">
            {t.errorBoundary.renderError}
          </p>
          <p className="text-[12px] text-[#b0ada4] mb-4 max-w-[300px]">
            {this.state.error?.message?.slice(0, 100) ?? t.errorBoundary.unknownError}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 text-[13px] rounded-lg bg-[#f5f3ee] text-[#3d3929] hover:bg-[#ebe8e1] transition-colors"
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
        <div className="px-3 py-2 text-[12px] text-[#b0ada4] bg-[#faf9f7] rounded-lg border border-[#f0ede8]">
          {t.errorBoundary.messageError}
          <button
            onClick={() => this.setState({ hasError: false })}
            className="ml-2 text-[#d97757] hover:underline"
          >
            {t.common.retry}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
