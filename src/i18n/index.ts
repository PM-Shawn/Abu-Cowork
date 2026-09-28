/**
 * i18n Core Module
 * Lightweight internationalization for Abu
 *
 * Features:
 * - System language detection
 * - User language preference (via settingsStore)
 * - Full type safety with TranslationDict
 * - React hook (useI18n) and standalone (getI18n) access
 */

import { useSyncExternalStore } from 'react';
import type { SupportedLocale, LanguageSetting, TranslationDict } from './types';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

// Locale dictionary map
const locales: Record<SupportedLocale, TranslationDict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/**
 * Detect system locale from browser
 * Returns 'zh-CN' for Chinese locales, 'en-US' otherwise
 */
export function detectSystemLocale(): SupportedLocale {
  const lang = navigator.language || (navigator as { userLanguage?: string }).userLanguage || 'en';
  return lang.startsWith('zh') ? 'zh-CN' : 'en-US';
}

// Internal state management for language
let currentLanguageSetting: LanguageSetting = 'system';
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

/**
 * Get the resolved locale based on language setting
 */
export function getResolvedLocale(setting: LanguageSetting = currentLanguageSetting): SupportedLocale {
  if (setting === 'system') {
    return detectSystemLocale();
  }
  return setting;
}

/**
 * Set language preference (called by settingsStore)
 */
export function setLanguage(setting: LanguageSetting) {
  if (currentLanguageSetting !== setting) {
    currentLanguageSetting = setting;
    emitChange();
  }
}

/**
 * Get current language setting
 */
export function getLanguageSetting(): LanguageSetting {
  return currentLanguageSetting;
}

/**
 * Initialize language from stored setting
 * Called during app startup
 */
export function initLanguage(setting: LanguageSetting) {
  // Hydration can finish after React has subscribed (for example, while a
  // migrated settings write waits for its lock). Notify those consumers too.
  setLanguage(setting);
}

/**
 * Notified whenever the language setting changes. Backs `useI18n` for React
 * and lets non-React code (the plugin team loader) re-resolve locale-bound
 * text.
 */
export function subscribeLanguage(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

const subscribe = subscribeLanguage;

function getSnapshot(): LanguageSetting {
  return currentLanguageSetting;
}

/**
 * Get translation dictionary for current locale
 * For use outside React components
 */
export function getI18n(): TranslationDict {
  const locale = getResolvedLocale();
  return locales[locale];
}

/**
 * Get current locale code
 * For use outside React components
 */
export function getLocale(): SupportedLocale {
  return getResolvedLocale();
}

/**
 * Format string with placeholders
 * Example: format("{count} files", { count: 5 }) => "5 files"
 */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

/**
 * React hook for i18n
 * Returns translation dictionary and utilities
 *
 * Usage:
 * ```tsx
 * const { t, locale, format } = useI18n();
 * <span>{t.sidebar.newTask}</span>
 * <span>{format(t.task.createdFiles, { count: 3 })}</span>
 * ```
 */
export function useI18n() {
  const setting = useSyncExternalStore(subscribe, getSnapshot);
  const locale = getResolvedLocale(setting);
  const t = locales[locale];

  return {
    /** Translation dictionary with full type safety */
    t,
    /** Current resolved locale code */
    locale,
    /** Current language setting ('system' | 'zh-CN' | 'en-US') */
    setting,
    /** Format string with placeholders */
    format,
  };
}

// Re-export types
export type { SupportedLocale, LanguageSetting, TranslationDict };
