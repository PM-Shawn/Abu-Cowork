// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import type { Conversation, ToolCall } from '@/types';
import ContextSection from './ContextSection';

// The section starts the MCP sync when it mounts; the test seeds the store itself.
vi.mock('@/stores/mcpStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/mcpStore')>();
  return { ...actual, initMCPStoreSync: vi.fn() };
});

const CONV = 'conv-context';

function server(name: string, status: MCPServerEntry['status'], toolCount = 0): MCPServerEntry {
  return {
    config: { name },
    status,
    tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool-${i}` })),
  } as MCPServerEntry;
}

function seed({ loading }: { loading: boolean }) {
  const toolCalls: ToolCall[] = [
    { id: 't1', name: 'read_file', input: { path: '/work/notes.md' }, result: '# Notes\nfirst line' },
    { id: 't2', name: 'write_file', input: { path: '/work/main.ts' }, result: 'ok' },
    { id: 't3', name: 'github__search', input: {}, result: 'ok' },
    { id: 't4', name: 'slack__post', input: {}, result: 'ok' },
    { id: 't5', name: 'jira__list', input: {}, result: 'ok' },
  ];
  const conversation = {
    id: CONV,
    title: 'Context',
    messages: [{ id: 'm1', role: 'assistant', content: 'Working', timestamp: 1, toolCalls }],
    createdAt: 1,
    updatedAt: 1,
    status: 'running',
  } as Conversation;
  useChatStore.setState({ activeConversationId: CONV, conversations: { [CONV]: conversation } });
  useMCPStore.setState({
    isLoading: loading,
    servers: {
      github: server('github', 'connected', 2),
      slack: server('slack', 'reconnecting'),
      jira: server('jira', 'disconnected'),
    },
  });
}

function openContext() {
  render(<ContextSection />);
  const title = screen.getByRole('button', { name: /Activity Log/ });
  expect(title).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(title);
  expect(title).toHaveAttribute('aria-expanded', 'true');
}

function connectorsArea(): HTMLElement {
  const area = screen.getByRole('button', { name: /Connectors/ }).parentElement;
  if (!area) throw new Error('connectors area not found');
  return area;
}

describe('ContextSection', () => {
  beforeEach(() => {
    initLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
    useMCPStore.setState({ isLoading: false, servers: {} });
  });

  it('shows one spinner with its sentence while the connectors refresh, and still icons on the rows', () => {
    seed({ loading: true });
    openContext();

    const area = connectorsArea();
    expect(area.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(area).getByRole('status')).toHaveTextContent('Refreshing...');
    expect(within(area).getByText('Refreshing...')).not.toHaveClass('sr-only');

    const reconnecting = within(area).getByText('slack').parentElement as HTMLElement;
    expect(reconnecting.querySelector('svg')).toBeInTheDocument();
    expect(reconnecting.querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
    expect(reconnecting.querySelector('.animate-spin')).not.toBeInTheDocument();

    const disconnected = within(area).getByText('jira').parentElement as HTMLElement;
    expect(disconnected.querySelector('svg')).not.toBeInTheDocument();
    expect(within(area).getByText('2 tools')).toBeInTheDocument();
    expect(within(area).getByText('1/3')).toBeInTheDocument();
  });

  it('shows no spinner once the connectors are loaded', () => {
    seed({ loading: false });
    openContext();

    expect(connectorsArea().querySelector('[data-ds-spinner]')).not.toBeInTheDocument();
  });

  it('collapses the connectors from their own title button', () => {
    seed({ loading: false });
    openContext();
    const title = screen.getByRole('button', { name: /Connectors/ });
    expect(title).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('slack')).not.toBeInTheDocument();
  });

  it('expands a file that has content from its own button', () => {
    seed({ loading: false });
    openContext();

    const file = screen.getByRole('button', { name: 'notes.md' });
    expect(file).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('notes.md')).toHaveClass('font-code');
    expect(screen.queryByText(/first line/)).not.toBeInTheDocument();

    fireEvent.click(file);

    expect(file).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/first line/)).toHaveClass('font-code');
    // A file with nothing to show is a plain row.
    expect(screen.queryByRole('button', { name: 'main.ts' })).not.toBeInTheDocument();
    expect(screen.getByText('main.ts')).toBeInTheDocument();
  });

  it('counts tool use in neutral tags', () => {
    seed({ loading: false });
    openContext();

    const tag = screen.getByText('Read');
    expect(tag).toHaveClass('bg-fill');
    expect(tag).toHaveTextContent('Readx1');
    expect(screen.getByText('5 ops')).toBeInTheDocument();
  });
});
