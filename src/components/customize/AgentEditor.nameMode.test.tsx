// @vitest-environment happy-dom
/**
 * An agent name is not a slug. `AGENT_NAME_RE` accepts unicode letters and
 * keeps letter case (`数据分析师`, `QA_bot`) — that is the rule `save_agent`
 * applies when Abu creates an expert, and the built-in experts are named that
 * way too. The editor must not be stricter than the assistant: `useItemName`
 * takes that mode as an option, and when the option is missing it falls back
 * to the skill slug rule, lower-casing what is typed and refusing every
 * non-ASCII name — so a user could not create 财务分析师 by hand at all.
 *
 * Skills keep the slug rule, so the two editors are pinned together here.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/utils/itemStorage', () => ({
  ITEM_EXISTS_CODE: 'ITEM_EXISTS',
  ITEM_NAME_INVALID_CODE: 'ITEM_NAME_INVALID',
  saveItemToAbuDir: vi.fn(async () => undefined),
}));

import { saveItemToAbuDir } from '@/utils/itemStorage';
import { agentRegistry } from '@/core/agent/registry';
import { getI18n } from '@/i18n';
import AgentEditor from './AgentEditor';
import SkillEditor from './SkillEditor';

const agentNameInput = (): HTMLInputElement => screen.getByPlaceholderText('my-agent') as HTMLInputElement;
const agentSaveButton = (): HTMLButtonElement =>
  screen.getByText(getI18n().toolbox.agentSave).closest('button')! as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(agentRegistry, 'getAvailableAgents').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentEditor — an agent name keeps unicode and letter case', () => {
  // 财务分析师, not the built-in 数据分析师: a built-in's name is taken, and
  // that refusal is the collision guard doing its job, not the name rule.
  it.each(['财务分析师', 'QA_bot', 'Reviewer'])('keeps %j exactly as typed, and saves under it', async (typed) => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(agentNameInput(), { target: { value: typed } });

    expect(agentNameInput().value).toBe(typed);
    expect(agentSaveButton().disabled).toBe(false);
    fireEvent.click(agentSaveButton());

    await waitFor(() => expect(vi.mocked(saveItemToAbuDir)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveItemToAbuDir).mock.calls[0][2]).toBe(typed);
  });

  it('still folds whitespace to a dash — the composer mention parser cannot span a space', () => {
    render(<AgentEditor agent={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    fireEvent.change(agentNameInput(), { target: { value: 'QA bot' } });

    expect(agentNameInput().value).toBe('QA-bot');
  });
});

describe('SkillEditor — a skill name is still a lowercase slug', () => {
  it('lower-cases what is typed', () => {
    render(<SkillEditor skill={null} onClose={vi.fn()} onSave={vi.fn(async () => undefined)} />);
    const input = screen.getByPlaceholderText('my-skill') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Weekly-Report' } });

    expect(input.value).toBe('weekly-report');
  });
});
