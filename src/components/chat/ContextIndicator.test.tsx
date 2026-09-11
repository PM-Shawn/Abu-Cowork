// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ContextIndicator from './ContextIndicator';
import { useChatStore } from '../../stores/chatStore';
import type { Conversation } from '../../types';

const baseConv: Conversation = {
  id: 'c1',
  title: 't',
  messages: [],
  createdAt: 0,
  updatedAt: 0,
  status: 'idle',
};

function setConv(patch: Partial<Conversation>) {
  useChatStore.setState({
    conversations: { c1: { ...baseConv, ...patch } },
  });
}

describe('ContextIndicator', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: { c1: baseConv } });
  });

  afterEach(() => cleanup());

  it('renders only the empty track when no usage and not compressing', () => {
    render(<ContextIndicator conversationId="c1" />);
    const indicator = screen.getByTestId('context-indicator');
    const circles = indicator.querySelectorAll('circle');
    expect(circles.length).toBe(1); // track only
  });

  it('renders progress arc with usage', () => {
    setConv({ contextUsage: { percent: 50, tokensUsed: 1000, tokensMax: 2000 } });
    render(<ContextIndicator conversationId="c1" />);
    const indicator = screen.getByTestId('context-indicator');
    const circles = indicator.querySelectorAll('circle');
    expect(circles.length).toBe(2); // track + progress
  });

  it('applies critical color + animate-pulse class at >=85% usage', () => {
    setConv({ contextUsage: { percent: 92, tokensUsed: 1840, tokensMax: 2000 } });
    render(<ContextIndicator conversationId="c1" />);
    const progress = screen.getByTestId('context-indicator').querySelectorAll('circle')[1];
    const className = progress.getAttribute('class') || '';
    expect(className).toContain('text-[var(--abu-danger)]');
    expect(className).toContain('animate-pulse');
  });

  it('shows spinner instead of ring while compressing', () => {
    setConv({ isCompressing: true });
    render(<ContextIndicator conversationId="c1" />);
    const indicator = screen.getByTestId('context-indicator');
    // No SVG circles when compressing (Loader2 renders differently)
    expect(indicator.querySelectorAll('circle').length).toBe(0);
    // Spinner has animate-spin class
    expect(indicator.querySelector('.animate-spin')).toBeTruthy();
  });

  it('exposes tooltip text via aria-label for accessibility', () => {
    setConv({ contextUsage: { percent: 73, tokensUsed: 1460, tokensMax: 2000 } });
    render(<ContextIndicator conversationId="c1" />);
    const indicator = screen.getByTestId('context-indicator');
    const label = indicator.getAttribute('aria-label') || '';
    expect(label).toContain('73');
    expect(label).toMatch(/1\.5k|1460/);
    expect(label).toMatch(/2\.0k|2000/);
  });

  it('derives usage from messages when contextUsage has not been published yet (restart / history view)', () => {
    // Simulates the just-restarted state: messages are loaded from JSONL,
    // but agentLoop has not yet run a turn so `contextUsage` is undefined.
    // The indicator should still show a derived water-level from messages
    // alone (+ a fallback overhead constant).
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'Hello world.', timestamp: 0 },
        { id: 'm2', role: 'assistant', content: 'Hi there. ' + 'x'.repeat(2000), timestamp: 0 },
      ],
      contextUsage: undefined,
    });
    render(<ContextIndicator conversationId="c1" />);
    const indicator = screen.getByTestId('context-indicator');
    // Progress arc should now render (track + arc = 2 circles) — proving the
    // derive fired even without a published usage value.
    expect(indicator.querySelectorAll('circle').length).toBe(2);
  });

  it('adds only the messages after messageCountAtPublish, so streaming output moves the ring', () => {
    // Streaming scenario: agentLoop published at the top of this turn with
    // tokensUsed=8000 covering the first message (anchor=1). The assistant
    // reply at index 1 has since streamed in ~6000 tokens of fresh output.
    // Those tokens are NOT in the published snapshot, so the indicator must
    // add them — otherwise the ring freezes for the whole turn.
    const heavyContent = 'x'.repeat(24_000); // ~6000 tokens at ~4 chars/token
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'Write me a long essay.', timestamp: 0 },
        { id: 'm2', role: 'assistant', content: heavyContent, timestamp: 0 },
      ],
      contextUsage: {
        percent: 4,
        tokensUsed: 8000,
        tokensMax: 200_000,
        messageCountAtPublish: 1,
      },
    });
    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    expect(label).toMatch(/14\.\dk/); // 8000 published + ~6000 streamed
  });

  it('excludes compact-boundary markers from the post-publish tail estimate', () => {
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'already counted', timestamp: 0 },
        {
          id: 'compact-boundary-test',
          role: 'system',
          content: '',
          timestamp: 1,
          compactBoundary: {
            summaryText: 'summary',
            summarizedFromId: 'm1',
            summarizedToId: 'm1',
            createdAt: 1,
            source: 'manual',
          },
        },
      ],
      contextUsage: {
        percent: 1,
        tokensUsed: 100,
        tokensMax: 10_000,
        messageCountAtPublish: 1,
      },
    });

    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    expect(label).toContain('100 / 10.0k');
  });

  it('still counts ordinary user messages marked isSystem in the post-publish tail', () => {
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'already counted', timestamp: 0 },
        { id: 'm2', role: 'user', content: '', timestamp: 1, isSystem: true },
      ],
      contextUsage: {
        percent: 1,
        tokensUsed: 100,
        tokensMax: 10_000,
        messageCountAtPublish: 1,
      },
    });

    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    expect(label).toContain('104 / 10.0k');
  });

  it('does not re-count the history behind the anchor, so a compacted conversation stays under 100%', () => {
    // The 108% regression: a long conversation whose payload the agent loop had
    // already compacted down to 60k of a 128k window. The raw history kept for
    // the UI is far larger than what was actually sent — counting it wholesale
    // is what previously pushed the reading past the window.
    const bulk = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: 'y'.repeat(20_000), // ~5000 tokens each → ~200k of raw history
      timestamp: 0,
    }));
    setConv({
      messages: bulk,
      contextUsage: {
        percent: 47,
        tokensUsed: 60_000,
        tokensMax: 128_000,
        messageCountAtPublish: bulk.length,
      },
    });
    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    expect(label).toContain('47');
    expect(label).toContain('60.0k');
  });

  it('ignores a stale anchor that overruns the message list (revert / delete)', () => {
    // History shrank under the snapshot. Adding a negative-length tail or
    // slicing from a past-the-end index must not throw or inflate the reading.
    setConv({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }],
      contextUsage: {
        percent: 25,
        tokensUsed: 500,
        tokensMax: 2000,
        messageCountAtPublish: 9,
      },
    });
    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    expect(label).toContain('25');
  });

  it('clamps the displayed percent to 100 instead of rendering an over-budget estimate', () => {
    // Even with the anchor fix, a long streaming tail can push the estimate past
    // the window. The request the loop sends is budget-gated, so >100% is always
    // a measurement artifact — it must never reach the user as "108% 已用".
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'go', timestamp: 0 },
        { id: 'm2', role: 'assistant', content: 'z'.repeat(400_000), timestamp: 0 },
      ],
      contextUsage: {
        percent: 90,
        tokensUsed: 115_000,
        tokensMax: 128_000,
        messageCountAtPublish: 1,
      },
    });
    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    const shownPercent = Number((label.match(/(\d+)%/) ?? [])[1]);
    expect(shownPercent).toBe(100);
  });

  it('keeps the legacy non-interactive DOM when no v1 breakdown is available', async () => {
    const user = userEvent.setup();
    setConv({ contextUsage: { percent: 50, tokensUsed: 1000, tokensMax: 2000 } });
    render(<ContextIndicator conversationId="c1" />);

    const indicator = screen.getByTestId('context-indicator');
    expect(indicator.tagName).toBe('SPAN');
    expect(indicator).not.toHaveAttribute('aria-expanded');
    expect(indicator.getAttributeNames().sort()).toEqual([
      'aria-label',
      'class',
      'data-slot',
      'data-state',
      'data-testid',
      'style',
    ]);
    expect(indicator).toHaveAttribute(
      'class',
      'inline-flex items-center justify-center select-none',
    );
    expect(indicator).toHaveStyle({ width: '22px', height: '22px' });
    expect(indicator.querySelectorAll('circle')).toHaveLength(2);

    await user.click(indicator);
    expect(screen.queryByTestId('context-breakdown-popover')).not.toBeInTheDocument();
  });

  it('rejects an unknown breakdown version instead of rendering guessed data', async () => {
    const user = userEvent.setup();
    setConv({
      contextUsage: {
        percent: 50,
        tokensUsed: 1000,
        tokensMax: 2000,
        breakdown: {
          version: 2 as 1,
          systemPrompt: 200,
          tools: 200,
          mcp: 200,
          skills: 200,
          conversation: 200,
        },
      },
    });
    render(<ContextIndicator conversationId="c1" />);

    const indicator = screen.getByTestId('context-indicator');
    expect(indicator.tagName).toBe('SPAN');
    await user.click(indicator);
    expect(screen.queryByTestId('context-breakdown-popover')).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'bucket total does not match tokensUsed',
      tokensUsed: 1000,
      tokensMax: 2000,
      breakdown: {
        version: 1 as const,
        systemPrompt: 0,
        tools: 0,
        mcp: 0,
        skills: 0,
        conversation: 0,
      },
    },
    {
      name: 'a bucket is negative',
      tokensUsed: 1000,
      tokensMax: 2000,
      breakdown: {
        version: 1 as const,
        systemPrompt: -1,
        tools: 1001,
        mcp: 0,
        skills: 0,
        conversation: 0,
      },
    },
    {
      name: 'a bucket is not finite',
      tokensUsed: 1000,
      tokensMax: 2000,
      breakdown: {
        version: 1 as const,
        systemPrompt: Number.NaN,
        tools: 1000,
        mcp: 0,
        skills: 0,
        conversation: 0,
      },
    },
    {
      name: 'the context window is not positive',
      tokensUsed: 0,
      tokensMax: 0,
      breakdown: {
        version: 1 as const,
        systemPrompt: 0,
        tools: 0,
        mcp: 0,
        skills: 0,
        conversation: 0,
      },
    },
  ])('keeps malformed v1 data non-interactive when $name', ({ tokensUsed, tokensMax, breakdown }) => {
    setConv({
      contextUsage: {
        percent: 50,
        tokensUsed,
        tokensMax,
        breakdown,
      },
    });
    render(<ContextIndicator conversationId="c1" />);

    expect(screen.getByTestId('context-indicator').tagName).toBe('SPAN');
    expect(screen.queryByTestId('context-breakdown-popover')).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'JSON null values would otherwise coerce to zero',
      messages: [],
      tokensUsed: null as unknown as number,
      conversation: null as unknown as number,
    },
    {
      name: 'a negative snapshot would otherwise be rescued by its tail',
      messages: [
        { id: 'tail', role: 'user' as const, content: 'tail', timestamp: 1 },
      ],
      tokensUsed: -1,
      conversation: -1,
    },
  ])('validates the raw published snapshot before tail arithmetic when $name', ({
    messages,
    tokensUsed,
    conversation,
  }) => {
    setConv({
      messages,
      contextUsage: {
        percent: 0,
        tokensUsed,
        tokensMax: 2000,
        messageCountAtPublish: 0,
        breakdown: {
          version: 1,
          systemPrompt: 0,
          tools: 0,
          mcp: 0,
          skills: 0,
          conversation,
        },
      },
    });
    render(<ContextIndicator conversationId="c1" />);

    expect(screen.getByTestId('context-indicator').tagName).toBe('SPAN');
    expect(screen.queryByTestId('context-breakdown-popover')).not.toBeInTheDocument();
  });

  it('opens a v1 breakdown whose five integer percentages sum to the header percent', async () => {
    const user = userEvent.setup();
    setConv({
      contextUsage: {
        percent: 3,
        tokensUsed: 5,
        tokensMax: 167,
        breakdown: {
          version: 1,
          systemPrompt: 1,
          tools: 1,
          mcp: 1,
          skills: 1,
          conversation: 1,
        },
      },
    });
    render(<ContextIndicator conversationId="c1" />);

    const indicator = screen.getByTestId('context-indicator');
    expect(indicator.tagName).toBe('BUTTON');
    expect(indicator).toHaveAttribute('aria-expanded', 'false');

    await user.click(indicator);

    expect(screen.getByTestId('context-breakdown-popover')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^context-breakdown-row-/)).toHaveLength(5);
    const displayedPercent = screen
      .getAllByTestId(/^context-breakdown-percent-/)
      .reduce((sum, element) => sum + Number.parseInt(element.textContent ?? '0', 10), 0);
    expect(displayedPercent).toBe(3);
    expect(screen.getByTestId('context-breakdown-header')).toHaveTextContent('3%');
    const freeLabel = screen.getByTestId('context-breakdown-bar').getAttribute('aria-label') ?? '';
    expect(freeLabel).toMatch(/: 162 · 97%$/);
    expect(freeLabel).not.toContain('tokens');
  });

  it('adds the streaming tail only to the displayed conversation bucket', async () => {
    const user = userEvent.setup();
    setConv({
      messages: [
        { id: 'm1', role: 'user', content: 'already counted', timestamp: 0 },
        { id: 'm2', role: 'user', content: '', timestamp: 1, isSystem: true },
      ],
      contextUsage: {
        percent: 5,
        tokensUsed: 500,
        tokensMax: 10_000,
        messageCountAtPublish: 1,
        breakdown: {
          version: 1,
          systemPrompt: 100,
          tools: 100,
          mcp: 100,
          skills: 100,
          conversation: 100,
        },
      },
    });
    render(<ContextIndicator conversationId="c1" />);

    await user.click(screen.getByTestId('context-indicator'));

    expect(screen.getByTestId('context-breakdown-tokens-systemPrompt')).toHaveTextContent('100');
    expect(screen.getByTestId('context-breakdown-tokens-conversation')).toHaveTextContent('104');
  });
});
