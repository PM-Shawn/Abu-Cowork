import { useState } from 'react';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select } from '@/components/ds/select';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import type { IMPlatform } from '@/types/im';
import type { IMCapabilityLevel, IMChannel, IMResponseMode } from '@/types/imChannel';
import { getIMPlatformOptions, getPlatformDisplayName } from '@/core/im/platformLabels';
import { hasHeartbeatPlugin } from '@/core/im/pluginRegistry';
import WeChatQRPanel from './WeChatQRPanel';
import type { WeChatCredentials } from '@/core/im/adapters/wechat';

const CAPABILITY_OPTIONS: { value: IMCapabilityLevel; labelKey: keyof ReturnType<typeof useCapLabels> }[] = [
  { value: 'chat_only', labelKey: 'chat_only' },
  { value: 'read_tools', labelKey: 'read_tools' },
  { value: 'safe_tools', labelKey: 'safe_tools' },
  { value: 'full', labelKey: 'full' },
];

const LAN_WEBHOOK_SWITCH_ID = 'im-allow-lan-webhook';
// The five built-in platforms fit side by side in the control column. An IM plugin adds more;
// from six on they are offered in a select.
const MAX_PLATFORM_SEGMENTS = 5;

function useCapLabels() {
  const { t } = useI18n();
  return {
    chat_only: t.imChannel.capabilityChatOnly,
    read_tools: t.imChannel.capabilityReadTools,
    safe_tools: t.imChannel.capabilitySafeTools,
    full: t.imChannel.capabilityFull,
  };
}

/** Consistent form row: label on left, control on right */
function FormRow({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      {/* As tall as one control, so the label sits on the first control line of the row. */}
      <div className="flex h-7 shrink-0 items-center gap-1 text-ui text-label-secondary">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <Pressable aria-label={label} className="inline-flex rounded-control text-label-tertiary hover:text-label">
              <Icon icon={AppIcons.help} size="sm" />
            </Pressable>
          </Tooltip>
        )}
      </div>
      <div className={cn(SETTING_CONTROL_WIDTH.imForm, 'shrink-0')}>{children}</div>
    </div>
  );
}

/** Section group with optional title */
function FormGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {title && (
        <div className="text-ui-sm font-medium text-label-tertiary">{title}</div>
      )}
      {children}
    </div>
  );
}

/** Consistent text input */
function FormInput({
  value,
  onChange,
  type = 'text',
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <TextField
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={mono ? 'font-code' : undefined}
    />
  );
}

/** Consistent number input — full width to match other fields */
function FormNumber({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <TextField
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || min)}
    />
  );
}

export default function IMChannelSection() {
  const { t } = useI18n();
  const channels = useIMChannelStore(s => s.channels);
  const sessions = useIMChannelStore(s => s.sessions);
  const addChannel = useIMChannelStore(s => s.addChannel);
  const updateChannel = useIMChannelStore(s => s.updateChannel);
  const removeChannel = useIMChannelStore(s => s.removeChannel);
  const capLabels = useCapLabels();
  const confirm = useConfirm();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState<IMPlatform>('feishu');
  const [newAppId, setNewAppId] = useState('');
  const [newAppSecret, setNewAppSecret] = useState('');
  const [newCapability, setNewCapability] = useState<IMCapabilityLevel>('safe_tools');
  // WeChat-specific: bound credentials from QR scan
  const [wechatCreds, setWechatCreds] = useState<WeChatCredentials | null>(null);

  const channelList = Object.values(channels);
  const serverPort = triggerEngine.getServerPort() ?? 18080;
  const capabilityOptions = CAPABILITY_OPTIONS.map(o => ({ value: o.value, label: capLabels[o.value] }));

  const handleAdd = () => {
    if (!newName.trim()) return;
    if (newPlatform === 'wechat') {
      if (!wechatCreds) return;
      addChannel({
        platform: 'wechat',
        name: newName.trim(),
        appId: wechatCreds.ilinkBotId,
        appSecret: JSON.stringify(wechatCreds),
        capability: newCapability,
      });
    } else {
      if (!newAppId.trim() || !newAppSecret.trim()) return;
      addChannel({
        platform: newPlatform,
        name: newName.trim(),
        appId: newAppId.trim(),
        appSecret: newAppSecret.trim(),
        capability: newCapability,
      });
    }
    setNewName('');
    setNewAppId('');
    setNewAppSecret('');
    setNewCapability('safe_tools');
    setWechatCreds(null);
    setShowAddForm(false);
  };

  // Reset WeChat creds when platform changes
  const handlePlatformChange = (p: IMPlatform) => {
    setNewPlatform(p);
    if (p !== 'wechat') setWechatCreds(null);
  };

  const handleDelete = async (channel: IMChannel) => {
    const { id } = channel;
    if (!await confirm({ title: t.imChannel.deleteConfirm, message: channel.name, confirmLabel: t.common.delete, tone: 'danger' })) return;
    // Read again at answer time: the channel may have gone while the question was open.
    if (!useIMChannelStore.getState().channels[id]) return;
    removeChannel(id);
    setExpandedId((current) => (current === id ? null : current));
  };

  const getSessionCount = (channelId: string) =>
    Object.values(sessions).filter(s => s.channelId === channelId).length;

  return (
    <div className="space-y-6">
      {/* Header — shared component; add button in the action slot (matches Models). */}
      <SettingsSectionHeader
        title={t.imChannel.title}
        description={t.imChannel.description}
        action={!showAddForm ? (
          <Button variant="primary" size="sm" icon={AppIcons.add} onClick={() => setShowAddForm(true)}>
            {t.settings.add}
          </Button>
        ) : undefined}
      />

      {/* Channel List */}
      {channelList.length === 0 && !showAddForm && (
        <EmptyState title={t.imChannel.noChannels} description={t.imChannel.noChannelsHint} />
      )}

      {channelList.map((channel) => {
        const isExpanded = expandedId === channel.id;
        const sessionCount = getSessionCount(channel.id);
        const webhookUrl = `http://127.0.0.1:${serverPort}/im/${channel.platform}/webhook`;

        return (
          <div key={channel.id} className="overflow-hidden rounded-panel border border-separator">
            {/* Channel header row: the part that opens the channel, and its switch beside it. */}
            <div className="flex items-center gap-3 pr-4">
              <Pressable
                aria-expanded={isExpanded}
                onClick={() => setExpandedId(isExpanded ? null : channel.id)}
                // The card clips what is drawn outside it, so the focus ring is drawn inside.
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-fill-hover focus-visible:ring-inset"
              >
                <PlatformBadge platform={channel.platform} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-ui font-medium text-label">{channel.name}</span>
                    <StatusDot status={channel.status} />
                  </span>
                  <span className="mt-1 flex items-center gap-3 text-ui-sm text-label-tertiary">
                    <span>{capLabels[channel.capability]}</span>
                    {sessionCount > 0 && (
                      <span>{t.imChannel.activeSessions}: {sessionCount}</span>
                    )}
                  </span>
                </span>
                <Icon icon={isExpanded ? AppIcons.collapse : AppIcons.expand} className="text-label-tertiary" />
              </Pressable>
              <Switch
                aria-label={channel.name}
                checked={channel.enabled}
                onCheckedChange={() => {
                  updateChannel(channel.id, { enabled: !channel.enabled });
                }}
              />
            </div>

            {/* Expanded detail — grouped layout */}
            {isExpanded && (
              // Named after the channel, so its Delete button is told apart from the ones of its allowed users.
              <div role="group" aria-label={channel.name} className="space-y-5 border-t border-separator px-5 py-5">
                {/* Group 1: Connection */}
                <FormGroup title={t.imChannel.groupConnection}>
                  <FormRow label={t.imChannel.channelName}>
                    <FormInput
                      value={channel.name}
                      onChange={(v) => updateChannel(channel.id, { name: v })}
                    />
                  </FormRow>
                  {channel.platform === 'wechat' ? (
                    <WeChatConnectionRows
                      channel={channel}
                      onRebind={(creds) => updateChannel(channel.id, {
                        appId: creds.ilinkBotId,
                        appSecret: JSON.stringify(creds),
                      })}
                    />
                  ) : (
                    <>
                      <FormRow label="App ID">
                        <FormInput
                          value={channel.appId}
                          onChange={(v) => updateChannel(channel.id, { appId: v })}
                          mono
                        />
                      </FormRow>
                      <FormRow label="App Secret">
                        <FormInput
                          type="password"
                          value={channel.appSecret}
                          onChange={(v) => updateChannel(channel.id, { appSecret: v })}
                          mono
                        />
                      </FormRow>
                      <WebhookUrlField url={webhookUrl} hint={t.imChannel.webhookUrlHint} label={t.imChannel.webhookUrl} />
                    </>
                  )}
                </FormGroup>

                <div className="border-t border-separator" />

                {/* Group 2: Behavior */}
                <FormGroup title={t.imChannel.groupBehavior}>
                  <FormRow label={t.imChannel.responseMode} hint={<>{t.imChannel.responseMentionOnly}：{t.imChannel.responseMentionOnlyHint}<br/>{t.imChannel.responseAllMessages}：{t.imChannel.responseAllMessagesHint}</>}>
                    <Select
                      fullWidth
                      label={t.imChannel.responseMode}
                      value={channel.responseMode ?? 'mention_only'}
                      options={[
                        { value: 'mention_only', label: t.imChannel.responseMentionOnly },
                        { value: 'all_messages', label: t.imChannel.responseAllMessages },
                      ]}
                      onValueChange={(v) => updateChannel(channel.id, { responseMode: v as IMResponseMode })}
                    />
                  </FormRow>
                  <FormRow label={t.imChannel.capability}>
                    <Select
                      fullWidth
                      label={t.imChannel.capability}
                      value={channel.capability}
                      options={capabilityOptions}
                      onValueChange={(v) => updateChannel(channel.id, { capability: v as IMCapabilityLevel })}
                    />
                  </FormRow>
                  <FormRow label={`${t.imChannel.sessionTimeout}（${t.imChannel.sessionTimeoutMinutes}）`} hint={t.imChannel.timeoutHint}>
                    <FormNumber
                      value={channel.sessionTimeoutMinutes}
                      onChange={(v) => updateChannel(channel.id, { sessionTimeoutMinutes: v })}
                      min={0}
                      max={1440}
                    />
                  </FormRow>
                </FormGroup>

                <div className="border-t border-separator" />

                {/* Group 3: Access */}
                <FormGroup title={t.imChannel.groupAccess}>
                  <TagInput
                    label={t.imChannel.allowedUsers}
                    hint={t.imChannel.allowedUsersHint}
                    placeholder={t.imChannel.allowedUsersPlaceholder}
                    values={channel.allowedUsers}
                    onChange={(users) => updateChannel(channel.id, { allowedUsers: users })}
                  />
                </FormGroup>

                {/* Error display */}
                {channel.lastError && (
                  <InlineMessage tone="danger">{channel.lastError}</InlineMessage>
                )}

                {/* Delete button */}
                <div className="border-t border-separator pt-3">
                  <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => void handleDelete(channel)}>
                    {t.common.delete}
                  </Button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Add Channel Form */}
      {showAddForm && (
        <div className="space-y-4 rounded-panel border border-separator p-4">
          <h4 className="text-ui font-medium text-label">{t.imChannel.addChannel}</h4>

          {/* Name */}
          <FormRow label={t.imChannel.channelName}>
            <FormInput
              value={newName}
              onChange={setNewName}
              placeholder={t.imChannel.channelNamePlaceholder}
            />
          </FormRow>

          {/* Platform */}
          <FormRow label={t.imChannel.platform}>
            <PlatformChoice value={newPlatform} onChange={handlePlatformChange} />
          </FormRow>

          {/* Credentials — WeChat uses QR scan, others use AppId/AppSecret */}
          {newPlatform === 'wechat' ? (
            <WeChatQRPanel
              onBound={(creds) => {
                setWechatCreds(creds);
                // Prefill a sensible default name on bind so Save is immediately
                // enabled — the empty-name→disabled-Save trap is otherwise easy
                // to miss right after a successful scan. User can still edit it.
                setNewName((prev) => prev.trim() || getPlatformDisplayName('wechat'));
              }}
            />
          ) : (
            <>
              <FormRow label="App ID">
                <FormInput value={newAppId} onChange={setNewAppId} placeholder={t.imChannel.appIdPlaceholder} mono />
              </FormRow>
              <FormRow label="App Secret">
                <FormInput type="password" value={newAppSecret} onChange={setNewAppSecret} placeholder={t.imChannel.appSecretPlaceholder} mono />
              </FormRow>
            </>
          )}

          {/* Capability */}
          <FormRow label={t.imChannel.capability}>
            <Select
              fullWidth
              label={t.imChannel.capability}
              value={newCapability}
              options={capabilityOptions}
              onValueChange={(v) => setNewCapability(v as IMCapabilityLevel)}
            />
          </FormRow>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowAddForm(false)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={
                !newName.trim() ||
                (newPlatform === 'wechat' ? !wechatCreds : !newAppId.trim() || !newAppSecret.trim())
              }
            >
              {t.common.save}
            </Button>
          </div>
        </div>
      )}

      <LanWebhookRow />
    </div>
  );
}

// ── Sub-components ──

/**
 * Where the callback endpoint listens — a section-wide network option, not a
 * property of one channel, so it sits below the channel list rather than in a
 * channel's editor.
 *
 * The restart note only appears once the value has actually been changed: at
 * rest the row is label + one line, and a note about restarting is noise until
 * there is something waiting for one.
 */
function LanWebhookRow() {
  const { t } = useI18n();
  const allowLanWebhook = useSettingsStore(s => s.imChannel.allowLanWebhook);
  const setIMAllowLanWebhook = useSettingsStore(s => s.setIMAllowLanWebhook);
  const [changed, setChanged] = useState(false);
  // Read once per render: the registry is a module-level map, not reactive
  // state, and it only changes when a plugin is installed or removed.
  const heartbeatWaiting = hasHeartbeatPlugin() && !allowLanWebhook;

  return (
    <div className="space-y-2">
      <SettingGroup>
        <SettingRow title={t.imChannel.allowLanWebhook} description={t.imChannel.allowLanWebhookHint} htmlFor={LAN_WEBHOOK_SWITCH_ID}>
          <Switch
            id={LAN_WEBHOOK_SWITCH_ID}
            checked={allowLanWebhook}
            onCheckedChange={() => {
              setIMAllowLanWebhook(!allowLanWebhook);
              setChanged(true);
            }}
          />
        </SettingRow>
      </SettingGroup>
      {heartbeatWaiting && (
        <p className="px-4 text-ui-sm text-label-tertiary">{t.imChannel.heartbeatRequiresLanWebhook}</p>
      )}
      {changed && (
        <p className="px-4 text-ui-sm text-label-tertiary">{t.imChannel.allowLanWebhookRestart}</p>
      )}
    </div>
  );
}

/** The platform of a new channel: side by side while they fit the control column, a select beyond that. */
function PlatformChoice({ value, onChange }: { value: IMPlatform; onChange: (platform: IMPlatform) => void }) {
  const { t } = useI18n();
  const options = getIMPlatformOptions();
  if (options.length > MAX_PLATFORM_SEGMENTS) {
    return <Select fullWidth label={t.imChannel.platform} value={value} options={options} onValueChange={(p) => onChange(p as IMPlatform)} />;
  }
  return <SegmentedControl label={t.imChannel.platform} value={value} onValueChange={(p) => onChange(p as IMPlatform)} options={options} />;
}

function PlatformBadge({ platform }: { platform: IMPlatform }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-fill text-ui-sm font-medium text-label-secondary">
      {getPlatformDisplayName(platform).slice(0, 2)}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'connected') return <StatusIcon tone="success" size="sm" />;
  if (status === 'error') return <StatusIcon tone="danger" size="sm" />;
  return <span className="size-2 shrink-0 rounded-full border border-control-border" />;
}

function WebhookUrlField({ url, hint, label }: { url: string; hint: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <FormRow label={label} hint={hint}>
      <div className="flex items-center gap-1">
        <code className="block min-w-0 flex-1 select-all truncate rounded-control bg-code px-2 py-1 font-code text-ui-sm text-label-secondary">
          {url}
        </code>
        <IconButton size="sm" icon={copied ? AppIcons.done : AppIcons.copy} label={t.chat.copy} onClick={handleCopy} />
      </div>
    </FormRow>
  );
}

function TagInput({
  label,
  hint,
  placeholder,
  values,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      e.preventDefault();
      if (!values.includes(input.trim())) {
        onChange([...values, input.trim()]);
      }
      setInput('');
    }
  };
  const removeTag = (tag: string) => onChange(values.filter(v => v !== tag));

  return (
    <FormRow label={label} hint={hint}>
      <div className="space-y-2">
        {values.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {values.map((v) => (
              <span key={v} role="group" aria-label={v} className="inline-flex items-center gap-1">
                <Tag>{v}</Tag>
                <IconButton size="sm" icon={AppIcons.close} label={t.common.delete} onClick={() => removeTag(v)} />
              </span>
            ))}
          </div>
        )}
        <TextField
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : ''}
        />
      </div>
    </FormRow>
  );
}

/**
 * WeChat-specific connection rows inside the expanded channel card.
 *
 * Shows bound account ID + status. If the session has expired (status=error),
 * surfaces an inline QR panel for re-binding without leaving the settings page.
 */
function WeChatConnectionRows({
  channel,
  onRebind,
}: {
  channel: Pick<IMChannel, 'appId' | 'appSecret' | 'status' | 'lastError'>;
  onRebind: (creds: WeChatCredentials) => void;
}) {
  const { t } = useI18n();
  const [showRebind, setShowRebind] = useState(false);

  const isExpired = channel.status === 'error';

  return (
    <>
      {/* Bound account ID (read-only) */}
      <FormRow label={t.imChannel.wechatAccount}>
        <code className="block w-full truncate rounded-control bg-code px-2 py-1 font-code text-ui-sm text-label-secondary">
          {channel.appId || '—'}
        </code>
      </FormRow>

      {/* Re-bind trigger — shown when session expired */}
      {isExpired && !showRebind && (
        <InlineMessage
          tone="danger"
          action={(
            <Button variant="plain" size="sm" icon={AppIcons.retry} onClick={() => setShowRebind(true)}>
              {t.imChannel.wechatRebind}
            </Button>
          )}
        >
          {t.imChannel.wechatSessionExpired}
        </InlineMessage>
      )}

      {/* Inline QR panel for re-binding */}
      {showRebind && (
        <WeChatQRPanel
          compact
          onBound={(creds) => {
            onRebind(creds);
            setShowRebind(false);
          }}
        />
      )}
    </>
  );
}
