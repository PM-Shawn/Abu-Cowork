'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { performance } = require('node:perf_hooks');
const { createMediaCaptureStore } = require('../electron/mediaCaptureStore.cjs');
const { createImageEditHost } = require('../electron/imageEditHost.cjs');
const { killNativeHelper } = require('../electron/nativeHelperManager.cjs');

async function main() {
  const evidence = path.resolve('.agent/media-performance');
  fs.mkdirSync(evidence, { recursive: true });
  const root = fs.mkdtempSync(path.join(evidence, 'host-'));
  const sourcePath = path.join(root, 'source.jpg');
  await sharp({ create: { width: 8000, height: 5000, channels: 3, background: '#a5b8c9' } }).jpeg({ quality: 90 }).toFile(sourcePath);
  const assertConversation = id => assert.equal(id, 'performance');
  const captures = createMediaCaptureStore({ root: path.join(root, 'captures'), assertConversation });
  const host = createImageEditHost({ root, scope: 'local', captures, assertConversation });
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  const started = performance.now();
  try {
    const source = await captures.capture('performance', { path: sourcePath });
    const captureMs = performance.now() - started;
    const markup = Array.from({ length: 100 }, (_, row) => ({ id: `mark-${row}`, kind: 'pen', color: '#e54343', width: 0.001,
      points: Array.from({ length: 500 }, (_, column) => ({ x: column / 500, y: (row + (column % 2) / 2) / 100 })),
    }));
    const comments = Array.from({ length: 100 }, (_, index) => ({ id: `comment-${index}`, point: { x: (index % 10) / 10, y: Math.floor(index / 10) / 10 }, text: `Keep detail ${index}` }));
    const draft = {
      id: 'performance-edit', messageId: 'performance-message', scope: 'local', conversationId: 'performance',
      sourceArtifactId: 'source', sourceCaptureId: source.fileRef.captureId, sourceDigest: source.fileRef.contentDigest,
      source, activeTool: 'markup', prompt: 'Keep the package', comments, markup, region: [],
    };
    const prepareStart = performance.now();
    const record = await host.prepare(draft, { id: 'images', vendor: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2.5-sunburst', apiKey: 'unused-no-network' });
    const prepareMs = performance.now() - prepareStart;
    assert.equal(record.request.comments.length, 100);
    assert.equal(record.request.markup.reduce((sum, stroke) => sum + stroke.points.length, 0), 50000);
    assert.equal(record.request.attachmentRefs.length, 2);
    const rendered = await captures.read('performance', record.request.attachmentRefs[1].fileRef);
    const metadata = await sharp(rendered.bytes).metadata();
    assert.equal(metadata.width, 8000);
    assert.equal(metadata.height, 5000);
    const result = { platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), sourcePixels: 40_000_000,
      sourceBytes: fs.statSync(sourcePath).size, normalizedBytes: source.byteLength, strokes: 100, points: 50000,
      comments: 100, draftBytes: Buffer.byteLength(JSON.stringify(draft)), captureMs, prepareMs, peakRss,
      attachments: record.request.attachmentRefs.map(item => ({ kind: item.kind, bytes: item.byteLength })),
    };
    fs.writeFileSync(path.join(evidence, 'host.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    clearInterval(sample);
    killNativeHelper('media-performance-finished');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
