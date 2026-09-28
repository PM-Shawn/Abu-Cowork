import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../../../types';
import {
  adaptComputerToolForTier,
  COMPUTER_EVIDENCE_RULE,
  COMPUTER_SAFETY_RULES,
  COMPUTER_TARGETING_RULES,
  structuredComputerDescription,
} from './computerToolText';

// 截图与坐标类参数的说明都提到截图，其余参数的说明与截图无关（与真实工具一致）
const SCREENSHOT_BOUND_KEYS = new Set([
  'screenshot_id', 'x', 'y', 'startX', 'startY', 'endX', 'endY', 'path', 'width', 'height', 'show_user',
]);

const computer: ToolDefinition = {
  name: 'computer',
  description: 'full description with screenshot + click(x,y)',
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      ['action', 'app', 'window_ref', 'element_id', 'expected_state_id', 'screenshot_id', 'x', 'y', 'startX', 'startY',
        'endX', 'endY', 'path', 'width', 'height', 'show_user', 'direction', 'amount', 'text', 'consequence']
        .map((key) => [key, {
          type: 'string',
          description: SCREENSHOT_BOUND_KEYS.has(key) ? `${key} relative to the referenced screenshot` : `${key} of the target`,
        }]),
    ),
    required: ['action', 'consequence'],
  },
  execute: async () => 'ok',
};

describe('adaptComputerToolForTier', () => {
  it.each([true, false])('leaves the tool untouched unless the model is on the structured tier (windows=%s)', (windows) => {
    expect(adaptComputerToolForTier(computer, 'full', windows)).toBe(computer);
    expect(adaptComputerToolForTier(computer, undefined, windows)).toBe(computer);
    expect(adaptComputerToolForTier(computer, 'unknown', windows)).toBe(computer);
    expect(adaptComputerToolForTier(computer, 'unsupported', windows)).toBe(computer);
  });

  it('leaves every other tool untouched', () => {
    const other = { ...computer, name: 'read_file' };
    expect(adaptComputerToolForTier(other, 'structured', false)).toBe(other);
    expect(adaptComputerToolForTier(other, 'structured', true)).toBe(other);
  });

  it('gives a model that cannot see images no screenshot or coordinate entry on macOS', () => {
    const adapted = adaptComputerToolForTier(computer, 'structured', false);
    expect(Object.keys(adapted.inputSchema.properties).sort())
      .toEqual(['action', 'amount', 'app', 'consequence', 'direction', 'element_id', 'expected_state_id', 'text', 'window_ref']);
    expect(adapted.inputSchema.required).toEqual(['action', 'consequence']);
    expect(adapted.inputSchema.properties.action.description)
      .toBe('Action: list_windows, get_window_state, get_app_state, activate_app, launch_app, click, type, perform_action, scroll, key, wait');
    expect(adapted.description).toBe(structuredComputerDescription(false));
    expect(adapted.description).toContain('• scroll ');
    expect(JSON.stringify(adapted).toLowerCase()).not.toContain('screenshot');
  });

  // Windows 上滚动走坐标通道，要求截图编号；看不了图时没有截图，所以不列 scroll
  it('offers no scroll on Windows and scrolls through focus + key instead', () => {
    const adapted = adaptComputerToolForTier(computer, 'structured', true);
    expect(Object.keys(adapted.inputSchema.properties).sort())
      .toEqual(['action', 'app', 'consequence', 'element_id', 'expected_state_id', 'text', 'window_ref']);
    expect(adapted.inputSchema.properties.action.description)
      .toBe('Action: list_windows, get_window_state, get_app_state, activate_app, launch_app, click, type, perform_action, key, wait');
    expect(adapted.description).toBe(structuredComputerDescription(true));
    expect(adapted.description).not.toContain('• scroll ');
    expect(adapted.description).toContain('click the target element by element_id so it has focus, then use key to send PageDown or ArrowDown');
    expect(adapted.inputSchema.properties.element_id.description).not.toContain('scroll');
    expect(JSON.stringify(adapted).toLowerCase()).not.toContain('screenshot');
  });

  it.each([
    [false, 'Required for click/type/perform_action/scroll/key.'],
    [true, 'Required for click/type/perform_action/key.'],
  ])('lists only offered write actions for expected_state_id (windows=%s)', (windows, prefix) => {
    const description = adaptComputerToolForTier(computer, 'structured', windows)
      .inputSchema.properties.expected_state_id.description as string;
    expect(description.startsWith(prefix)).toBe(true);
    expect(description).not.toContain('drag');
  });

  it.each([true, false])('tells the model to stop and explain when the window text is not enough (windows=%s)', (windows) => {
    expect(structuredComputerDescription(windows)).toContain('cannot be seen by the current model');
  });

  it.each([true, false])('shares the evidence, targeting and safety rules with the full description (windows=%s)', (windows) => {
    const description = structuredComputerDescription(windows);
    expect(description).toContain(COMPUTER_EVIDENCE_RULE);
    expect(description).toContain(COMPUTER_TARGETING_RULES);
    expect(description).toContain(COMPUTER_SAFETY_RULES);
  });
});
