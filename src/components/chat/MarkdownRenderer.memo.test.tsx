// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
// A finished code block or diagram must not re-render when the reply around it grows:
// ReactMarkdown rebuilds its tree on every streamed token, and each block carries
// toolbar tooltips.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';

const highlighterRenders = vi.fn();
const shellRenders = vi.fn();

vi.mock('react-syntax-highlighter', () => {
  const PrismLight = ({ children }: { children: string }) => {
    highlighterRenders();
    return <div>{children}</div>;
  };
  PrismLight.registerLanguage = () => {};
  return { PrismLight };
});

vi.mock('./RenderableCodeBlock', () => ({
  default: ({ code }: { code: string }) => {
    shellRenders();
    return <div>{code}</div>;
  },
}));

const { CollapsibleCodeBlock } = await import('./MarkdownRenderer');
const { default: MermaidBlock } = await import('./MermaidBlock');
const { default: HtmlWidgetBlock } = await import('./HtmlWidgetBlock');

afterEach(() => {
  cleanup();
  highlighterRenders.mockClear();
  shellRenders.mockClear();
});

// Stands in for the streaming reply: `tick` changes, the block's own props do not.
function Reply({ tick, children }: { tick: number; children: React.ReactNode }) {
  return <DesignSystemProvider><span data-tick={tick} />{children}</DesignSystemProvider>;
}

describe('finished blocks skip re-rendering while the reply grows', () => {
  it('code block', () => {
    const { rerender } = render(<Reply tick={0}><CollapsibleCodeBlock codeString="const a = 1;" language="typescript" /></Reply>);
    const first = highlighterRenders.mock.calls.length;
    rerender(<Reply tick={1}><CollapsibleCodeBlock codeString="const a = 1;" language="typescript" /></Reply>);
    expect(highlighterRenders.mock.calls.length).toBe(first);
  });

  it('diagram', () => {
    const { rerender } = render(<Reply tick={0}><MermaidBlock code="graph TD; A-->B" /></Reply>);
    const first = shellRenders.mock.calls.length;
    rerender(<Reply tick={1}><MermaidBlock code="graph TD; A-->B" /></Reply>);
    expect(shellRenders.mock.calls.length).toBe(first);
  });

  it('HTML widget', () => {
    const { rerender } = render(<Reply tick={0}><HtmlWidgetBlock code="<div>hi</div>" /></Reply>);
    const first = shellRenders.mock.calls.length;
    rerender(<Reply tick={1}><HtmlWidgetBlock code="<div>hi</div>" /></Reply>);
    expect(shellRenders.mock.calls.length).toBe(first);
  });
});
