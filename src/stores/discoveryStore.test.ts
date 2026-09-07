/**
 * Plugin provenance for discovered agents: `installed.json` is the only
 * authority.
 *
 * An agent installed before the `source:` frontmatter key existed has no
 * provenance on disk — the acceptance fixture `reviewer` is exactly that — and
 * rewriting its AGENT.md to add one would edit a file that now lives in the
 * user's `~/.abu/agents`. So `refresh()` restores the label in memory from
 * `installed.json`'s `contributed.agents`, the same list uninstall trusts —
 * and, by the same rule, strips a `source` no record backs, so nothing that
 * merely writes `source: plugin:x` into an AGENT.md can turn the user's own
 * agent read-only.
 *
 * Deliberately NOT in `core/agent/registry`: the plugin installer already
 * depends on the registry, so teaching the registry about `core/plugin` would
 * close an import cycle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentMetadata } from '../types';
import type { InstalledPlugin } from '../core/plugin/installedStore';

vi.mock('../core/skill/loader', () => ({
  skillLoader: { discoverSkills: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../core/agent/registry', () => ({
  agentRegistry: { discoverAgents: vi.fn() },
}));
vi.mock('../core/plugin/installedStore', () => ({
  readInstalled: vi.fn(),
}));

import { agentRegistry } from '../core/agent/registry';
import { readInstalled } from '../core/plugin/installedStore';
import { useDiscoveryStore, applyPluginAgentSources } from './discoveryStore';

function agent(name: string, extra: Partial<SubagentMetadata> = {}): SubagentMetadata {
  return { name, description: `${name} does things`, ...extra };
}

function record(key: string, agents: string[]): InstalledPlugin {
  return {
    key,
    marketplace: 'official',
    name: key.split('@')[0],
    version: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    contributed: { skills: [], mcpServers: [], agents },
  };
}

describe('applyPluginAgentSources', () => {
  it('labels an agent a plugin record claims', () => {
    const [labelled] = applyPluginAgentSources(
      [agent('reviewer')],
      [record('weather@official', ['reviewer'])],
    );
    expect(labelled.source).toEqual({ kind: 'plugin', plugin: 'weather@official' });
  });

  it('leaves an agent no record claims untouched', () => {
    const mine = agent('my-own');
    const [out] = applyPluginAgentSources([mine], [record('weather@official', ['reviewer'])]);
    expect(out.source).toBeUndefined();
    expect(out).toBe(mine);
  });

  it('strips a source no install record backs', () => {
    // `save_agent` (or a hand edit) can write `source: plugin:anything` into a
    // user's own AGENT.md. Believing it would label the agent 「来自插件」 and
    // lock the user out of their own file behind the read-only gates. Same for
    // an orphan a refused `removeContributedAgent` left behind.
    const [out] = applyPluginAgentSources(
      [agent('my-own', { source: { kind: 'plugin', plugin: 'not-installed@official' } })],
      [record('weather@official', ['reviewer'])],
    );
    expect(out.source).toBeUndefined();
    expect(out.name).toBe('my-own');
  });

  it('strips a stamped source when nothing is installed at all', () => {
    const [out] = applyPluginAgentSources(
      [agent('my-own', { source: { kind: 'plugin', plugin: 'ghost@official' } })],
      [],
    );
    expect(out.source).toBeUndefined();
  });

  it('overwrites a stamped source with the record that actually claims the name', () => {
    // The record is what uninstall reads, so it is what the label must agree
    // with — a stale or forged frontmatter value does not get a vote.
    const [out] = applyPluginAgentSources(
      [agent('reviewer', { source: { kind: 'plugin', plugin: 'stamped@official' } })],
      [record('weather@official', ['reviewer'])],
    );
    expect(out.source).toEqual({ kind: 'plugin', plugin: 'weather@official' });
  });

  it('leaves an already-correct agent object untouched', () => {
    const stamped = agent('reviewer', { source: { kind: 'plugin', plugin: 'weather@official' } });
    const [out] = applyPluginAgentSources([stamped], [record('weather@official', ['reviewer'])]);
    expect(out).toBe(stamped);
  });

  it('does not mutate the objects it was handed', () => {
    const original = agent('reviewer');
    applyPluginAgentSources([original], [record('weather@official', ['reviewer'])]);
    expect(original.source).toBeUndefined();

    const stamped = agent('my-own', { source: { kind: 'plugin', plugin: 'ghost@official' } });
    applyPluginAgentSources([stamped], []);
    expect(stamped.source).toEqual({ kind: 'plugin', plugin: 'ghost@official' });
  });

  it('gives a name two records both claim to the first one', () => {
    const [out] = applyPluginAgentSources(
      [agent('reviewer')],
      [record('a@official', ['reviewer']), record('b@official', ['reviewer'])],
    );
    expect(out.source).toEqual({ kind: 'plugin', plugin: 'a@official' });
  });

  it('tolerates a hand-edited record with no contributed block', () => {
    const broken = { ...record('weather@official', []) } as InstalledPlugin;
    delete (broken as { contributed?: unknown }).contributed;
    expect(() => applyPluginAgentSources([agent('reviewer')], [broken])).not.toThrow();
  });
});

describe('discoveryStore.refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  });

  it('backfills provenance onto the discovered agents', async () => {
    vi.mocked(agentRegistry.discoverAgents).mockResolvedValue([agent('reviewer'), agent('mine')]);
    vi.mocked(readInstalled).mockResolvedValue([record('weather@official', ['reviewer'])]);

    await useDiscoveryStore.getState().refresh(null);

    const { agents } = useDiscoveryStore.getState();
    expect(agents.find((a) => a.name === 'reviewer')?.source).toEqual({
      kind: 'plugin',
      plugin: 'weather@official',
    });
    expect(agents.find((a) => a.name === 'mine')?.source).toBeUndefined();
  });

  it('still publishes the agents when installed.json cannot be read', async () => {
    // The agents are on disk and usable; only the label is lost.
    vi.mocked(agentRegistry.discoverAgents).mockResolvedValue([agent('reviewer')]);
    vi.mocked(readInstalled).mockRejectedValue(new Error('EACCES'));

    await useDiscoveryStore.getState().refresh(null);

    const { agents, isLoading } = useDiscoveryStore.getState();
    expect(agents.map((a) => a.name)).toEqual(['reviewer']);
    expect(agents[0].source).toBeUndefined();
    expect(isLoading).toBe(false);
  });
});
