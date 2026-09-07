// @vitest-environment happy-dom
/**
 * The `@` picker is where an agent is chosen mid-conversation, so it is the one
 * place a plugin-contributed agent has to be recognisable without opening
 * anything: one muted word, no plugin name (the row has no space for it).
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentMetadata } from '@/types';
import { getI18n } from '@/i18n';
import AgentSelector from './AgentSelector';

const fromPlugin: SubagentMetadata = {
  name: 'reviewer',
  description: 'Reviews code',
  source: { kind: 'plugin', plugin: 'weather@official' },
};
const mine: SubagentMetadata = { name: 'my-own', description: 'Mine' };

function open(agents: SubagentMetadata[]) {
  render(
    <AgentSelector
      agents={agents}
      selectedName={null}
      onSelect={vi.fn()}
      disabledAgentSet={new Set()}
    />,
  );
  fireEvent.click(screen.getByText(getI18n().chat.pickAgent));
}

describe('AgentSelector — plugin provenance tag', () => {
  it('tags a plugin-contributed agent', () => {
    open([fromPlugin]);
    const tags = screen.getAllByTestId('agent-source-plugin');
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe(getI18n().chat.pickAgentPluginTag);
  });

  it('leaves a user-authored agent untagged', () => {
    open([mine]);
    expect(screen.queryByTestId('agent-source-plugin')).toBeNull();
  });

  it('tags only the plugin rows when both kinds are listed', () => {
    open([fromPlugin, mine]);
    expect(screen.getAllByTestId('agent-source-plugin')).toHaveLength(1);
  });
});
