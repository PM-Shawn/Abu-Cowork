/// <reference types="@testing-library/jest-dom" />

import { render, screen, cleanup } from '@testing-library/react';
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

  it('derive uses contextUsage.overhead when published, so live tokens = overhead + estimateMessageTokens(messages)', () => {
    // Streaming-style scenario: agentLoop published one turn ago with
    // tokensUsed=8000, overhead=7000 (1000 of messages then). The user's
    // assistant message has since grown by ~6000 tokens of fresh output.
    // The indicator should reflect overhead (7000) + current messages tokens,
    // NOT remain stuck on the stale 8000 published snapshot.
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
        overhead: 7000,
      },
    });
    render(<ContextIndicator conversationId="c1" />);
    const label = screen.getByTestId('context-indicator').getAttribute('aria-label') || '';
    // Expect a percent meaningfully higher than the stale 4% from the published snapshot.
    const percentMatch = label.match(/(\d+)%/);
    expect(percentMatch).not.toBeNull();
    const shownPercent = Number(percentMatch![1]);
    expect(shownPercent).toBeGreaterThan(4);
  });
});
