// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import RenderableCodeBlock, { type CodeBlockRendererConfig } from './RenderableCodeBlock';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function makeConfig(render: CodeBlockRendererConfig['render']): CodeBlockRendererConfig {
  return {
    label: 'diagram-test',
    fallbackLanguage: 'mermaid',
    render,
    debounceMs: 10,
    i18n: { loading: 'Rendering', renderError: 'Failed', expand: 'Expand', collapse: 'Collapse' },
  };
}

describe('RenderableCodeBlock bordered mode', () => {
  it('paints the diagram on the fixed diagram canvas', async () => {
    let target: HTMLDivElement | null = null;
    const config = makeConfig(async (_code, container) => {
      target = container;
      container.innerHTML = '<svg></svg>';
    });
    render(<DesignSystemProvider><RenderableCodeBlock code="graph TD; A-->B" config={config} /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(target).not.toBeNull();
    const canvas = (target as unknown as HTMLDivElement).parentElement?.parentElement;
    expect(canvas).toHaveClass('bg-diagram-canvas');
  });

  it('keeps the reset-zoom button at the button text size', async () => {
    const config = makeConfig(async (_code, container) => { container.innerHTML = '<svg></svg>'; });
    render(<DesignSystemProvider><RenderableCodeBlock code="graph TD; B-->C" config={config} /></DesignSystemProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const reset = screen.getByRole('button', { name: '100%' });
    expect(reset).toHaveClass('text-ui-sm');
    expect(reset).not.toHaveClass('text-caption');
  });
});
