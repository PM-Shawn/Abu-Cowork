import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactFailureText } from '@/core/diagnostic/scrub';
import { reportAppFailure } from './appFailure';

describe('reportAppFailure', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes the reason to the console with secrets taken out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reason = 'GET https://git.example.test/market.git?token=abc123secret failed';
    reportAppFailure('add market', new Error(reason));
    expect(redactFailureText(reason)).not.toContain('abc123secret');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[app] add market failed:', redactFailureText(reason));
  });

  it('takes a reason that is no Error as text', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reportAppFailure('page load', 'net::ERR_NAME_NOT_RESOLVED');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[app] page load failed:', 'net::ERR_NAME_NOT_RESOLVED');
  });
});
