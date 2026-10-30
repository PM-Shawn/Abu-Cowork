'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const sharp = require('sharp');
const { createMediaJobHost } = require('./mediaJobHost.cjs');
const { imageEditCapabilities, imageEditRequestSchema, imageEditSubmissionSchema, imageLayerSvg } = require('./generated/mediaRuntime.cjs');
const { MAX_SOURCE_PIXELS, MAX_SOURCE_BYTES } = require('./mediaCaptureStore.cjs');
const { writeImageAtomically } = require('./imageSaveHost.cjs');
const MAX_RESPONSE_BYTES = 70 * 1024 * 1024;
const MAX_EDIT_DATA_BYTES = 4 * 1024 * 1024;

function editPrompt(request, hasReference) {
  return [request.prompt,
    ...request.comments.flatMap((comment, index) => comment.text.trim()
      ? [`Comment ${index + 1} at (${comment.point.x}, ${comment.point.y}) in normalized source coordinates: ${comment.text}`] : []),
    'Apply the requested edit to the first image. Annotation marks only describe edit instructions; exclude them from the finished image.',
    ...(hasReference ? ['The second image is an annotated reference of the first image. Use it to understand the requested changes.'] : []),
  ].join('\n');
}

async function readImageResponse(response) {
  if (!response.body) throw new Error('Image service returned an empty response');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Image response exceeds the supported size');
      parts.push(item.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function createImageEditHost({ root, scope, captures, assertConversation, assertCapacity, onChange }) {
  const jobs = createMediaJobHost({ root: path.join(root, 'jobs'), scope, assertConversation, onChange, hasSavedResponse });
  const backends = new Map();
  const preparing = new Map();
  const requestKey = request => `${request.conversationId}\0${request.id}`;
  const resultDirectory = request => path.join(root, 'results', createHash('sha256').update(request.conversationId).digest('hex'), createHash('sha256').update(request.id).digest('hex'));
  function hasSavedResponse(request) {
    const directory = resultDirectory(request);
    const filePath = path.join(directory, 'received.json');
    if (!fs.existsSync(filePath)) return false;
    if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Image result directory changed');
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.size > MAX_RESPONSE_BYTES) throw new Error('Saved image response is invalid');
    return true;
  }
  function resultFolder(request) {
    assertConversation(request.conversationId);
    const directory = resultDirectory(request);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Image result directory changed');
    return directory;
  }

  async function saveResult(request, json, reservation) {
    assertConversation(request.conversationId);
    if (!Array.isArray(json.data) || json.data.length !== 1 || typeof json.data[0].b64_json !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(json.data[0].b64_json)) throw new Error('Image service returned no valid image');
    const { data, info } = await sharp(Buffer.from(json.data[0].b64_json, 'base64'), { limitInputPixels: MAX_SOURCE_PIXELS }).autoOrient().png().toBuffer({ resolveWithObject: true });
    assertConversation(request.conversationId);
    if (data.length > MAX_SOURCE_BYTES) throw new Error('Image result exceeds the supported size');
    if (reservation) reservation.consume(data.length);
    else assertCapacity?.(request.conversationId, data.length);
    const directory = resultFolder(request);
    const filePath = path.join(directory, 'image.png');
    writeImageAtomically(filePath, data);
    return [{
      schemaVersion: 1, id: `image-result:${request.id}`, conversationId: request.conversationId,
      messageId: `image-result:${request.id}`, kind: 'image', mimeType: 'image/png',
      fileRef: { originalPath: filePath, contentDigest: createHash('sha256').update(data).digest('hex') },
      byteLength: data.length, width: info.width, height: info.height,
      groupId: request.id, order: 0, parentArtifactId: request.sourceArtifactId, editRequestId: request.id,
    }];
  }

  async function execute(request, progress) {
    const backend = backends.get(requestKey(request));
    if (!backend) throw new Error('Image service must be selected again');
    const capability = imageEditCapabilities(backend);
    if (!capability.whole || capability.profileVersion !== request.capabilityVersion) throw new Error('Image editing is unavailable for this service');
    const attachments = [];
    for (const attachment of request.attachmentRefs) {
      const read = await captures.read(request.conversationId, attachment.fileRef);
      if (read.bytes.length > capability.maxBytes) throw new Error('Image attachment exceeds the service limit');
      attachments.push({ kind: attachment.kind, image_url: `data:image/png;base64,${read.bytes.toString('base64')}` });
    }
    const source = attachments.find(item => item.kind === 'source');
    const reference = attachments.find(item => item.kind === 'reference');
    const mask = attachments.find(item => item.kind === 'mask');
    const markup = attachments.find(item => item.kind === 'markup');
    const prompt = editPrompt(request, Boolean(reference));
    if (prompt.length > 32000) throw new Error('Image instructions exceed the service limit');
    assertConversation(request.conversationId);
    const seedream = backend.vendor === 'volcengine';
    const body = seedream ? {
      model: backend.model, prompt, image: [source, ...(reference ? [reference] : [])].map(item => item.image_url),
      output_format: 'png', response_format: 'b64_json', size: '2K',
      ...(backend.model.includes('-lite') ? { sequential_image_generation: 'disabled' } : {}),
    } : {
      model: backend.model, prompt, images: [source, ...(reference ? [reference] : [])].map(item => ({ image_url: item.image_url })),
      n: 1, output_format: 'png', size: 'auto',
      ...(mask ? { mask: { image_url: mask.image_url } } : {}),
      ...(markup ? { markup: { image_url: markup.image_url } } : {}),
    };
    const unknown = error => { error.submissionUnknown = true; throw error; };
    const reservation = assertCapacity?.reserve(request.conversationId, MAX_RESPONSE_BYTES + MAX_SOURCE_BYTES);
    try {
    const response = await fetch(seedream ? backend.baseUrl : 'https://api.openai.com/v1/images/edits', {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${backend.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([progress.signal, AbortSignal.timeout(10 * 60 * 1000)]),
    }).then(value => value, unknown);
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`Image service returned HTTP ${response.status}`);
      if (response.status >= 500) error.submissionUnknown = true;
      throw error;
    }
    const json = await readImageResponse(response).then(value => value, unknown);
    assertConversation(request.conversationId);
    const directory = resultFolder(request);
    const received = JSON.stringify(json);
    if (reservation) reservation.consume(Buffer.byteLength(received));
    writeImageAtomically(path.join(directory, 'received.json'), Buffer.from(received));
    progress.saving();
    const artifacts = await saveResult(request, json, reservation);
    return artifacts;
    } finally { reservation?.release(); }
  }

  async function prepare(input, backend) {
      if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_EDIT_DATA_BYTES) throw new Error('Image editing data exceeds the supported memory budget');
      input = imageEditSubmissionSchema.parse(input);
      if (!backend || typeof backend.id !== 'string' || typeof backend.apiKey !== 'string' || !backend.apiKey.trim()) throw new Error('Image service credentials are unavailable');
      if (!/^[\x21-\x7e]+$/.test(backend.apiKey)) throw new Error('Image service credentials contain unsupported characters');
      const capability = imageEditCapabilities(backend);
      if (!capability.whole || !backend.apiKey) throw new Error('Image editing requires a configured supported service');
      if ((input.comments.length && !capability.comments) || (input.markup.length && !capability.markup)
        || (input.region.length && !capability.region)) throw new Error('The image service does not support these editing instructions');
      if (input.source.kind !== 'source' || input.sourceCaptureId !== input.source.fileRef.captureId || input.sourceDigest !== input.source.fileRef.contentDigest) throw new Error('Image source does not match its capture');
      const existing = jobs.find(input.conversationId, input.id);
      if (existing) {
        const request = existing.request;
        if (request.messageId !== input.messageId || request.sourceArtifactId !== input.sourceArtifactId
          || request.sourceCaptureId !== input.sourceCaptureId || request.sourceDigest !== input.sourceDigest
          || request.backendId !== backend.id || request.capabilityVersion !== capability.profileVersion
          || request.prompt !== input.prompt || !isDeepStrictEqual(request.comments, input.comments)
          || !isDeepStrictEqual(request.markup, input.markup) || !isDeepStrictEqual(request.region, input.region)) {
          throw new Error('Media request id already names different instructions');
        }
        if (request.attachmentRefs[0].fileRef.originalPath !== input.source.fileRef.originalPath) throw new Error('Image source does not match its capture');
        backends.set(requestKey(request), { ...backend });
        return existing;
      }
      const source = await captures.read(input.conversationId, input.source.fileRef);
      if (source.bytes.length > capability.maxBytes) throw new Error('Image attachment exceeds the service limit');
      const base = { ...input, source: source.attachment };
      const attachments = [source.attachment];
      const { width, height } = source.attachment;
      if (width * height > capability.maxPixels) throw new Error('Image dimensions exceed the service limit');
      if (backend.vendor === 'volcengine' && (width <= 14 || height <= 14 || width / height < 1 / 16 || width / height > 16)) {
        throw new Error('Image dimensions are outside the service limits');
      }
      const hasMarks = input.markup.length > 0 || input.comments.length > 0;
      let prepared = false;
      try {
      let mask;
      if (input.region.length > 0) {
        const bytes = await sharp(Buffer.from(imageLayerSvg(base, 'mask'))).png().toBuffer();
        const stats = await sharp(bytes).ensureAlpha().stats();
        if (stats.channels[3].min < 255) mask = bytes;
      }
      if (editPrompt(input, hasMarks && Boolean(mask || capability.markupTransport === 'reference')).length > 32000) throw new Error('Image instructions exceed the service limit');
      if (hasMarks) {
        const overlay = await sharp(Buffer.from(imageLayerSvg(base, 'markup'))).png().toBuffer();
        const useReference = mask || capability.markupTransport === 'reference';
        const bytes = useReference ? await sharp(source.bytes).composite([{ input: overlay }]).png().toBuffer() : overlay;
        attachments.push(captures.store(input.conversationId, input.source.fileRef.originalPath, useReference ? 'reference' : 'markup', bytes, width, height));
      }
      if (mask) attachments.push(captures.store(input.conversationId, input.source.fileRef.originalPath, 'mask', mask, width, height));
      for (const attachment of attachments) if (attachment.byteLength > capability.maxBytes) throw new Error('Image attachment exceeds the service limit');
      const request = imageEditRequestSchema.parse({
        schemaVersion: 1, id: input.id, scope, conversationId: input.conversationId, messageId: input.messageId,
        sourceArtifactId: input.sourceArtifactId, sourceCaptureId: source.attachment.fileRef.captureId,
        sourceDigest: source.attachment.fileRef.contentDigest, prompt: input.prompt, comments: input.comments,
        markup: input.markup, region: input.region, attachmentRefs: attachments,
        backendId: backend.id, capabilityVersion: capability.profileVersion,
      });
      assertConversation(input.conversationId);
      backends.set(requestKey(request), { ...backend });
      const record = jobs.prepare(request);
      prepared = true;
      for (const attachment of attachments) captures.retain(input.conversationId, attachment.fileRef);
      return record;
      } finally {
        if (!prepared) for (const attachment of attachments.slice(1)) captures.release(input.conversationId, attachment.fileRef);
      }
  }

  return {
    jobs,
    discardPrepared(conversationId, requestId) {
      jobs.discardPrepared(conversationId, requestId);
      backends.delete(requestKey({ conversationId, id: requestId }));
    },
    async prepare(input, backend) {
      const key = requestKey(input);
      const previous = preparing.get(key);
      const pending = (previous ? previous.then(() => prepare(input, backend)) : prepare(input, backend));
      preparing.set(key, pending);
      try { return await pending; }
      finally { if (preparing.get(key) === pending) preparing.delete(key); }
    },
    execute(conversationId, requestId) {
      return jobs.start(conversationId, requestId, execute).then(record => {
        if (record.job.generationState === 'completed') {
          backends.delete(requestKey(record.request));
          fs.rmSync(path.join(resultDirectory(record.request), 'received.json'), { force: true });
        }
        return record;
      });
    },
    retrySave(conversationId, requestId) {
      return jobs.retrySave(conversationId, requestId, async request => {
        const directory = resultFolder(request);
        let json;
          const descriptor = fs.openSync(path.join(directory, 'received.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            if (fs.fstatSync(descriptor).size > MAX_RESPONSE_BYTES) throw new Error('Image response exceeds the supported size');
            json = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
          } finally { fs.closeSync(descriptor); }
        const artifacts = await saveResult(request, json);
        return artifacts;
      }).then(record => {
        backends.delete(requestKey(record.request));
        fs.rmSync(path.join(resultDirectory(record.request), 'received.json'), { force: true });
        return record;
      });
    },
    forget(conversationId) {
      jobs.forget(conversationId);
      for (const key of backends.keys()) if (key.startsWith(`${conversationId}\0`)) backends.delete(key);
      fs.rmSync(path.join(root, 'results', createHash('sha256').update(conversationId).digest('hex')), { recursive: true, force: true });
    },
  };
}

module.exports = { createImageEditHost, readImageResponse, MAX_RESPONSE_BYTES };
