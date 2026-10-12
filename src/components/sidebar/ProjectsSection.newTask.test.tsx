// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import type { AppDefinition, ConversationAppBinding } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import type { Project } from '@/types/project';
import ProjectsSection from './ProjectsSection';

// A project row as far as this file needs it: its 「新任务」 button.
vi.mock('./ProjectItem', () => ({
  default: ({ project, onNewTask }: { project: Project; onNewTask: (id: string) => void }) => (
    <Button onClick={() => onNewTask(project.id)}>{`新任务 ${project.name}`}</Button>
  ),
}));
vi.mock('@/components/common/ProjectSettingsDialog', () => ({ default: () => null }));

const project = { id: 'p1', name: '店铺资料', workspacePath: '/fake/project/p1', pinned: false, archived: false, createdAt: 1, updatedAt: 1, lastActiveAt: 1 } as Project;
const team = { id: 'team-shop', name: '店铺运营小组', leaderRoleId: 'role-lead', memberRoleIds: ['role-lead'], createdAt: 1, updatedAt: 1 } as Team;
const scene = { id: 'reply', title: '客服回复', templates: [] };
const shop: AppDefinition = {
  appId: 'created-app:shop', name: '店铺运营', version: '1.0.0', origin: { kind: 'created', authoringId: 'draft-1' }, plugins: [],
  config: {
    version: 1,
    defaultRun: { team: `mine:${team.id}` },
    home: { modes: { items: [{ modeId: 'service', title: '客服', scenes: [scene] }, { modeId: 'listing', title: '上架', scenes: [] }] } },
  },
};

const chat = () => useChatStore.getState();
const created = () => chat().conversations[chat().activeConversationId!];
const pressNewTask = () => fireEvent.click(screen.getByRole('button', { name: `新任务 ${project.name}` }));

describe('「新任务」 on a project row', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useProjectStore.setState({ projects: { [project.id]: project }, expandedProjectIds: [] });
    useTeamStore.setState({ teams: [team], managedTeamSources: {} });
    useAppStore.setState({ addedApps: [shop], managedApps: {}, seenAppIds: { [shop.appId]: true }, selectedAppId: shop.appId, selectedModeIdByApp: { [shop.appId]: 'listing' }, expandedSceneIdByApp: {}, activeAppPage: null });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
    useSettingsStore.setState({ viewMode: 'team' });
    render(<ProjectsSection onCreateProject={() => undefined} />, { wrapper: DesignSystemProvider });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ projects: {}, expandedProjectIds: [] });
    useTeamStore.setState({ teams: [], managedTeamSources: {} });
    useAppStore.setState({ addedApps: [], managedApps: {}, seenAppIds: {}, selectedAppId: GENERAL_APP_ID, selectedModeIdByApp: {}, expandedSceneIdByApp: {} });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
  });

  // The app home is not in view (a conversation or another page is), so it holds nothing ready.
  it('inside an app, starts a conversation of that app: its binding for the mode in view, and its default team', () => {
    pressNewTask();
    expect(created().projectId).toBe(project.id);
    expect(created().workspacePath).toBe(project.workspacePath);
    expect(created().appBinding).toMatchObject({ appId: shop.appId, appName: shop.name, modeId: 'listing' });
    expect(created().teamId).toBe(team.id);
    expect(chat().conversationIndex[created().id].appBinding).toMatchObject({ appId: shop.appId });
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('inside an app, uses what the app home holds ready while it is in view: its scene, and no team once the user took it off', () => {
    const fromHome: ConversationAppBinding = { version: 2, appId: shop.appId, appVersion: '1.0.0', origin: 'created', appName: shop.name, modeId: 'service', sceneId: scene.id };
    chat().setPendingAppBinding(fromHome);
    chat().setPendingTeamId(undefined);
    pressNewTask();
    expect(created().appBinding).toEqual(fromHome);
    expect(created().teamId).toBeUndefined();
  });

  it('in the general shell, starts a conversation of no app', () => {
    useAppStore.setState({ selectedAppId: GENERAL_APP_ID });
    pressNewTask();
    expect(created().projectId).toBe(project.id);
    expect(created().appBinding).toBeUndefined();
    expect(created().teamId).toBeUndefined();
  });
});
