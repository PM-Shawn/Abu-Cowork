'use strict';

// Typed IPC oversize error (#549). Electron IPC forwards only `message`, so
// the fields travel inside it. The renderer parser lives in
// src/core/ipc/payloadTooLarge.ts; preload.cjs (sandboxed, cannot require
// this file) inlines the same format. payloadTooLarge.contract.test.ts and
// ipcRawBody.test.cjs pin all three together. The message carries sizes and
// the command name only — never payload content.
const PAYLOAD_TOO_LARGE_CODE = 'payload_too_large';

function payloadTooLargeMessage({ bytes, limit, method }) {
  return `${PAYLOAD_TOO_LARGE_CODE} ${JSON.stringify({ code: PAYLOAD_TOO_LARGE_CODE, bytes, limit, method })}`;
}

function createPayloadTooLargeError(fields) {
  const err = new Error(payloadTooLargeMessage(fields));
  err.code = PAYLOAD_TOO_LARGE_CODE;
  err.bytes = fields.bytes;
  err.limit = fields.limit;
  err.method = fields.method;
  return err;
}

module.exports = { PAYLOAD_TOO_LARGE_CODE, payloadTooLargeMessage, createPayloadTooLargeError };
