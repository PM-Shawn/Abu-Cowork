/// <reference types="@testing-library/jest-dom" />

import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AgentStatusStrip from './AgentStatusStrip';
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

describe('AgentStatusStrip (Bug 1: 死寂可见)', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: { c1: baseConv }, retryInfo: null });
  });
  afterEach(() => cleanup());

  it('renders nothing when neither compressing nor retrying', () => {
    const { container } = render(<AgentStatusStrip conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the compaction status while compressing', () => {
    useChatStore.setState({
      conversations: { c1: { ...baseConv, isCompressing: true } },
      retryInfo: null,
    });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/Compacting|压缩/)).toBeInTheDocument();
  });

  it('shows "正在重试 N/M" while retrying', () => {
    useChatStore.setState({
      conversations: { c1: baseConv },
      retryInfo: { attempt: 2, maxAttempts: 3, delayMs: 5000 },
    });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/(retrying|重试).*2\/3/)).toBeInTheDocument();
  });

  it('prioritizes retry over compaction when both are active', () => {
    useChatStore.setState({
      conversations: { c1: { ...baseConv, isCompressing: true } },
      retryInfo: { attempt: 1, maxAttempts: 3, delayMs: 1000 },
    });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/retrying|重试/)).toBeInTheDocument();
    expect(screen.queryByText(/Compacting|压缩/)).not.toBeInTheDocument();
  });
});
