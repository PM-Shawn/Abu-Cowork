import { describe, expect, it } from 'vitest';
import {
  IPC_MAX_ARGS_BYTES,
  IPC_MAX_RAW_BODY_BYTES,
  PayloadTooLargeError,
  formatPayloadTooLargeMessage,
  isPayloadTooLargeError,
  parsePayloadTooLargeError,
} from './payloadTooLarge';

describe('payloadTooLarge', () => {
  it('carries typed, non-retryable fields and a parseable message', () => {
    const err = new PayloadTooLargeError(200, 100, 'agent.start');
    expect(err).toMatchObject({ name: 'PayloadTooLargeError', code: 'payload_too_large', retryable: false, bytes: 200, limit: 100, method: 'agent.start' });
    expect(err.message).toBe(formatPayloadTooLargeMessage({ bytes: 200, limit: 100, method: 'agent.start' }));
    expect(IPC_MAX_ARGS_BYTES).toBe(8 * 1024 * 1024);
    expect(IPC_MAX_RAW_BODY_BYTES).toBe(128 * 1024 * 1024);
  });

  it('parses the Electron-wrapped main-process message and relabels the method', () => {
    const wire = `Error invoking remote method 'tauri:invoke': Error: ${formatPayloadTooLargeMessage({ bytes: 9, limit: 8, method: 'mcp_write' })}`;
    const parsed = parsePayloadTooLargeError(new Error(wire), 'llm.chat');
    expect(parsed).toBeInstanceOf(PayloadTooLargeError);
    expect(parsed).toMatchObject({ bytes: 9, limit: 8, method: 'llm.chat' });
    expect(isPayloadTooLargeError(new Error(wire))).toBe(true);
  });

  it('rejects look-alikes and malformed numbers', () => {
    expect(parsePayloadTooLargeError(new Error('IPC args are too large'))).toBeNull();
    expect(parsePayloadTooLargeError(new Error('payload_too_large {"code":"payload_too_large","bytes":"x","limit":1,"method":"m"}'))).toBeNull();
    expect(parsePayloadTooLargeError('payload_too_large {not json}')).toBeNull();
    expect(parsePayloadTooLargeError(undefined)).toBeNull();
  });
});
