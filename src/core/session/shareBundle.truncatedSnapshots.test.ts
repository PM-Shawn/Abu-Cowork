// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exists, readFile } from '@tauri-apps/plugin-fs';
import { useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import { buildShareBundle } from './shareBundle';
import { listSnapshots, __testing as snapshotTesting, type OutputManifest, type SnapshotEntry } from './outputSnapshots';

// chatStore's import graph self-registers a sidecar run predicate; stub it so
// that side effect stays inert. chatStore, outputSnapshots and shareBundle
// all run their real code; only the file-system bridge is a test double.
vi.mock('../agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: () => false,
  registerSidecarRunPredicate: () => {},
}));

const FIXED_TIMESTAMP = 1_700_000_000_000;
const SNAPSHOT_BYTES = new Uint8Array([0x66, 0x61, 0x6b, 0x65]); // "fake"
const SNAPSHOT_BASE64 = 'ZmFrZQ==';
const SNIPPET_TEXT = "print('hello from the snippet')";
const SNIPPET_BYTES = new TextEncoder().encode(SNIPPET_TEXT);
const SNIPPET_BASE64 = btoa(SNIPPET_TEXT);

function entry(over: Partial<SnapshotEntry> & Pick<SnapshotEntry, 'originalPath' | 'basename' | 'source' | 'refId' | 'refKind'>): SnapshotEntry {
  return {
    snapshotRelPath: `files/${over.refKind}-${over.basename}/${over.basename}`,
    size: SNAPSHOT_BYTES.length,
    originalMtime: 0,
    snapshottedAt: FIXED_TIMESTAMP,
    ...over,
  };
}

function firstTurnManifest(): OutputManifest {
  return {
    version: 1,
    entries: {
      '/Users/testuser/Documents/ws/report.docx': entry({
        originalPath: '/Users/testuser/Documents/ws/report.docx',
        basename: 'report.docx',
        source: 'tool-output',
        refId: 'tc-1',
        refKind: 'write_file',
      }),
      '/Users/testuser/Pictures/photo.png': entry({
        originalPath: '/Users/testuser/Pictures/photo.png',
        basename: 'photo.png',
        source: 'user-upload',
        refId: 'u1',
        refKind: 'image',
      }),
      'tool-result://tc-1': entry({
        originalPath: 'tool-result://tc-1',
        basename: 'result.png',
        source: 'tool-output',
        refId: 'tc-1',
        refKind: 'result-image',
      }),
      '/Users/testuser/Documents/ws/snippet.py': entry({
        originalPath: '/Users/testuser/Documents/ws/snippet.py',
        basename: 'snippet.py',
        source: 'code-save',
        refId: '',
        refKind: 'python',
        size: SNIPPET_BYTES.length,
      }),
    },
  };
}

describe('buildShareBundle · attachments follow the exported messages', () => {
  beforeEach(() => {
    snapshotTesting.resetCaches();
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    vi.mocked(exists).mockImplementation(async (path) => String(path).includes('/outputs/files/'));
    vi.mocked(readFile).mockImplementation(async (path) => (
      String(path).endsWith('snippet.py') ? SNIPPET_BYTES : SNAPSHOT_BYTES
    ));
  });

  /** First turn: the user uploads a picture, the assistant writes a report and
   *  returns a screenshot, and the user saves a code block to disk. */
  function addFirstTurn(convId: string): void {
    const store = useChatStore.getState();
    store.addMessage(convId, {
      id: 'u1',
      role: 'user',
      timestamp: FIXED_TIMESTAMP,
      content: [
        { type: 'text', text: 'Summarize this picture' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, filePath: '/Users/testuser/Pictures/photo.png' },
      ],
    });
    store.addMessage(convId, {
      id: 'a1',
      role: 'assistant',
      timestamp: FIXED_TIMESTAMP + 1,
      content: `Wrote the report to report.docx. Here is the script:\n\n\`\`\`python\n${SNIPPET_TEXT}\n\`\`\`\n`,
      toolCalls: [{
        id: 'tc-1',
        name: 'write_file',
        input: { path: '/Users/testuser/Documents/ws/report.docx', content: 'secret draft' },
        result: 'ok',
      }],
    });
  }

  function addSecondTurn(convId: string): void {
    useChatStore.getState().addMessage(convId, {
      id: 'u2', role: 'user', content: 'Something unrelated', timestamp: FIXED_TIMESTAMP + 2,
    });
    useChatStore.getState().addMessage(convId, {
      id: 'a2', role: 'assistant', content: 'Sure.', timestamp: FIXED_TIMESTAMP + 3,
    });
  }

  async function buildTruncatedConversation(): Promise<string> {
    const convId = useChatStore.getState().createConversation(null);
    addFirstTurn(convId);
    snapshotTesting.setManifest(convId, firstTurnManifest());
    // The user edits the first message and resends: the whole turn is cut.
    useChatStore.getState().deleteMessagesFrom(convId, 'u1');
    await waitForConversationPersistence(convId);
    addSecondTurn(convId);
    return convId;
  }

  function buildIntactConversation(): string {
    const convId = useChatStore.getState().createConversation(null);
    addFirstTurn(convId);
    addSecondTurn(convId);
    snapshotTesting.setManifest(convId, firstTurnManifest());
    return convId;
  }

  it('truncating messages leaves the manifest alone', async () => {
    const convId = await buildTruncatedConversation();
    const conv = useChatStore.getState().conversations[convId];
    expect(conv.messages.map((m) => m.id)).toEqual(['u2', 'a2']);

    const remaining = await listSnapshots(convId);
    expect(remaining.map((e) => e.originalPath).sort()).toEqual([
      '/Users/testuser/Documents/ws/report.docx',
      '/Users/testuser/Documents/ws/snippet.py',
      '/Users/testuser/Pictures/photo.png',
      'tool-result://tc-1',
    ]);
  });

  it('exports no attachment of a cut turn: tool output, result image, user upload and code save alike', async () => {
    const convId = await buildTruncatedConversation();
    const conv = useChatStore.getState().conversations[convId];

    const bundle = await buildShareBundle(conv);

    expect(bundle.messages.map((m) => m.id)).toEqual(['u2', 'a2']);
    // tool-output keyed by a tool call no exported message holds
    expect(bundle.attachments['~/Documents/ws/report.docx']).toBeUndefined();
    // the result image of that same tool call
    expect(bundle.attachments['tool-result://tc-1']).toBeUndefined();
    // the user upload of a message that is no longer in the conversation
    expect(bundle.attachments['~/Pictures/photo.png']).toBeUndefined();
    // a code save whose text no exported message contains
    expect(bundle.attachments['~/Documents/ws/snippet.py']).toBeUndefined();
    expect(bundle.attachments).toEqual({});
    expect(bundle.stats.attachmentCount).toBe(0);
    expect(bundle.stats.embeddedCount).toBe(0);
    expect(JSON.stringify(bundle)).not.toContain(SNAPSHOT_BASE64);
    expect(JSON.stringify(bundle)).not.toContain('photo.png');
  });

  it('exports every attachment of a conversation that was never cut', async () => {
    const convId = buildIntactConversation();
    const conv = useChatStore.getState().conversations[convId];

    const bundle = await buildShareBundle(conv);

    expect(bundle.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(Object.keys(bundle.attachments).sort()).toEqual([
      'tool-result://tc-1',
      '~/Documents/ws/report.docx',
      '~/Documents/ws/snippet.py',
      '~/Pictures/photo.png',
    ]);
    expect(bundle.attachments['~/Documents/ws/report.docx']).toMatchObject({
      source: 'tool-output',
      basename: 'report.docx',
      data: SNAPSHOT_BASE64,
    });
    expect(bundle.attachments['tool-result://tc-1']).toMatchObject({
      source: 'tool-output',
      basename: 'result.png',
      data: SNAPSHOT_BASE64,
    });
    expect(bundle.attachments['~/Documents/ws/snippet.py']).toMatchObject({
      source: 'code-save',
      basename: 'snippet.py',
      data: SNIPPET_BASE64,
    });
    expect(bundle.attachments['~/Pictures/photo.png']).toMatchObject({
      source: 'user-upload',
      basename: 'photo.png',
      skipReason: 'user-upload-excluded',
    });
    expect(bundle.attachments['~/Pictures/photo.png'].data).toBeUndefined();
    expect(bundle.stats.attachmentCount).toBe(4);
    expect(bundle.stats.embeddedCount).toBe(3);
  });

  it('keeps the attachments of the surviving turn when a later turn is cut', async () => {
    const convId = buildIntactConversation();
    useChatStore.getState().addMessage(convId, {
      id: 'a3',
      role: 'assistant',
      timestamp: FIXED_TIMESTAMP + 4,
      content: 'Wrote notes.md',
      toolCalls: [{
        id: 'tc-3',
        name: 'write_file',
        input: { path: '/Users/testuser/Documents/ws/notes.md', content: 'later' },
        result: 'ok',
      }],
    });
    const manifest = firstTurnManifest();
    manifest.entries['/Users/testuser/Documents/ws/notes.md'] = entry({
      originalPath: '/Users/testuser/Documents/ws/notes.md',
      basename: 'notes.md',
      source: 'tool-output',
      refId: 'tc-3',
      refKind: 'write_file',
    });
    snapshotTesting.setManifest(convId, manifest);
    useChatStore.getState().deleteMessagesFrom(convId, 'a3');
    await waitForConversationPersistence(convId);

    const bundle = await buildShareBundle(useChatStore.getState().conversations[convId]);
    expect(bundle.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(Object.keys(bundle.attachments).sort()).toEqual([
      'tool-result://tc-1',
      '~/Documents/ws/report.docx',
      '~/Documents/ws/snippet.py',
      '~/Pictures/photo.png',
    ]);
    expect(bundle.attachments['~/Documents/ws/notes.md']).toBeUndefined();
  });

  it('exports a code save only when an exported message contains its text', async () => {
    const convId = buildIntactConversation();
    vi.mocked(readFile).mockImplementation(async (path) => (
      String(path).endsWith('snippet.py') ? new TextEncoder().encode("print('a different script')") : SNAPSHOT_BYTES
    ));

    const bundle = await buildShareBundle(useChatStore.getState().conversations[convId]);
    expect(bundle.attachments['~/Documents/ws/snippet.py']).toBeUndefined();
    expect(bundle.stats.attachmentCount).toBe(3);
    expect(bundle.stats.embeddedCount).toBe(2);
  });

  it('exports an installed share attachment only when an exported message names its path', async () => {
    const convId = buildIntactConversation();
    const manifest = firstTurnManifest();
    // Installed from an earlier import: the report is named by tc-1's write_file
    // input, the slide deck by nothing in the conversation.
    manifest.entries['/Users/testuser/Documents/ws/report.docx'] = entry({
      originalPath: '/Users/testuser/Documents/ws/report.docx',
      basename: 'report.docx',
      source: 'tool-output',
      refId: 'shared-import',
      refKind: 'shared',
    });
    manifest.entries['/Users/testuser/Documents/ws/deck.pptx'] = entry({
      originalPath: '/Users/testuser/Documents/ws/deck.pptx',
      basename: 'deck.pptx',
      source: 'tool-output',
      refId: 'shared-import',
      refKind: 'shared',
    });
    snapshotTesting.setManifest(convId, manifest);

    const bundle = await buildShareBundle(useChatStore.getState().conversations[convId]);
    expect(bundle.attachments['~/Documents/ws/report.docx']).toMatchObject({ data: SNAPSHOT_BASE64 });
    expect(bundle.attachments['~/Documents/ws/deck.pptx']).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('deck.pptx');
  });
});
