// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getI18n } from '@/i18n';
import { traceErrorBoundaryCatch } from '@/core/observability/runtimeTrace';
import { DesignSystemProvider } from '@/components/ds/provider';
import { ErrorBoundary, MessageErrorBoundary } from './ErrorBoundary';

vi.mock('@/core/observability/runtimeTrace', () => ({ traceErrorBoundaryCatch: vi.fn() }));

const t = () => getI18n();

// What the child under the boundary throws while it renders; null renders the child's words.
let thrown: unknown = null;
function Child() {
  if (thrown !== null) throw thrown;
  return <p>child content</p>;
}

const retry = () => screen.getByRole('button', { name: t().common.retry });

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  thrown = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.mocked(traceErrorBoundaryCatch).mockClear();
});

// Every test here renders with no DesignSystemProvider above the boundary unless it says so: the
// root boundary sits above the provider in App.tsx, so its page must stand without one.
describe('ErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(<ErrorBoundary><Child /></ErrorBoundary>);
    expect(screen.getByText('child content')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('after a child threw while rendering', () => {
    it('shows the sentence, the message of the error and one retry button', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(screen.getByText(t().errorBoundary.renderError)).toBeInTheDocument();
      expect(screen.getByText('injected failure')).toBeInTheDocument();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(retry().tagName).toBe('BUTTON');
      expect(retry()).toHaveTextContent(t().common.retry);
      expect(screen.queryByText('child content')).toBeNull();
    });

    it('shows the first 100 characters of a long message', () => {
      thrown = new Error(`${'a'.repeat(100)}${'b'.repeat(50)}`);
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(screen.getByText('a'.repeat(100))).toBeInTheDocument();
    });

    it('says the error is unknown when what was thrown has no message', () => {
      thrown = {};
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(screen.getByText(t().errorBoundary.unknownError)).toBeInTheDocument();
    });

    it('renders its children again on retry', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      thrown = null;
      fireEvent.click(retry());
      expect(screen.getByText('child content')).toBeInTheDocument();
      expect(screen.queryByText(t().errorBoundary.renderError)).toBeNull();
    });

    it('shows the page again when the child still throws on retry', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      fireEvent.click(retry());
      expect(screen.getByText(t().errorBoundary.renderError)).toBeInTheDocument();
      expect(screen.queryByText('child content')).toBeNull();
    });

    it('reports the error to its owner and to the console', () => {
      const onError = vi.fn();
      thrown = new Error('injected failure');
      render(<ErrorBoundary onError={onError}><Child /></ErrorBoundary>);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBe(thrown);
      expect(consoleError.mock.calls.some((call) => call[0] === '[ErrorBoundary] Caught render error:' && call[1] === thrown)).toBe(true);
    });

    it('shows the fallback of its owner in place of its own page', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary fallback={<p>owner fallback</p>}><Child /></ErrorBoundary>);
      expect(screen.getByText('owner fallback')).toBeInTheDocument();
      expect(screen.queryByText(t().errorBoundary.renderError)).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('stands when the design-system provider under it is what failed', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><DesignSystemProvider><Child /></DesignSystemProvider></ErrorBoundary>);
      expect(screen.getByText(t().errorBoundary.renderError)).toBeInTheDocument();
      thrown = null;
      fireEvent.click(retry());
      expect(screen.getByText('child content')).toBeInTheDocument();
    });
  });

  describe('how its page looks', () => {
    it('writes the sentence and the message in interface text', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(screen.getByText(t().errorBoundary.renderError)).toHaveClass('text-ui', 'text-label-secondary');
      expect(screen.getByText('injected failure')).toHaveClass('text-ui-sm', 'text-label-tertiary', 'max-w-80');
    });

    it('draws retry as a design-system button', () => {
      thrown = new Error('injected failure');
      render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(retry()).toHaveClass('rounded-control', 'bg-fill', 'text-label');
      expect(retry()).toHaveAttribute('type', 'button');
    });

    it('uses no legacy color variable', () => {
      thrown = new Error('injected failure');
      const { container } = render(<ErrorBoundary><Child /></ErrorBoundary>);
      expect(container.innerHTML).not.toContain('--abu-');
    });
  });
});

describe('MessageErrorBoundary', () => {
  it('renders its children while nothing throws', () => {
    render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
    expect(screen.getByText('child content')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('after a message threw while rendering', () => {
    it('shows one line and one retry button, and nothing of the error', () => {
      thrown = new Error('injected failure');
      const { container } = render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      expect(container).toHaveTextContent(t().errorBoundary.messageError);
      expect(container).not.toHaveTextContent('injected failure');
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(retry().tagName).toBe('BUTTON');
      expect(retry()).toHaveTextContent(t().common.retry);
    });

    it('renders the message again on retry', () => {
      thrown = new Error('injected failure');
      const { container } = render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      thrown = null;
      fireEvent.click(retry());
      expect(screen.getByText('child content')).toBeInTheDocument();
      expect(container).not.toHaveTextContent(t().errorBoundary.messageError);
    });

    it('records the catch and logs the message of the error', () => {
      thrown = new Error('injected failure');
      render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      expect(traceErrorBoundaryCatch).toHaveBeenCalledTimes(1);
      expect(traceErrorBoundaryCatch).toHaveBeenCalledWith('message_render', thrown);
      expect(consoleError.mock.calls.some((call) => call[0] === '[MessageErrorBoundary] Message render failed:' && call[1] === 'injected failure')).toBe(true);
    });
  });

  describe('how its line looks', () => {
    it('is a filled box with a separator line, in interface text', () => {
      thrown = new Error('injected failure');
      render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      const box = screen.getByText(t().errorBoundary.messageError).closest('div')!;
      expect(box).toHaveClass('rounded-control', 'border', 'border-separator', 'bg-fill', 'text-ui-sm', 'text-label-secondary');
    });

    it('draws retry as a design-system button', () => {
      thrown = new Error('injected failure');
      render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      expect(retry()).toHaveClass('rounded-control', 'text-label');
      expect(retry()).toHaveAttribute('type', 'button');
    });

    it('uses no legacy color variable', () => {
      thrown = new Error('injected failure');
      const { container } = render(<MessageErrorBoundary><Child /></MessageErrorBoundary>);
      expect(container.innerHTML).not.toContain('--abu-');
    });
  });
});
