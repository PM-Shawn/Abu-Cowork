import { afterEach, describe, expect, it } from 'vitest';
import { __resetTaskGrantsForTests, grantTask, hasTaskGrant, TASK_GRANT_TTL_MS } from './taskGrants';

const T0 = 1_700_000_000_000;

describe('taskGrants', () => {
  afterEach(() => {
    __resetTaskGrantsForTests();
  });

  it('remembers an approval for the task that gave it', () => {
    expect(hasTaskGrant('government-site', 'conv-1', 'https://www.gsxt.gov.cn', T0)).toBe(false);
    grantTask('government-site', 'conv-1', 'https://www.gsxt.gov.cn', T0);
    expect(hasTaskGrant('government-site', 'conv-1', 'https://www.gsxt.gov.cn', T0 + 1)).toBe(true);
  });

  it('never reaches another task, another subject or another kind', () => {
    grantTask('connector-tool', 'conv-1', 'mail__send_email', T0);
    expect(hasTaskGrant('connector-tool', 'conv-2', 'mail__send_email', T0)).toBe(false);
    expect(hasTaskGrant('connector-tool', 'conv-1', 'mail__send_reply', T0)).toBe(false);
    expect(hasTaskGrant('government-site', 'conv-1', 'mail__send_email', T0)).toBe(false);
  });

  it('ends after the half hour a task grant lasts', () => {
    grantTask('government-site', 'conv-1', 'https://www.ccgp.gov.cn', T0);
    expect(hasTaskGrant('government-site', 'conv-1', 'https://www.ccgp.gov.cn', T0 + TASK_GRANT_TTL_MS - 1)).toBe(true);
    expect(hasTaskGrant('government-site', 'conv-1', 'https://www.ccgp.gov.cn', T0 + TASK_GRANT_TTL_MS)).toBe(false);
    // Expired entries are dropped, not revived by an earlier clock.
    expect(hasTaskGrant('government-site', 'conv-1', 'https://www.ccgp.gov.cn', T0)).toBe(false);
  });

  it('starts the half hour again when approved again', () => {
    grantTask('connector-tool', 'conv-1', 'im__send_message', T0);
    grantTask('connector-tool', 'conv-1', 'im__send_message', T0 + TASK_GRANT_TTL_MS - 10);
    expect(hasTaskGrant('connector-tool', 'conv-1', 'im__send_message', T0 + TASK_GRANT_TTL_MS + 10)).toBe(true);
  });

  it('grants nothing without a conversation or a subject', () => {
    grantTask('government-site', undefined, 'https://www.gsxt.gov.cn', T0);
    grantTask('government-site', 'conv-1', '', T0);
    expect(hasTaskGrant('government-site', undefined, 'https://www.gsxt.gov.cn', T0)).toBe(false);
    expect(hasTaskGrant('government-site', 'conv-1', '', T0)).toBe(false);
  });

  it('does not let one key spell another through the separator', () => {
    grantTask('connector-tool', 'a', 'b\x00c', T0);
    expect(hasTaskGrant('connector-tool', 'a\x00b', 'c', T0)).toBe(false);
  });
});
