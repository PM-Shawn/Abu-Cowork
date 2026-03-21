import { useState, useRef, useEffect } from 'react';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useI18n } from '@/i18n';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { Plus, Trash2, ChevronDown, ChevronUp, Copy, Check, HelpCircle } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { Select } from '@/components/ui/select';
import type { IMPlatform } from '@/types/im';
import type { IMCapabilityLevel, IMResponseMode } from '@/types/imChannel';
import { getIMPlatformOptions, getPlatformDisplayName } from '@/core/im/platformLabels';

const CAPABILITY_OPTIONS: { value: IMCapabilityLevel; labelKey: keyof ReturnType<typeof useCapLabels> }[] = [
  { value: 'chat_only', labelKey: 'chat_only' },
  { value: 'read_tools', labelKey: 'read_tools' },
  { value: 'safe_tools', labelKey: 'safe_tools' },
  { value: 'full', labelKey: 'full' },
];

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
  const [showHint, setShowHint] = useState(false);
  const hintRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showHint) return;
    const handleClick = (e: MouseEvent) => {
      if (hintRef.current && !hintRef.current.contains(e.target as Node)) {
        setShowHint(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showHint]);

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="shrink-0 pt-1.5">
        <span className="inline-flex items-center gap-1 text-[13px] text-[var(--abu-text-tertiary)]">
          {label}
          {hint && (
            <div className="relative" ref={hintRef}>
              <button
                onClick={() => setShowHint(!showHint)}
                className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-muted)] transition-colors"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
              {showHint && (
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 w-52 px-3 py-2 rounded-lg bg-[var(--abu-text-primary)] text-white text-[11px] leading-relaxed shadow-lg z-[9999]">
                  {hint}
                  <div className="absolute right-full top-1/2 -translate-y-1/2 w-0 h-0 border-y-[5px] border-y-transparent border-r-[5px] border-r-[var(--abu-text-primary)]" />
                </div>
              )}
            </div>
          )}
        </span>
      </div>
      <div className="w-[340px] shrink-0">{children}</div>
    </div>
  );
}

/** Section group with optional title */
function FormGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {title && (
        <div className="text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider">{title}</div>
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
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full px-3 py-1.5 text-[13px] rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] focus:border-[var(--abu-clay-50)] focus:outline-none transition-colors ${mono ? 'font-mono' : ''}`}
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
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value) || min)}
      className="w-full px-3 py-1.5 text-[13px] rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] focus:border-[var(--abu-clay-50)] focus:outline-none transition-colors"
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

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add form state
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState<IMPlatform>('feishu');
  const [newAppId, setNewAppId] = useState('');
  const [newAppSecret, setNewAppSecret] = useState('');
  const [newCapability, setNewCapability] = useState<IMCapabilityLevel>('safe_tools');

  const channelList = Object.values(channels);
  const serverPort = triggerEngine.getServerPort() ?? 18080;

  const handleAdd = () => {
    if (!newName.trim() || !newAppId.trim() || !newAppSecret.trim()) return;
    addChannel({
      platform: newPlatform,
      name: newName.trim(),
      appId: newAppId.trim(),
      appSecret: newAppSecret.trim(),
      capability: newCapability,
    });
    setNewName('');
    setNewAppId('');
    setNewAppSecret('');
    setNewCapability('safe_tools');
    setShowAddForm(false);
  };

  const handleDelete = (id: string) => {
    if (confirm(t.imChannel.deleteConfirm)) {
      removeChannel(id);
      if (expandedId === id) setExpandedId(null);
    }
  };

  const getSessionCount = (channelId: string) =>
    Object.values(sessions).filter(s => s.channelId === channelId).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold text-[var(--abu-text-primary)]">{t.imChannel.title}</h3>
        <p className="text-xs text-[var(--abu-text-muted)] mt-1">{t.imChannel.description}</p>
      </div>

      {/* Channel List */}
      {channelList.length === 0 && !showAddForm && (
        <div className="p-8 rounded-xl border border-dashed border-[var(--abu-border-hover)] bg-[var(--abu-bg-muted)] text-center">
          <p className="text-sm text-[var(--abu-text-muted)]">{t.imChannel.noChannels}</p>
          <p className="text-xs text-[var(--abu-text-muted)] mt-1">{t.imChannel.noChannelsHint}</p>
        </div>
      )}

      {channelList.map((channel) => {
        const isExpanded = expandedId === channel.id;
        const sessionCount = getSessionCount(channel.id);
        const webhookUrl = `http://127.0.0.1:${serverPort}/im/${channel.platform}/webhook`;

        return (
          <div key={channel.id} className="rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] overflow-hidden">
            {/* Channel header row */}
            <div
              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--abu-bg-base)] transition-colors"
              onClick={() => setExpandedId(isExpanded ? null : channel.id)}
            >
              <PlatformBadge platform={channel.platform} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--abu-text-primary)] truncate">{channel.name}</span>
                  <StatusDot status={channel.status} />
                </div>
                <div className="flex items-center gap-3 text-xs text-[var(--abu-text-muted)] mt-0.5">
                  <span>{capLabels[channel.capability]}</span>
                  {sessionCount > 0 && (
                    <span>{t.imChannel.activeSessions}: {sessionCount}</span>
                  )}
                </div>
              </div>
              <Toggle
                checked={channel.enabled}
                onChange={() => {
                  updateChannel(channel.id, { enabled: !channel.enabled });
                }}
                size="sm"
              />
              {isExpanded ? (
                <ChevronUp className="h-4 w-4 text-[var(--abu-text-muted)] shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 text-[var(--abu-text-muted)] shrink-0" />
              )}
            </div>

            {/* Expanded detail — grouped layout */}
            {isExpanded && (
              <div className="border-t border-[var(--abu-border)] px-5 py-5 space-y-5">
                {/* Group 1: Connection */}
                <FormGroup title={t.imChannel.groupConnection}>
                  <FormRow label={t.imChannel.channelName}>
                    <FormInput
                      value={channel.name}
                      onChange={(v) => updateChannel(channel.id, { name: v })}
                    />
                  </FormRow>
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
                </FormGroup>

                <div className="border-t border-[var(--abu-bg-active)]" />

                {/* Group 2: Behavior */}
                <FormGroup title={t.imChannel.groupBehavior}>
                  <FormRow label={t.imChannel.responseMode} hint={<>{t.imChannel.responseMentionOnly}：{t.imChannel.responseMentionOnlyHint}<br/>{t.imChannel.responseAllMessages}：{t.imChannel.responseAllMessagesHint}</>}>
                    <Select
                      value={channel.responseMode ?? 'mention_only'}
                      options={[
                        { value: 'mention_only', label: t.imChannel.responseMentionOnly },
                        { value: 'all_messages', label: t.imChannel.responseAllMessages },
                      ]}
                      onChange={(v) => updateChannel(channel.id, { responseMode: v as IMResponseMode })}
                    />
                  </FormRow>
                  <FormRow label={t.imChannel.capability}>
                    <Select
                      value={channel.capability}
                      options={CAPABILITY_OPTIONS.map(o => ({ value: o.value, label: capLabels[o.value] }))}
                      onChange={(v) => updateChannel(channel.id, { capability: v as IMCapabilityLevel })}
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

                <div className="border-t border-[var(--abu-bg-active)]" />

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
                  <div className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                    {channel.lastError}
                  </div>
                )}

                {/* Delete button */}
                <div className="pt-1 border-t border-[var(--abu-bg-active)]">
                  <button
                    onClick={() => handleDelete(channel.id)}
                    className="flex items-center gap-2 text-xs text-red-400 hover:text-red-500 hover:bg-red-50 px-3 py-2 rounded-lg transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t.common.delete}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Add Channel Form */}
      {showAddForm && (
        <div className="rounded-xl border border-[var(--abu-clay-ring)] bg-[var(--abu-bg-muted)] p-5 space-y-5">
          <h4 className="text-sm font-medium text-[var(--abu-text-primary)]">{t.imChannel.addChannel}</h4>

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
            <div className="flex items-center gap-1.5 flex-wrap">
              {getIMPlatformOptions().map((p) => (
                <button
                  key={p.value}
                  onClick={() => setNewPlatform(p.value)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    newPlatform === p.value
                      ? 'border-[var(--abu-clay)] bg-[var(--abu-clay-bg)] text-[var(--abu-clay)] font-medium'
                      : 'border-[var(--abu-border)] text-[var(--abu-text-tertiary)] hover:border-[var(--abu-clay-50)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </FormRow>

          {/* App ID & Secret */}
          <FormRow label="App ID">
            <FormInput value={newAppId} onChange={setNewAppId} placeholder={t.imChannel.appIdPlaceholder} mono />
          </FormRow>
          <FormRow label="App Secret">
            <FormInput type="password" value={newAppSecret} onChange={setNewAppSecret} placeholder={t.imChannel.appSecretPlaceholder} mono />
          </FormRow>

          {/* Capability */}
          <FormRow label={t.imChannel.capability}>
            <Select
              value={newCapability}
              options={CAPABILITY_OPTIONS.map(o => ({ value: o.value, label: capLabels[o.value] }))}
              onChange={(v) => setNewCapability(v as IMCapabilityLevel)}
            />
          </FormRow>

          {/* Actions */}
          <div className="flex items-center gap-2 justify-end pt-2">
            <button
              onClick={() => setShowAddForm(false)}
              className="px-4 py-2 text-sm text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] rounded-lg transition-colors"
            >
              {t.common.cancel}
            </button>
            <button
              onClick={handleAdd}
              disabled={!newName.trim() || !newAppId.trim() || !newAppSecret.trim()}
              className="px-4 py-2 text-sm text-white bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t.common.save}
            </button>
          </div>
        </div>
      )}

      {/* Add button */}
      {!showAddForm && (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm text-[var(--abu-clay)] border border-dashed border-[var(--abu-clay-40)] rounded-xl hover:bg-[var(--abu-clay-5)] transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t.imChannel.addChannel}
        </button>
      )}
    </div>
  );
}

// ── Sub-components ──

function PlatformBadge({ platform }: { platform: IMPlatform }) {
  return (
    <div className="h-8 w-8 rounded-lg bg-[var(--abu-clay-bg)] flex items-center justify-center text-xs font-medium text-[var(--abu-clay)] shrink-0">
      {getPlatformDisplayName(platform).slice(0, 2)}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'connected' ? 'bg-green-400' : status === 'error' ? 'bg-red-400' : 'bg-[var(--abu-text-placeholder)]';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

function WebhookUrlField({ url, hint, label }: { url: string; hint: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <FormRow label={label} hint={hint}>
      <div className="relative">
        <code className="block w-full px-3 py-1.5 pr-9 text-[12px] bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg text-[var(--abu-text-tertiary)] truncate select-all font-mono">
          {url}
        </code>
        <button
          onClick={handleCopy}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--abu-bg-hover)] transition-colors"
          title="Copy"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />}
        </button>
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
      <div className="flex flex-wrap items-center gap-1.5 min-h-[34px] px-3 py-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)]">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-[var(--abu-clay-bg)] text-[var(--abu-clay)] rounded-md"
          >
            {v}
            <button onClick={() => removeTag(v)} className="hover:text-red-500">×</button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[80px] text-xs bg-transparent outline-none placeholder:text-[var(--abu-text-muted)]"
        />
      </div>
    </FormRow>
  );
}
