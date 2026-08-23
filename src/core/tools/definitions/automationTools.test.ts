// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@/i18n';
import { useTriggerStore } from '@/stores/triggerStore';
import type { TriggerAction } from '@/types/trigger';
import { manageTriggerTool } from './automationTools';

function resetTriggerStore() {
  useTriggerStore.setState({
    triggers: {},
    selectedTriggerId: null,
    showEditor: false,
    editingTriggerId: null,
    editorTemplateDefaults: null,
  });
}

describe('manageTriggerTool', () => {
  beforeEach(() => {
    setLanguage('en-US');
    resetTriggerStore();
  });

  it('does not expose capability in the tool schema', () => {
    expect(manageTriggerTool.inputSchema.properties).not.toHaveProperty('capability');
  });

  it('ignores malicious capability on create and tells the user to set it in Trigger Settings', async () => {
    const result = await manageTriggerTool.execute({
      action: 'create',
      name: 'Malicious trigger',
      prompt: 'Handle $EVENT_DATA',
      capability: 'full',
    });

    const created = Object.values(useTriggerStore.getState().triggers)[0];

    expect(created.action.capability).toBeUndefined();
    expect(created.action.permissions).toBeUndefined();
    expect(String(result)).toContain('Capability level is set by the user in Trigger Settings.');
  });

  it('ignores malicious capability on update while preserving existing capability and permissions', async () => {
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'Existing trigger',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: {
        prompt: 'Before',
        capability: 'custom',
        permissions: {
          allowedCommands: ['npm run test'],
          allowedPaths: ['/Users/example/project'],
          allowedTools: ['read_file'],
        },
      },
      debounce: { enabled: true, windowSeconds: 300 },
    });

    const result = await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      prompt: 'After',
      capability: 'full',
    });

    const updated = useTriggerStore.getState().triggers[triggerId];

    expect(updated.action.prompt).toBe('After');
    expect(updated.action.capability).toBe('custom');
    expect(updated.action.permissions).toEqual({
      allowedCommands: ['npm run test'],
      allowedPaths: ['/Users/example/project'],
      allowedTools: ['read_file'],
    });
    expect(String(result)).toContain('Capability level is set by the user in Trigger Settings.');
  });

  it('does not mutate action when update only receives capability', async () => {
    const originalAction: TriggerAction = {
      prompt: 'Keep me',
      skillName: 'alert-sop',
      workspacePath: '/Users/example/project',
      capability: 'safe_tools',
      permissions: {
        allowedPaths: ['/Users/example/project'],
      },
    };
    const triggerId = useTriggerStore.getState().createTrigger({
      name: 'Existing trigger',
      source: { type: 'http' },
      filter: { type: 'always' },
      action: originalAction,
      debounce: { enabled: true, windowSeconds: 300 },
    });

    const result = await manageTriggerTool.execute({
      action: 'update',
      trigger_id: triggerId,
      capability: 'full',
    });

    expect(useTriggerStore.getState().triggers[triggerId].action).toEqual(originalAction);
    expect(String(result)).toContain('Capability level is set by the user in Trigger Settings.');
  });
});
