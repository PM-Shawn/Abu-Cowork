import { useState, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { isMacOS } from '@/utils/platform';
import { Shield, ShieldAlert, Globe, Plus, X, Info } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { syncNetworkWhitelist } from '@/core/sandbox/config';

export default function SandboxSection() {
  const sandboxEnabled = useSettingsStore(s => s.sandboxEnabled);
  const setSandboxEnabled = useSettingsStore(s => s.setSandboxEnabled);
  const networkIsolationEnabled = useSettingsStore(s => s.networkIsolationEnabled);
  const setNetworkIsolationEnabled = useSettingsStore(s => s.setNetworkIsolationEnabled);
  const networkWhitelist = useSettingsStore(s => s.networkWhitelist);
  const setNetworkWhitelist = useSettingsStore(s => s.setNetworkWhitelist);
  const allowPrivateNetworks = useSettingsStore(s => s.allowPrivateNetworks);
  const setAllowPrivateNetworks = useSettingsStore(s => s.setAllowPrivateNetworks);
  const { t } = useI18n();
  const macOS = isMacOS();
  const [showWarning, setShowWarning] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [newDomain, setNewDomain] = useState('');

  const handleToggle = () => {
    if (sandboxEnabled) {
      setShowWarning(true);
    } else {
      setSandboxEnabled(true);
    }
  };

  const handleAddDomain = useCallback(() => {
    const trimmed = newDomain.trim();
    if (trimmed && !networkWhitelist.includes(trimmed)) {
      const updated = [...networkWhitelist, trimmed];
      setNetworkWhitelist(updated);
      syncNetworkWhitelist();
      setNewDomain('');
    }
  }, [newDomain, networkWhitelist, setNetworkWhitelist]);

  const handleRemoveDomain = useCallback((domain: string) => {
    const updated = networkWhitelist.filter(d => d !== domain);
    setNetworkWhitelist(updated);
    syncNetworkWhitelist();
  }, [networkWhitelist, setNetworkWhitelist]);

  const handlePrivateNetworkToggle = useCallback(() => {
    setAllowPrivateNetworks(!allowPrivateNetworks);
    syncNetworkWhitelist();
  }, [allowPrivateNetworks, setAllowPrivateNetworks]);

  const handleNetworkIsolationToggle = useCallback(() => {
    setNetworkIsolationEnabled(!networkIsolationEnabled);
  }, [networkIsolationEnabled, setNetworkIsolationEnabled]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--abu-text-tertiary)]">
        {t.settings.sandboxDescription}
      </p>

      {macOS ? (
        <>
          {/* Sandbox Toggle */}
          <button
            onClick={handleToggle}
            className={cn(
              'w-full flex items-center justify-between p-4 rounded-xl border transition-all text-left',
              sandboxEnabled
                ? 'border-emerald-500/50 bg-emerald-50'
                : 'border-[var(--abu-border)] bg-[var(--abu-bg-muted)]'
            )}
          >
            <div className="flex items-center gap-3">
              <Shield className={cn('h-5 w-5', sandboxEnabled ? 'text-emerald-600' : 'text-[var(--abu-text-muted)]')} />
              <div>
                <div className="flex items-center gap-1.5">
                  <p className={cn('text-sm font-medium', sandboxEnabled ? 'text-emerald-700' : 'text-[var(--abu-text-tertiary)]')}>
                    {t.settings.sandboxProtection}
                  </p>
                  <div
                    className="relative"
                    onMouseEnter={() => setShowDetails(true)}
                    onMouseLeave={() => setShowDetails(false)}
                  >
                    <Info className={cn('h-3.5 w-3.5 cursor-help', sandboxEnabled ? 'text-emerald-400' : 'text-[var(--abu-text-placeholder)]')} />
                    {showDetails && (
                      <div className="absolute left-1/2 -translate-x-1/2 top-6 z-50 w-72 p-3 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] shadow-lg text-left pointer-events-none">
                        <p className="text-[11px] text-[var(--abu-text-tertiary)] leading-relaxed">
                          {t.settings.sandboxProtectedPaths}
                        </p>
                        <div className="border-t border-[var(--abu-border)] my-1.5" />
                        <p className="text-[11px] text-[var(--abu-text-muted)] leading-relaxed">
                          {t.settings.sandboxWritablePaths}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">
                  {t.settings.sandboxProtectionDescription}
                </p>
              </div>
            </div>
            <Toggle
              checked={sandboxEnabled}
              onChange={handleToggle}
              size="md"
            />
          </button>

          {/* Network Isolation */}
          {sandboxEnabled && (
            <div className="space-y-3">
              <button
                onClick={handleNetworkIsolationToggle}
                className={cn(
                  'w-full flex items-center justify-between p-4 rounded-xl border transition-all text-left',
                  networkIsolationEnabled
                    ? 'border-blue-500/50 bg-blue-50'
                    : 'border-[var(--abu-border)] bg-[var(--abu-bg-muted)]'
                )}
              >
                <div className="flex items-center gap-3">
                  <Globe className={cn('h-5 w-5', networkIsolationEnabled ? 'text-blue-600' : 'text-[var(--abu-text-muted)]')} />
                  <div>
                    <p className={cn('text-sm font-medium', networkIsolationEnabled ? 'text-blue-700' : 'text-[var(--abu-text-tertiary)]')}>
                      {t.settings.networkIsolation}
                    </p>
                    <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">
                      {t.settings.networkIsolationDescription}
                    </p>
                  </div>
                </div>
                <Toggle
                  checked={networkIsolationEnabled}
                  onChange={handleNetworkIsolationToggle}
                  size="md"
                />
              </button>

              {/* Network whitelist config */}
              {networkIsolationEnabled && (
                <div className="space-y-3 p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
                  {/* Private networks toggle */}
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs text-[var(--abu-text-tertiary)]">
                      {t.settings.allowPrivateNetworks}
                    </span>
                    <Toggle
                      checked={allowPrivateNetworks}
                      onChange={handlePrivateNetworkToggle}
                      size="sm"
                    />
                  </label>

                  <div className="border-t border-[var(--abu-border)]" />

                  {/* Whitelist entries */}
                  <div>
                    <p className="text-xs text-[var(--abu-text-tertiary)] mb-2">{t.settings.networkWhitelist}</p>

                    {/* Default entries (read-only) */}
                    <div className="space-y-1 mb-2">
                      <p className="text-[10px] text-[var(--abu-text-muted)] uppercase tracking-wider">{t.settings.networkPreset}</p>
                      <p className="text-xs text-[var(--abu-text-muted)] leading-relaxed">
                        npm · PyPI · GitHub · GitLab · Anthropic · OpenAI · DeepSeek
                      </p>
                    </div>

                    {/* User entries */}
                    {networkWhitelist.length > 0 && (
                      <div className="space-y-1 mb-2">
                        <p className="text-[10px] text-[var(--abu-text-tertiary)] uppercase tracking-wider">{t.settings.networkCustom}</p>
                        {networkWhitelist.map(domain => (
                          <div key={domain} className="flex items-center justify-between py-1 px-2 rounded bg-[var(--abu-bg-muted)] group">
                            <span className="text-xs text-[var(--abu-text-primary)] font-mono">{domain}</span>
                            <button
                              onClick={() => handleRemoveDomain(domain)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-red-100"
                            >
                              <X className="h-3 w-3 text-red-500" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Add new entry */}
                    <div className="flex gap-2 mt-2">
                      <input
                        type="text"
                        value={newDomain}
                        onChange={e => setNewDomain(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleAddDomain()}
                        placeholder="*.company.com / 10.0.0.0/8"
                        className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-placeholder)] focus:outline-none focus:border-blue-400"
                      />
                      <button
                        onClick={handleAddDomain}
                        disabled={!newDomain.trim()}
                        className="px-2 py-1.5 rounded-lg bg-blue-500 text-white text-xs hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Disable confirmation dialog */}
          <ConfirmDialog
            open={showWarning}
            title={t.settings.sandbox}
            message={t.settings.sandboxDisableWarning}
            confirmText={t.common.confirm}
            cancelText={t.common.cancel}
            variant="danger"
            onConfirm={() => {
              setSandboxEnabled(false);
              setShowWarning(false);
            }}
            onCancel={() => setShowWarning(false)}
          />
        </>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-4 rounded-xl border border-amber-500/50 bg-amber-50">
            <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0" />
            <p className="text-sm text-amber-700 font-medium">
              {t.settings.sandboxMacOSOnly}
            </p>
          </div>
          <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-50">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="h-4 w-4 text-emerald-600 shrink-0" />
              <p className="text-xs text-emerald-700 font-medium">
                {t.settings.sandboxAppLayerProtection}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
