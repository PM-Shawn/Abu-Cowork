// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstat } from '@tauri-apps/plugin-fs';
import { useChatStore } from './chatStore';
import { useWorkspaceStore } from './workspaceStore';
import {
  checkReadPath,
  checkWritePath,
  getAuthorizedDirs,
  revokeWorkspace,
} from '@/core/tools/pathSafety';
import type { Conversation } from '@/types';

// The sidecar run predicate self-registers at import time through modules in
// chatStore's import graph; stubbing it keeps that side effect inert. The
// stores and the path checker under test run their real code.
vi.mock('../core/agent/sidecarRunPredicate', () => ({
  isConversationRunningInSidecar: () => false,
  registerSidecarRunPredicate: () => {},
}));

const FIXED_TIMESTAMP = 1_700_000_000_000;
const SENDER_FOLDER = '/Users/testuser/Documents/from-sender';

function rawConversationJson(extra: Partial<Conversation> = {}): string {
  const conv: Conversation = {
    id: 'sender-conv',
    title: 'Shared notes',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    status: 'idle',
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: FIXED_TIMESTAMP }],
    ...extra,
  };
  return JSON.stringify(conv);
}

function resetGrants(paths: string[]) {
  for (const p of paths) revokeWorkspace(p);
}

const GRANTS_USED = [
  SENDER_FOLDER,
  '/Users/testuser',
  '/Users/testuser/Projects/app',
];

async function expectNeedsPermission(path: string): Promise<void> {
  const read = await checkReadPath(path);
  expect(read.allowed).toBe(false);
  expect(read.needsPermission).toBe(true);
  const write = await checkWritePath(path);
  expect(write.allowed).toBe(false);
  expect(write.needsPermission).toBe(true);
}

describe('chatStore.importConversation · a conversation file carries no workspace binding', () => {
  beforeEach(() => {
    vi.mocked(lstat).mockResolvedValue({ isSymlink: false } as never);
    resetGrants(GRANTS_USED);
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
    });
  });

  afterEach(() => {
    resetGrants(GRANTS_USED);
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  it('control: before import, a file under the sender-named folder needs permission', async () => {
    await expectNeedsPermission(`${SENDER_FOLDER}/notes.txt`);
  });

  it('a conversation imported from a file has no workspace and grants nothing', async () => {
    const newId = useChatStore.getState().importConversation(
      rawConversationJson({ workspacePath: SENDER_FOLDER }),
    );
    expect(newId).not.toBeNull();

    expect(useChatStore.getState().conversations[newId!].workspacePath).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[newId!].workspacePath).toBeUndefined();
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
    expect(getAuthorizedDirs()).not.toContain(SENDER_FOLDER);

    await expectNeedsPermission(`${SENDER_FOLDER}/notes.txt`);
  });

  it('switching back to the imported conversation grants nothing either', async () => {
    const importedId = useChatStore.getState().importConversation(
      rawConversationJson({ workspacePath: SENDER_FOLDER }),
    )!;
    const otherId = useChatStore.getState().createConversation(null);
    expect(useChatStore.getState().activeConversationId).toBe(otherId);

    await useChatStore.getState().switchConversation(importedId);
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
    await expectNeedsPermission(`${SENDER_FOLDER}/a.txt`);
  });

  it('a file naming the home directory grants nothing under it', async () => {
    useChatStore.getState().importConversation(rawConversationJson({ workspacePath: '/Users/testuser' }));

    await expectNeedsPermission('/Users/testuser/Pictures/holiday.png');
    await expectNeedsPermission('/Users/testuser/Projects/other-app/src/index.ts');
    expect((await checkReadPath('/Users/testuser/.ssh/id_rsa')).allowed).toBe(false);
  });

  it('a file naming "/." grants nothing', async () => {
    useChatStore.getState().importConversation(rawConversationJson({ workspacePath: '/.' }));

    expect(getAuthorizedDirs()).toEqual([]);
    const hosts = await checkReadPath('/etc/hosts');
    expect(hosts.allowed).toBe(false);
    expect(hosts.needsPermission).toBe(true);
    expect((await checkReadPath('/etc/shadow')).allowed).toBe(false);
  });

  it('a file carries over none of the bindings a share bundle drops', () => {
    const newId = useChatStore.getState().importConversation(
      rawConversationJson({
        workspacePath: SENDER_FOLDER,
        projectId: 'project-from-file',
        scheduledTaskId: 'task-from-file',
        triggerId: 'trigger-from-file',
        imChannelId: 'channel-from-file',
        imPlatform: 'feishu',
        activeSkills: ['skill-from-file'],
        enabledMCPServers: ['server-from-file'],
        permissionMode: 'autonomous',
        appBinding: { appId: 'app-from-file', promptAppend: 'text from the file' },
      }),
    )!;
    const conv = useChatStore.getState().conversations[newId];
    const meta = useChatStore.getState().conversationIndex[newId];
    for (const field of [
      'workspacePath', 'projectId', 'scheduledTaskId', 'triggerId', 'imChannelId', 'imPlatform',
      'activeSkills', 'enabledMCPServers', 'permissionMode', 'appBinding',
    ] as const) {
      expect(field in conv, `conversation.${field}`).toBe(false);
      expect(field in meta, `meta.${field}`).toBe(false);
    }
    expect(conv.messages).toHaveLength(1);
    expect(conv.title).toBe('Shared notes');
  });

  it('restoring a conversation this session deleted keeps its workspace and permission mode', async () => {
    const workspace = '/Users/testuser/Projects/app';
    const newId = useChatStore.getState().importConversation(
      rawConversationJson({ workspacePath: workspace, permissionMode: 'autonomous', projectId: 'p1' }),
      { restoringDeleted: true },
    )!;

    const conv = useChatStore.getState().conversations[newId];
    const meta = useChatStore.getState().conversationIndex[newId];
    expect(conv.workspacePath).toBe(workspace);
    expect(meta.workspacePath).toBe(workspace);
    expect(conv.permissionMode).toBe('autonomous');
    expect(meta.permissionMode).toBe('autonomous');
    expect(conv.projectId).toBe('p1');
    expect(meta.projectId).toBe('p1');
    expect(useWorkspaceStore.getState().currentPath).toBe(workspace);
    expect(await checkReadPath(`${workspace}/index.ts`)).toMatchObject({ allowed: true });
  });

  it('share bundles are imported without any workspace binding or grant', async () => {
    const bundle = {
      schema: { abuShareVersion: 1, tier: 'standard', exportedAt: FIXED_TIMESTAMP },
      conversation: { id: 'c', title: 't', createdAt: FIXED_TIMESTAMP, updatedAt: FIXED_TIMESTAMP },
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: FIXED_TIMESTAMP }],
      attachments: {},
      stats: { redactionCount: 0, attachmentCount: 0, embeddedCount: 0, sizeBytes: 0 },
    };
    const newId = useChatStore.getState().importConversation(JSON.stringify(bundle));
    expect(newId).not.toBeNull();
    expect(useChatStore.getState().conversationIndex[newId!].workspacePath).toBeUndefined();
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
    expect((await checkReadPath(`${SENDER_FOLDER}/a.txt`)).allowed).toBe(false);
  });
});
