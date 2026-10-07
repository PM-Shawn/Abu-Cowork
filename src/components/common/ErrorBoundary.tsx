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
import { Button } from '@/components/ds/button';
import { traceErrorBoundaryCatch } from '@/core/observability/runtimeTrace';

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
      // The root boundary sits above DesignSystemProvider in App.tsx, and the provider can be what
      // threw. This page therefore renders only what needs nothing above it: plain elements and
      // `Button`, which reads no context. No IconButton or Tooltip, no Dialog, no useConfirm.
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center">
          <p className="mb-3 text-ui text-label-secondary">
            {t.errorBoundary.renderError}
          </p>
          <p className="mb-4 max-w-80 text-ui-sm text-label-tertiary">
            {this.state.error?.message?.slice(0, 100) ?? t.errorBoundary.unknownError}
          </p>
          <Button variant="secondary" size="sm" onClick={() => this.setState({ hasError: false, error: null })}>
            {t.common.retry}
          </Button>
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
    // This boundary has no generic onError prop — it wraps message rendering
    // and nothing else — so it records its own catch instead of asking each of
    // its call sites in MessageGroup to pass the same handler.
    traceErrorBoundaryCatch('message_render', error);
  }

  render() {
    if (this.state.hasError) {
      const t = getI18n();
      return (
        <div className="flex items-center gap-2 rounded-control border border-separator bg-fill px-3 py-1 text-ui-sm text-label-secondary">
          <span>{t.errorBoundary.messageError}</span>
          <Button variant="plain" size="sm" onClick={() => this.setState({ hasError: false })}>
            {t.common.retry}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
