'use strict';

const { randomBytes, createHash } = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const parseRange = require('range-parser');
const { createNativeFileSession } = require('./nativeHelperManager.cjs');
const { assertAllowed } = require('./fsHost.cjs');
const { wireRendererResourceCleanup } = require('./rendererLifecycle.cjs');

const MEDIA_SCHEME = 'abu-media';
const MEDIA_CHUNK_BYTES = 1024 * 1024;
const MEDIA_LEASE_MS = 15 * 60 * 1000;

function tokenFromUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'file'
    || url.search || url.hash || !/^\/[a-f0-9]{64}$/.test(url.pathname)) return null;
  return url.pathname.slice(1);
}

/** This service accepts host-resolved file identities; URL paths never contain file paths. */
function createMediaProtocol({ resolveFile, assertConversation, now = Date.now }) {
  const grants = new Map();
  const documents = new WeakMap();

  function documentOf(sender) {
    const existing = documents.get(sender);
    if (existing) return existing;
    const document = { generation: 0 };
    documents.set(sender, document);
    const clear = () => {
      document.generation += 1;
      for (const grant of grants.values()) if (grant.sender === sender) revoke(grant);
    };
    const removeNavigation = wireRendererResourceCleanup(sender, clear);
    sender.on('render-process-gone', clear);
    sender.once('destroyed', () => {
      clear();
      removeNavigation();
      sender.removeListener('render-process-gone', clear);
    });
    return document;
  }

  function current(grant) {
    if (grants.get(grant.token) !== grant || grant.sender.isDestroyed()) throw new Error('Media access is unavailable');
    if (now() >= grant.expiresAt) { revoke(grant); throw new Error('Media access expired'); }
    assertConversation(grant.conversationId);
    assertAllowed(grant.file.path, { followFinalSymlink: true });
  }

  async function openSource(file) {
    assertAllowed(file.path, { followFinalSymlink: true });
    const target = { path: file.path, purpose: 'read', followFinalSymlink: true };
    const native = createNativeFileSession([target]);
    let opened = false;
    try {
      const observed = await native.request('observe', target);
      if (!observed.isFile) throw new Error('Media source is not a file');
      assertAllowed(observed.canonicalPath, { followFinalSymlink: true });
      if (file.allowedRoot) {
        const relative = path.relative(file.allowedRoot, observed.canonicalPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Media source left its conversation');
      }
      const info = await native.request('media-info', { reference: observed.reference });
      if (!Number.isSafeInteger(info.size) || info.size <= 0 || typeof info.modifiedNs !== 'string') {
        throw new Error('Media source metadata is invalid');
      }
      opened = true;
      return { native, observed, info };
    } finally {
      if (!opened) await native.release();
    }
  }

  function revoke(grant) {
    grants.delete(grant.token);
    clearTimeout(grant.expiryTimer);
    for (const abort of grant.requests) abort.abort();
  }

  function renew(grant) {
    clearTimeout(grant.expiryTimer);
    grant.expiresAt = now() + MEDIA_LEASE_MS;
    grant.expiryTimer = setTimeout(() => revoke(grant), MEDIA_LEASE_MS);
    grant.expiryTimer.unref();
  }

  return {
    async grant(sender, conversationId, fileReference) {
      const document = documentOf(sender);
      const generation = document.generation;
      const assertDocument = () => {
        if (sender.isDestroyed() || document.generation !== generation) throw new Error('Media window is unavailable');
      };
      assertDocument();
      assertConversation(conversationId);
      const file = await resolveFile(conversationId, fileReference);
      assertDocument();
      if (!file || !/^(image|video)\/[a-z0-9.+-]+$/.test(file.mimeType)) throw new Error('Unsupported media file');
      const source = await openSource(file);
      try {
        if (file.contentDigest) {
          const hash = createHash('sha256');
          for (let offset = 0; offset < source.info.size; offset += MEDIA_CHUNK_BYTES) {
            const chunk = await source.native.request('read-media-range', {
              reference: source.observed.reference, offset, length: Math.min(MEDIA_CHUNK_BYTES, source.info.size - offset),
              expectedSize: source.info.size, expectedModifiedNs: source.info.modifiedNs,
            });
            hash.update(Buffer.from(chunk.base64, 'base64'));
          }
          if (hash.digest('hex') !== file.contentDigest) throw new Error('Media content changed');
        }
        assertConversation(conversationId);
        assertDocument();
        const token = randomBytes(32).toString('hex');
        const grant = { token, sender, conversationId, file, info: source.info, identity: source.observed.identity, requests: new Set() };
        renew(grant);
        grants.set(token, grant);
        return { token, url: `${MEDIA_SCHEME}://file/${token}`, byteLength: source.info.size, mimeType: file.mimeType };
      } finally {
        await source.native.release();
      }
    },

    permits(details) {
      const token = tokenFromUrl(details.url);
      const grant = token && grants.get(token);
      if (!grant || grant.sender.isDestroyed() || details.webContentsId !== grant.sender.id) return false;
      if (now() >= grant.expiresAt) { revoke(grant); return false; }
      return details.frame === grant.sender.mainFrame;
    },

    release(sender, token) {
      const grant = grants.get(token);
      if (!grant) return;
      if (grant.sender !== sender) throw new Error('Media access is unavailable');
      revoke(grant);
    },

    renew(sender, token) {
      const grant = grants.get(token);
      if (!grant || grant.sender !== sender) throw new Error('Media access is unavailable');
      current(grant);
      renew(grant);
    },

    revokeConversation(conversationId) {
      for (const grant of grants.values()) if (grant.conversationId === conversationId) revoke(grant);
    },

    async handle(request) {
      const token = tokenFromUrl(request.url);
      const grant = token && grants.get(token);
      if (!grant) return new Response(null, { status: 404 });
      current(grant);
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
      const size = grant.info.size;
      const headers = {
        'Content-Type': grant.file.mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      };
      const rangeHeader = request.headers.get('range');
      const ranges = rangeHeader ? parseRange(size, rangeHeader) : null;
      if (ranges && (typeof ranges === 'number' || ranges.type !== 'bytes' || ranges.length !== 1)) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } });
      }
      const start = ranges ? ranges[0].start : 0;
      const end = ranges ? ranges[0].end : size - 1;
      headers['Content-Length'] = String(end - start + 1);
      if (ranges) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      const status = ranges ? 206 : 200;
      const source = await openSource(grant.file);
      const abort = new AbortController();
      let offset = start;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        grant.requests.delete(abort);
        request.signal.removeEventListener('abort', cancel);
        await source.native.release();
      };
      const cancel = () => abort.abort();
      request.signal.addEventListener('abort', cancel, { once: true });
      grant.requests.add(abort);
      let initialized = false;
      try {
        current(grant);
        if (!isDeepStrictEqual(source.observed.identity, grant.identity) || !isDeepStrictEqual(source.info, grant.info)) {
          throw new Error('Media source changed; reload the file');
        }
        if (request.method === 'HEAD') return new Response(null, { status, headers });
        if (request.signal.aborted) abort.abort();
        const stream = new ReadableStream({
          async pull(controller) {
            let completed = false;
            try {
              if (abort.signal.aborted) { controller.close(); return; }
              current(grant);
              const length = Math.min(MEDIA_CHUNK_BYTES, end - offset + 1);
              const chunk = await source.native.request('read-media-range', {
                reference: source.observed.reference, offset, length,
                expectedSize: size, expectedModifiedNs: grant.info.modifiedNs,
              });
              current(grant);
              if (abort.signal.aborted) { controller.close(); return; }
              const bytes = Buffer.from(chunk.base64, 'base64');
              if (bytes.length !== length) throw new Error('Media range was incomplete');
              controller.enqueue(bytes);
              offset += bytes.length;
              if (offset > end) controller.close();
              else completed = true;
            } finally {
              if (!completed) await release();
            }
          },
          async cancel() { abort.abort(); await release(); },
        });
        abort.signal.addEventListener('abort', () => { void release(); }, { once: true });
        initialized = true;
        return new Response(stream, { status, headers });
      } finally {
        if (!initialized) await release();
      }
    },
  };
}

module.exports = { MEDIA_SCHEME, MEDIA_CHUNK_BYTES, MEDIA_LEASE_MS, createMediaProtocol };
