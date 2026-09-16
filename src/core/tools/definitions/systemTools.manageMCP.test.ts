import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '../../../i18n';
import { getArgLabel } from '../../agent/mcpDiscovery';
import { useMCPStore } from '../../../stores/mcpStore';
import { manageMCPServerTool } from './systemTools';

/**
 * The agent installs connectors through this tool, so whatever the marketplace
 * form asks a user for, the tool has to be able to accept from the model —
 * otherwise the two install paths disagree and the agent's install silently
 * produces a server that cannot start.
 */
describe('manage_mcp_server configurable arguments', () => {
  // Replace the store's actions rather than spying on them: zustand's immer
  // middleware hands out a new state object per set(), so a spy installed on
  // one of them survives restoreAllMocks() and keeps counting on the next.
  const realAddServer = useMCPStore.getState().addServer;
  const realConnectServer = useMCPStore.getState().connectServer;
  let addServer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    initLanguage('en-US');
    addServer = vi.fn();
    useMCPStore.setState({
      servers: {},
      isLoading: false,
      addServer,
      connectServer: vi.fn(async () => {}),
    });
  });

  afterEach(() => {
    useMCPStore.setState({ addServer: realAddServer, connectServer: realConnectServer });
  });

  it('declares args in the input schema so the model can supply a slot', () => {
    const properties = manageMCPServerTool.inputSchema.properties as Record<string, {
      type?: string;
      items?: { type?: string };
      description?: string;
    }>;
    expect(properties.args).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(properties.args.description).toContain('postgres');
  });

  it('passes args through to the install, filling the configurable slot', async () => {
    await manageMCPServerTool.execute({
      action: 'install',
      name: 'postgres',
      args: ['postgresql://u:p@h:5432/app'],
    });

    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://u:p@h:5432/app'],
    }));
  });

  it('refuses an install that leaves the slot empty, naming the parameter', async () => {
    const result = await manageMCPServerTool.execute({ action: 'install', name: 'postgres' });

    expect(result).toContain(getArgLabel('postgres', 2)!);
    expect(addServer).not.toHaveBeenCalled();
  });

  it('tells search results which parameters a connector still needs', async () => {
    const result = await manageMCPServerTool.execute({ action: 'search', query: 'postgres' });

    expect(result).toContain('postgres');
    expect(result).toContain(getArgLabel('postgres', 2)!);
  });

  it('still lists required env vars for a connector that takes no arguments', async () => {
    const result = await manageMCPServerTool.execute({ action: 'search', query: 'sentry' });

    expect(result).toContain('SENTRY_ACCESS_TOKEN');
  });
});
