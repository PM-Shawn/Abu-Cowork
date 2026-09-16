/**
 * Building an automatic run's approval target from its IM output binding.
 *
 * This is the piece that was missing: 「每次询问」 shipped as a real option in
 * the automatic-tasks column and `pendingApprovals` shipped the IM round-trip,
 * but nothing connected them for a scheduled task or a trigger — both bind no
 * IM session to their conversation, so every ask refused itself as
 * `no_binding`. These pin WHERE the ask goes and, just as importantly, when it
 * still goes nowhere.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useIMChannelStore } from '../../stores/imChannelStore';
import type { IMChannel } from '../../types/imChannel';
import { resolveUnattendedImTarget } from './approvalTarget';

const CHANNEL_ID = 'ch-feishu';

function channel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: CHANNEL_ID,
    platform: 'feishu',
    name: 'Team',
    appId: 'app',
    appSecret: 'secret',
    capability: 'full',
    responseMode: 'mention_only',
    allowedUsers: [],
    workspacePaths: [],
    sessionTimeoutMinutes: 0,
    maxRoundsPerSession: 0,
    enabled: true,
    status: 'connected',
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useIMChannelStore.setState({ channels: { [CHANNEL_ID]: channel() } });
});

describe('resolveUnattendedImTarget', () => {
  describe('a chat the automation named', () => {
    it('addresses the first chat id, as a chat', () => {
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputChatIds: 'oc_team, oc_second',
          // An owner is required for a chat target (R1); this case is about
          // WHICH chat is addressed.
          outputUserIds: 'ou_li',
        }),
      ).toEqual({
        platform: 'feishu',
        channelId: CHANNEL_ID,
        chatId: 'oc_team',
        chatIdType: 'chat_id',
        senderId: 'ou_li',
      });
    });

    /*
      An approval is a DECISION. Fanning one prompt out to every configured
      chat the way results fan out would put the same question in five rooms
      where only one answer can settle it — and the other four would sit there
      after the run moved on. Results are a broadcast; an approval is not.
    */
    it('asks in one place even when results go to several', () => {
      const target = resolveUnattendedImTarget({
        outputChannelId: CHANNEL_ID,
        outputChatIds: 'oc_a,oc_b,oc_c',
        outputUserIds: 'ou_lead,ou_other',
      });
      expect(target?.chatId).toBe('oc_a');
      expect(target?.senderId).toBe('ou_lead');
    });

    /*
      "Post it in the team room, but only Li may approve it." The chat decides
      where it is visible; the bound owner decides whose 「同意」 counts.
    */
    it('binds the owner from the user ids even when the target is a chat', () => {
      const target = resolveUnattendedImTarget({
        outputChannelId: CHANNEL_ID,
        outputChatIds: 'oc_team',
        outputUserIds: 'ou_li',
      });
      expect(target).toMatchObject({ chatId: 'oc_team', senderId: 'ou_li' });
    });

    /*
      R1 (security review of 0b04b84a) — a chat with NO named owner is not a
      target at all.

      U3 M5 stands: with no bound owner only a PRIVATE chat's reply counts, and
      a group chat can never be one. Building the target anyway produced the
      worst possible sequence: a prompt telling a room to 「回复同意」, every
      reply ignored, and five minutes later a 「没收到回复」 receipt posted into
      a room where somebody had in fact replied. Refusing makes it immediate
      and honest — the caller reports `no_binding`.
    */
    it('refuses a group chat the automation gave no owner for', () => {
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputChatIds: 'oc_team',
        }),
      ).toBeNull();
    });
  });

  describe('a person the automation named', () => {
    /*
      R3 (final review) — a DM on a platform running two enabled channels is
      refused at construction, not delivered and then silently ignored.

      A DM reply cannot be attributed to a channel (inbound messages carry no
      channel id), so with two enabled channels the answer-time check refuses
      it. Building the target anyway would reproduce the exact sequence R1
      removed: prompt delivered, reply ignored, 「没收到回复」 receipt posted
      into the inbox that answered. Same ruling as R1/R2 — refuse up front.
    */
    it('is refused when the platform has more than one enabled channel', () => {
      useIMChannelStore.setState({
        channels: {
          [CHANNEL_ID]: channel(),
          'ch-second-app': channel({ id: 'ch-second-app', name: 'Second Feishu app' }),
        },
      });
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputUserIds: 'ou_li' }),
      ).toBeNull();
    });

    it('is built again once the second channel is switched off', () => {
      useIMChannelStore.setState({
        channels: {
          [CHANNEL_ID]: channel(),
          'ch-second-app': channel({ id: 'ch-second-app', enabled: false }),
        },
      });
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputUserIds: 'ou_li' })?.chatId,
      ).toBe('ou_li');
    });

    /*
      A CHAT target is unaffected: it matches on chat id, which is unambiguous
      no matter how many apps could have delivered the prompt. Narrowing that
      too would refuse a working configuration for no gain.
    */
    it('leaves a chat target alone on a multi-channel platform', () => {
      useIMChannelStore.setState({
        channels: {
          [CHANNEL_ID]: channel(),
          'ch-second-app': channel({ id: 'ch-second-app' }),
        },
      });
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputChatIds: 'oc_team',
          outputUserIds: 'ou_li',
        }),
      ).toMatchObject({ chatId: 'oc_team', chatIdType: 'chat_id' });
    });

    /*
      Another PLATFORM's channels are irrelevant — the ambiguity is only
      between apps that could deliver the same inbound message.
    */
    it('ignores enabled channels on other platforms', () => {
      useIMChannelStore.setState({
        channels: {
          [CHANNEL_ID]: channel(),
          'ch-dingtalk': channel({ id: 'ch-dingtalk', platform: 'dingtalk' }),
        },
      });
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputUserIds: 'ou_li' })?.chatId,
      ).toBe('ou_li');
    });

    /*
      No chat id: the id addresses a PERSON, and the adapter opens a 1:1 chat
      to reach them. The person addressed is by definition the owner — there is
      nobody else in the room — so the owner binding is not optional here.
    */
    it('addresses the first user id as a DM, owned by that user', () => {
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputUserIds: ' ou_li , ou_wang ',
        }),
      ).toEqual({
        platform: 'feishu',
        channelId: CHANNEL_ID,
        chatId: 'ou_li',
        chatIdType: 'open_id',
        senderId: 'ou_li',
      });
    });
  });

  describe('nowhere to ask', () => {
    it.each([
      ['no channel at all', {}],
      ['a channel but no chat and no user', { outputChannelId: CHANNEL_ID }],
      ['ids that are only whitespace and commas', {
        outputChannelId: CHANNEL_ID,
        outputChatIds: ' , , ',
        outputUserIds: ',',
      }],
      ['an empty channel id', { outputChannelId: '', outputChatIds: 'oc_team' }],
    ])('returns null for %s', (_case, binding) => {
      expect(resolveUnattendedImTarget(binding)).toBeNull();
    });

    it('returns null for an undefined binding', () => {
      expect(resolveUnattendedImTarget(undefined)).toBeNull();
    });

    /*
      A channel the user deleted after configuring the task. Inventing a
      platform here would hand `outputSender` an adapter it cannot pick and
      `tryConsumeApprovalReply` a platform no inbound message will ever match —
      a prompt that silently goes nowhere is worse than an honest refusal.
    */
    it('returns null when the named channel no longer exists', () => {
      useIMChannelStore.setState({ channels: {} });
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputChatIds: 'oc_team' }),
      ).toBeNull();
    });

    it('returns null when the store has no channels map at all', () => {
      useIMChannelStore.setState({ channels: undefined as unknown as Record<string, IMChannel> });
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputChatIds: 'oc_team' }),
      ).toBeNull();
    });
  });

  /*
    R2 (security review) — a channel the user switched OFF is not a target.

    The earlier rationale ("it just fails to deliver, which is fail-closed")
    was wrong: `outputSender.sendViaIMChannel` has no `enabled` check, so a
    disabled channel really does DELIVER the prompt — pushed through a channel
    the user turned off — while the inbound socket is stopped, so no answer can
    arrive. Five minutes of stall, one unwanted message, same refusal.
  */
  describe('a channel that is switched off', () => {
    it('is not a target, for a chat or for a DM', () => {
      useIMChannelStore.setState({
        channels: { [CHANNEL_ID]: channel({ enabled: false }) },
      });
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputChatIds: 'oc_team',
          outputUserIds: 'ou_li',
        }),
      ).toBeNull();
      expect(
        resolveUnattendedImTarget({ outputChannelId: CHANNEL_ID, outputUserIds: 'ou_li' }),
      ).toBeNull();
    });

    /*
      NOT gated on `status`, deliberately. `status` is a live connection state
      that flaps across ordinary reconnects; turning a transient blip into a
      refused action would make automations unreliable for a reason the user
      never chose. `enabled` is a standing decision.
    */
    it('is still a target while merely disconnected', () => {
      useIMChannelStore.setState({
        channels: { [CHANNEL_ID]: channel({ enabled: true, status: 'disconnected' }) },
      });
      expect(
        resolveUnattendedImTarget({
          outputChannelId: CHANNEL_ID,
          outputChatIds: 'oc_team',
          outputUserIds: 'ou_li',
        }),
      ).not.toBeNull();
    });
  });

  it('reads the platform from the channel, not from the caller', () => {
    useIMChannelStore.setState({
      channels: { [CHANNEL_ID]: channel({ platform: 'dingtalk' }) },
    });
    expect(
      resolveUnattendedImTarget({
        outputChannelId: CHANNEL_ID,
        outputChatIds: 'cid',
        outputUserIds: 'uid',
      })?.platform,
    ).toBe('dingtalk');
  });
});
