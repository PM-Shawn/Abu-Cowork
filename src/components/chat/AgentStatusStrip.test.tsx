// @vitest-environment happy-dom
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
    useChatStore.setState({ conversations: { c1: baseConv }, agentStates: new Map() });
  });
  afterEach(() => cleanup());

  it('renders nothing when neither compressing nor retrying', () => {
    const { container } = render(<AgentStatusStrip conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the compaction status while compressing', () => {
    useChatStore.setState({
      conversations: { c1: { ...baseConv, isCompressing: true } },
      agentStates: new Map(),
    });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/Compacting|压缩/)).toBeInTheDocument();
  });

  it('shows "正在重试 N/M" while retrying', () => {
    useChatStore.getState().setRetryInfo('c1', { attempt: 2, maxAttempts: 3, delayMs: 5000 });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/(retrying|重试).*2\/3/)).toBeInTheDocument();
  });

  it('prioritizes retry over compaction when both are active', () => {
    useChatStore.setState({
      conversations: { c1: { ...baseConv, isCompressing: true } },
    });
    useChatStore.getState().setRetryInfo('c1', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
    render(<AgentStatusStrip conversationId="c1" />);
    expect(screen.getByText(/retrying|重试/)).toBeInTheDocument();
    expect(screen.queryByText(/Compacting|压缩/)).not.toBeInTheDocument();
  });

  it('shows its words inside the one design-system spinner', () => {
    useChatStore.setState({
      conversations: { c1: { ...baseConv, isCompressing: true } },
      agentStates: new Map(),
    });
    const { container } = render(<AgentStatusStrip conversationId="c1" />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/Compacting|压缩/);
    expect(status.querySelector('[data-ds-spinner]')).not.toBeNull();
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(container.querySelector('.animate-spin:not([data-ds-spinner])')).toBeNull();
  });

  it('does not show another conversation retry state', () => {
    useChatStore.setState({
      conversations: { c1: baseConv, c2: { ...baseConv, id: 'c2' } },
    });
    useChatStore.getState().setRetryInfo('c1', { attempt: 2, maxAttempts: 3, delayMs: 5000 });
    const { container } = render(<AgentStatusStrip conversationId="c2" />);
    expect(container).toBeEmptyDOMElement();
  });
});
