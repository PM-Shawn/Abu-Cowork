/**
 * entryOrchestration.ts — the shell-side precompute seam.
 *
 * The `@agent` delegation route reaches `runSubagentLoop` in BOTH venues (a
 * renderer-run main loop dispatches through `subagentRunner.ts`; a sidecar-run
 * main loop calls the sidecar's own `runSubagent` shim directly), and only the
 * shell has a populated skill loader. So the delegate agent's preloaded-skills
 * section has to be resolved here, on the route, or `skills:` silently no-ops
 * for the sidecar venue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RouteResult } from './orchestrator';

const routeInputMock = vi.fn();
const buildSystemPromptSectionsMock = vi.fn().mockResolvedValue([]);
vi.mock('./orchestrator', () => ({
  routeInput: (...a: unknown[]) => routeInputMock(...a),
  buildSystemPromptSections: (...a: unknown[]) => buildSystemPromptSectionsMock(...a),
}));

const refreshSkillMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../skill/loader', () => ({
  skillLoader: { refreshSkill: (...a: unknown[]) => refreshSkillMock(...a) },
}));

const resolvePreloadedSkillsMock = vi.fn().mockResolvedValue(null);
vi.mock('./prompts/preloadedSkills', () => ({
  resolvePreloadedSkills: (...a: unknown[]) => resolvePreloadedSkillsMock(...a),
}));

const resolveEntryModelMock = vi.fn(() => ({
  effectiveModelId: 'm1',
  provider: undefined as unknown,
  entryModelDeclared: { supportsTools: true } as Record<string, unknown>,
}));
vi.mock('./resolveEntryModel', () => ({
  resolveEntryModel: () => resolveEntryModelMock(),
}));

vi.mock('./prompts/capabilityPrompt', () => ({
  getCapabilityPrompt: () => 'capability prompt',
}));

import { precomputeOrchestration } from './entryOrchestration';

const PRELOADED_SECTION = {
  text: '## Preloaded Skills\nguidance\n\n### weekly-report\nA report skill\n\nbody',
  resolved: ['weekly-report'],
  missing: [],
  truncated: [],
};

const settingsForModel = { activeModel: 'm1' } as never;

function delegateRoute(skills?: string[]): RouteResult {
  return {
    type: 'delegate',
    name: 'reporter',
    delegateAgent: {
      name: 'reporter',
      description: 'd',
      systemPrompt: 'sys',
      filePath: '/a/AGENT.md',
      skills,
    },
    cleanInput: 'do it',
  };
}

describe('precomputeOrchestration', () => {
  beforeEach(() => {
    routeInputMock.mockReset();
    resolvePreloadedSkillsMock.mockReset();
    resolvePreloadedSkillsMock.mockResolvedValue(null);
    buildSystemPromptSectionsMock.mockClear();
  });

  it('resolves the delegate agent\'s declared skills onto the route', async () => {
    routeInputMock.mockReturnValue(delegateRoute(['weekly-report']));
    resolvePreloadedSkillsMock.mockResolvedValue(PRELOADED_SECTION);

    const { route } = await precomputeOrchestration(
      'conv-1', '@reporter do it', undefined, { settingsForModel },
    );

    expect(resolvePreloadedSkillsMock).toHaveBeenCalledTimes(1);
    expect(route.delegatePreloadedSkills).toEqual(PRELOADED_SECTION);
  });

  it('leaves the route untouched for a delegate agent without skills', async () => {
    routeInputMock.mockReturnValue(delegateRoute());

    const { route } = await precomputeOrchestration(
      'conv-1', '@reporter do it', undefined, { settingsForModel },
    );

    expect(route.delegatePreloadedSkills).toBeUndefined();
  });

  it('does not resolve anything for a non-delegate route', async () => {
    routeInputMock.mockReturnValue({ type: 'general', name: 'abu', cleanInput: 'hi' });

    await precomputeOrchestration('conv-1', 'hi', undefined, { settingsForModel });

    expect(resolvePreloadedSkillsMock).not.toHaveBeenCalled();
  });

  it('builds the system prompt for the tier the entry model will run at', async () => {
    routeInputMock.mockReturnValue({ type: 'general', cleanInput: 'hi' });
    resolveEntryModelMock.mockReturnValueOnce({
      effectiveModelId: 'deepseek-chat',
      provider: { id: 'p', source: 'custom' },
      entryModelDeclared: { supportsTools: true, supportsImages: false },
    });

    await precomputeOrchestration('conv-1', 'hi', undefined, { settingsForModel });

    expect(buildSystemPromptSectionsMock.mock.calls.at(-1)?.[5]).toMatchObject({ computerUseTier: 'structured' });
  });
});
