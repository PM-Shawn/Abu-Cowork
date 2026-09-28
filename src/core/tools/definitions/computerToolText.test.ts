import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '../../../types';
import {
  adaptComputerToolForTier,
  COMPUTER_EVIDENCE_RULE,
  COMPUTER_SAFETY_RULES,
  COMPUTER_TARGETING_RULES,
  STRUCTURED_COMPUTER_DESCRIPTION,
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
      ['action', 'app', 'window_ref', 'element_id', 'screenshot_id', 'x', 'y', 'startX', 'startY', 'endX', 'endY',
        'path', 'width', 'height', 'show_user', 'text', 'consequence']
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
  it('leaves the tool untouched for a model that can see images', () => {
    expect(adaptComputerToolForTier(computer, 'full')).toBe(computer);
    expect(adaptComputerToolForTier(computer, undefined)).toBe(computer);
  });

  it('leaves every other tool untouched', () => {
    const other = { ...computer, name: 'read_file' };
    expect(adaptComputerToolForTier(other, 'structured')).toBe(other);
  });

  it('gives a model that cannot see images no screenshot or coordinate entry', () => {
    const adapted = adaptComputerToolForTier(computer, 'structured');
    expect(Object.keys(adapted.inputSchema.properties).sort())
      .toEqual(['action', 'app', 'consequence', 'element_id', 'text', 'window_ref']);
    expect(adapted.inputSchema.required).toEqual(['action', 'consequence']);
    expect(adapted.inputSchema.properties.action.description)
      .toBe('Action: list_windows, get_window_state, get_app_state, activate_app, launch_app, click, type, perform_action, scroll, key, wait');
    expect(adapted.description).toBe(STRUCTURED_COMPUTER_DESCRIPTION);
    expect(JSON.stringify(adapted).toLowerCase()).not.toContain('screenshot');
  });

  it('tells the model to stop and explain when the window text is not enough', () => {
    expect(STRUCTURED_COMPUTER_DESCRIPTION).toContain('cannot be seen by the current model');
  });

  it('shares the evidence, targeting and safety rules with the full description', () => {
    expect(STRUCTURED_COMPUTER_DESCRIPTION).toContain(COMPUTER_EVIDENCE_RULE);
    expect(STRUCTURED_COMPUTER_DESCRIPTION).toContain(COMPUTER_TARGETING_RULES);
    expect(STRUCTURED_COMPUTER_DESCRIPTION).toContain(COMPUTER_SAFETY_RULES);
  });
});
