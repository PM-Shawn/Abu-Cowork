// @vitest-environment happy-dom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InstallDisclosureDialog from './InstallDisclosureDialog';
import { formatServerCommand } from './serverCommand';
import type { InstallDisclosure } from '@/core/plugin/installer';

const disclosure: InstallDisclosure = {
  key: 'weather@official',
  name: 'weather',
  marketplace: 'official',
  version: '1.2.0',
  manifest: { name: 'weather', version: '1.2.0' } as InstallDisclosure['manifest'],
  sourceDir: '/m/official/plugins/weather',
  skills: ['forecast', 'radar'],
  mcpServers: [
    {
      name: 'weather-mcp',
      command: 'npx',
      args: ['-y', '@acme/weather-mcp', '--verbose'],
    },
    { name: 'remote-weather', url: 'https://mcp.example.com/sse' },
  ],
  capabilities: ['network'],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof InstallDisclosureDialog>> = {}) {
  const props = {
    open: true,
    entryName: 'weather',
    state: { kind: 'ready', disclosure } as const,
    installing: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<InstallDisclosureDialog {...props} />);
  return props;
}

describe('formatServerCommand', () => {
  it('joins command and args the way a shell shows them, and falls back to the url', () => {
    expect(formatServerCommand({ command: 'node', args: ['server.js', '--port', '3000'] })).toBe(
      'node server.js --port 3000',
    );
    expect(formatServerCommand({ command: 'node' })).toBe('node');
    expect(formatServerCommand({ url: 'https://x/sse' })).toBe('https://x/sse');
  });
});

describe('InstallDisclosureDialog', () => {
  it('shows each MCP server with its complete executable command line', () => {
    renderDialog();

    const servers = screen.getAllByTestId('plugin-disclosure-server');
    expect(servers).toHaveLength(2);
    // The whole point of the screen: the literal command, not "1 connector".
    expect(servers[0]).toHaveTextContent('weather-mcp');
    expect(servers[0]).toHaveTextContent('npx -y @acme/weather-mcp --verbose');
    expect(servers[1]).toHaveTextContent('https://mcp.example.com/sse');
  });

  it('discloses the skills, source package and declared capabilities', () => {
    renderDialog();

    expect(screen.getByText('forecast')).toBeInTheDocument();
    expect(screen.getByText('radar')).toBeInTheDocument();
    expect(screen.getByText('/m/official/plugins/weather')).toBeInTheDocument();
    expect(screen.getByText('network')).toBeInTheDocument();
  });

  it('only reports a decision when the user acts on it', () => {
    const props = renderDialog();
    expect(props.onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders an unsupported remote source as an explanation, not a crash, and offers no install action', () => {
    renderDialog({ state: { kind: 'unsupported', sourceKind: 'git-subdir' }, entryName: 'cool-plugin' });

    const notice = screen.getByTestId('plugin-unsupported-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain('cool-plugin');
    // No confirm button at all — there is nothing to install.
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
  });

  it('renders a plan failure with its reason instead of throwing', () => {
    renderDialog({ state: { kind: 'error', message: 'No plugin manifest found in /m/x' } });

    expect(screen.getByText(/No plugin manifest found in \/m\/x/)).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull();
  });
});
