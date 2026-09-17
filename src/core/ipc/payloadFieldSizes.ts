/**
 * #549 step 0 — numbers-only byte breakdown of a shell→sidecar RPC payload.
 * Never returns or logs content; every value is a byte count. Keys match the
 * runtime-trace allowlists (runtimeTrace.ts / electron/runtimeObservability.cjs).
 */
export const FIELD_BREAKDOWN_MIN_BYTES = 1024 * 1024;
export const MEASURED_RPC_METHODS: ReadonlySet<string> = new Set([
  'agent.start',
  'agent.run',
  'llm.chat',
  'subagent.run',
]);

export interface PayloadFieldBytes {
  fieldMessagesTextBytes: number;
  fieldToolResultsBytes: number;
  fieldToolContextResultsBytes: number;
  fieldMediaBase64Bytes: number;
  fieldToolListBytes: number;
  fieldSystemPromptBytes: number;
  fieldSettingsBytes: number;
}

const MAX_WALK_DEPTH = 12;

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8ByteLength(json);
  } catch {
    return 0;
  }
}

function textBytes(content: unknown): number {
  if (typeof content === 'string') return utf8ByteLength(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      total += utf8ByteLength(block.text);
    }
  }
  return total;
}

function toolResultBytes(calls: unknown): number {
  if (!Array.isArray(calls)) return 0;
  let total = 0;
  for (const call of calls) {
    if (!isRecord(call)) continue;
    if (typeof call.result === 'string') total += utf8ByteLength(call.result);
    if (call.resultContent !== undefined) total += textBytes(call.resultContent);
  }
  return total;
}

function base64Bytes(value: unknown, depth = 0): number {
  if (depth > MAX_WALK_DEPTH) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += base64Bytes(item, depth + 1);
    return total;
  }
  if (!isRecord(value)) return 0;
  let total = 0;
  // base64 is ASCII, so string length equals its UTF-8 byte count.
  if (isRecord(value.source) && typeof value.source.data === 'string') total += value.source.data.length;
  if (typeof value.base64 === 'string') total += value.base64.length;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'source' || key === 'base64') continue;
    if (typeof child === 'object' && child !== null) total += base64Bytes(child, depth + 1);
  }
  return total;
}

function messagesOf(params: Record<string, unknown>): unknown[] {
  const snapshot = params.conversationSnapshot;
  if (isRecord(snapshot) && Array.isArray(snapshot.messages)) return snapshot.messages;
  return Array.isArray(params.messages) ? params.messages : [];
}

export function measurePayloadFields(params: unknown): PayloadFieldBytes {
  const out: PayloadFieldBytes = {
    fieldMessagesTextBytes: 0,
    fieldToolResultsBytes: 0,
    fieldToolContextResultsBytes: 0,
    fieldMediaBase64Bytes: 0,
    fieldToolListBytes: 0,
    fieldSystemPromptBytes: 0,
    fieldSettingsBytes: 0,
  };
  if (!isRecord(params)) return out;
  for (const message of messagesOf(params)) {
    if (!isRecord(message)) continue;
    out.fieldMessagesTextBytes += textBytes(message.content);
    out.fieldToolResultsBytes += toolResultBytes(message.toolCalls);
    out.fieldToolContextResultsBytes += toolResultBytes(message.toolCallsForContext);
  }
  for (const key of ['task', 'context', 'parentConversationSummary'] as const) {
    const value = params[key];
    if (typeof value === 'string') out.fieldMessagesTextBytes += utf8ByteLength(value);
  }
  out.fieldMediaBase64Bytes = base64Bytes(params);
  const options = isRecord(params.options) ? params.options : undefined;
  out.fieldToolListBytes = jsonBytes(params.toolList ?? params.tools ?? options?.tools);
  const orchestration = isRecord(params.orchestration) ? params.orchestration : undefined;
  out.fieldSystemPromptBytes = jsonBytes(orchestration?.systemPromptSections ?? options?.systemPrompt);
  out.fieldSettingsBytes = jsonBytes(params.settingsSnapshot);
  return out;
}
