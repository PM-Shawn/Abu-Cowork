import { describe, expect, it } from 'vitest';
import { classifySelfExtension } from './selfExtensionPolicy';

describe('classifySelfExtension', () => {
  it.each([
    ['manage_trigger', 'create'],
    ['manage_trigger', 'update'],
    ['manage_trigger', 'delete'],
    ['manage_trigger', 'pause'],
    ['manage_trigger', 'resume'],
    ['manage_scheduled_task', 'create'],
    ['manage_scheduled_task', 'update'],
    ['manage_scheduled_task', 'delete'],
    ['manage_scheduled_task', 'pause'],
    ['manage_scheduled_task', 'resume'],
    ['manage_file_watch', 'add'],
    ['manage_file_watch', 'remove'],
    ['manage_file_watch', 'toggle'],
  ])('classifies %s(%s) as a durable self-extension', (name, action) => {
    expect(classifySelfExtension(name, { action })).toEqual({ summary: `${name} (${action})` });
  });

  it.each(['manage_trigger', 'manage_scheduled_task', 'manage_file_watch'])(
    'leaves the read-only %s(list) action outside the self-extension gate',
    (name) => {
      expect(classifySelfExtension(name, { action: 'list' })).toBeNull();
    },
  );

  it.each(['manage_trigger', 'manage_scheduled_task', 'manage_file_watch'])(
    'fails closed for an unknown %s action',
    (name) => {
      expect(classifySelfExtension(name, { action: 'future_mutation' })).toEqual({
        summary: `${name} (future_mutation)`,
      });
    },
  );

  it.each(['manage_trigger', 'manage_scheduled_task', 'manage_file_watch'])(
    'fails closed when %s omits its action',
    (name) => {
      expect(classifySelfExtension(name, {})).toEqual({ summary: name });
    },
  );
});
