import { describe, expect, it } from 'vitest';
import {
  createTextOnlyEndTurnNudge,
  TEXT_ONLY_END_TURN_NUDGE_LIMIT,
  textAsksUser,
} from './textOnlyEndTurnNudge';

describe('textAsksUser', () => {
  it('is true when one of the last three lines ends with a question mark', () => {
    expect(textAsksUser('I read the file.\n\nShould the report go to docs/?')).toBe(true);
    expect(textAsksUser('读完了。\n\n报告放到 docs 目录可以吗？')).toBe(true);
  });

  it('ignores markdown and closing punctuation after the question mark', () => {
    expect(textAsksUser('**Which folder?**')).toBe(true);
    expect(textAsksUser('要放在哪个目录？）')).toBe(true);
    expect(textAsksUser('Which folder? \n')).toBe(true);
  });

  it('is false for a question mark buried earlier in the text', () => {
    const text = 'Why does this fail? Because the path is wrong.\nI fixed it.\nNext I will run the tests.\nThen I will write the summary.';
    expect(textAsksUser(text)).toBe(false);
  });

  it('is true for an asking phrase anywhere in the text, in English or Chinese', () => {
    expect(textAsksUser('Done with step one. Let me know if you want the second step.')).toBe(true);
    expect(textAsksUser('Please confirm the target folder before I continue.')).toBe(true);
    expect(textAsksUser('第一步做完了。是否需要我继续做第二步。')).toBe(true);
    expect(textAsksUser('请确认目标目录。')).toBe(true);
  });

  it('is false for plain narration of planned work', () => {
    expect(textAsksUser('I will now edit the file and then run the tests.')).toBe(false);
    expect(textAsksUser('接下来我会修改文件，然后运行测试。')).toBe(false);
    expect(textAsksUser('')).toBe(false);
  });
});

describe('createTextOnlyEndTurnNudge', () => {
  const toolTurn = { enabled: true, stopReason: 'tool_use', toolCalls: [{ name: 'read_file' }], text: '' };
  const textTurn = { enabled: true, stopReason: 'end_turn', toolCalls: [], text: 'Next I will edit the file.' };

  it('nudges a text-only end_turn after a tool turn, at most twice per run', () => {
    const nudge = createTextOnlyEndTurnNudge();
    expect(nudge.observeTurn(toolTurn)).toBe(false);
    expect(nudge.observeTurn(textTurn)).toBe(true);
    expect(nudge.observeTurn(textTurn)).toBe(true);
    expect(nudge.observeTurn(textTurn)).toBe(false);
    expect(nudge.count).toBe(TEXT_ONLY_END_TURN_NUDGE_LIMIT);
  });

  it('does nothing while the guard is off', () => {
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn({ ...textTurn, enabled: false })).toBe(false);
    expect(nudge.count).toBe(0);
  });

  it('leaves a run that never called a tool alone', () => {
    const nudge = createTextOnlyEndTurnNudge();
    expect(nudge.observeTurn(textTurn)).toBe(false);
  });

  it('only acts on end_turn', () => {
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn({ ...textTurn, stopReason: 'max_tokens' })).toBe(false);
  });

  it('skips the turn after a batch that asked the user a question', () => {
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn({ ...toolTurn, toolCalls: [{ name: 'read_file' }, { name: 'ask_user_question' }] });
    expect(nudge.observeTurn(textTurn)).toBe(false);
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn(textTurn)).toBe(true);
  });

  it('skips a turn whose text asks the user something', () => {
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn({ ...textTurn, text: 'Should I also update the README?' })).toBe(false);
    expect(nudge.count).toBe(0);
  });

  it('does not count a tool turn against the limit', () => {
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn(textTurn)).toBe(true);
    nudge.observeTurn(toolTurn);
    expect(nudge.observeTurn(textTurn)).toBe(true);
    expect(nudge.observeTurn(textTurn)).toBe(false);
  });

  it('nudges an empty response (no text, no tool calls) after a tool turn', () => {
    // 网关吞内容场景：token 计了但正文没到。空正文不算提问（textAsksUser('')=false），
    // 应照常续推。
    const nudge = createTextOnlyEndTurnNudge();
    nudge.observeTurn(toolTurn);
    expect(nudge.sawToolCall).toBe(true);
    expect(nudge.observeTurn({ ...textTurn, text: '' })).toBe(true);
    expect(nudge.observeTurn({ ...textTurn, text: '' })).toBe(true);
    expect(nudge.observeTurn({ ...textTurn, text: '' })).toBe(false);
    expect(nudge.count).toBe(TEXT_ONLY_END_TURN_NUDGE_LIMIT);
  });

  it('reports sawToolCall only after a turn that carried a tool call', () => {
    const nudge = createTextOnlyEndTurnNudge();
    expect(nudge.sawToolCall).toBe(false);
    nudge.observeTurn(textTurn);
    expect(nudge.sawToolCall).toBe(false);
    nudge.observeTurn(toolTurn);
    expect(nudge.sawToolCall).toBe(true);
  });
});
