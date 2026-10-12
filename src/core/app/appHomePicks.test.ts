import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/stores/appStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import type { AppDefinition } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { appHomePicks } from './appHomePicks';

const team = { id: 'team-shop', name: '店铺运营小组', leaderRoleId: 'role-lead', memberRoleIds: ['role-lead'], createdAt: 1, updatedAt: 1 } as Team;
const reply = { id: 'reply', title: '客服回复', promptAppend: 'Answer as the shop.', templates: [] };
const shop: AppDefinition = {
  appId: 'created-app:shop', name: '店铺运营', version: '1.0.0', origin: { kind: 'created', authoringId: 'draft-1' }, plugins: [],
  config: {
    version: 1,
    defaultRun: { team: `mine:${team.id}` },
    home: { modes: { defaultSelected: 'service', items: [{ modeId: 'listing', title: '上架', scenes: [] }, { modeId: 'service', title: '客服', scenes: [reply] }] } },
  },
};

describe('appHomePicks', () => {
  beforeEach(() => {
    useTeamStore.setState({ teams: [team], managedTeamSources: {} });
    useAppStore.setState({ addedApps: [shop], managedApps: {}, seenAppIds: { [shop.appId]: true }, selectedAppId: shop.appId, selectedModeIdByApp: {}, expandedSceneIdByApp: {} });
  });

  afterEach(() => {
    useTeamStore.setState({ teams: [], managedTeamSources: {} });
    useAppStore.setState({ addedApps: [], managedApps: {}, seenAppIds: {}, selectedAppId: GENERAL_APP_ID, selectedModeIdByApp: {}, expandedSceneIdByApp: {} });
  });

  it('is nothing in the general shell', () => {
    useAppStore.setState({ selectedAppId: GENERAL_APP_ID });
    expect(appHomePicks()).toBeUndefined();
  });

  it('binds to the app in the mode its home opens on, with the app\'s default team', () => {
    expect(appHomePicks()).toEqual({
      binding: expect.objectContaining({ appId: shop.appId, appName: shop.name, origin: 'created', modeId: 'service', sceneId: undefined, run: shop.config.defaultRun }),
      teamId: team.id,
    });
  });

  it('follows the mode the user picked and the scene open on the home', () => {
    useAppStore.setState({ selectedModeIdByApp: { [shop.appId]: 'service' }, expandedSceneIdByApp: { [shop.appId]: reply.id } });
    expect(appHomePicks()?.binding).toMatchObject({ modeId: 'service', sceneId: reply.id, promptAppend: 'Answer as the shop.' });
    useAppStore.setState({ selectedModeIdByApp: { [shop.appId]: 'listing' } });
    expect(appHomePicks()?.binding).toMatchObject({ modeId: 'listing', sceneId: undefined });
  });

  it('names no team when the default run names one that is gone', () => {
    useTeamStore.setState({ teams: [] });
    expect(appHomePicks()).toMatchObject({ binding: { appId: shop.appId }, teamId: undefined });
  });
});
