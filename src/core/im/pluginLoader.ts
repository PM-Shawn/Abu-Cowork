/**
 * PluginLoader — Discover and load IM plugins from ~/.abu/plugins/
 *
 * Plugins are manifest-driven (JSON config, no executable code).
 * Each plugin directory contains:
 *   - manifest.json — platform metadata, API config, message format
 *   - config.json   — user credentials (clientId, clientSecret, etc.)
 *
 * The loader creates GenericPluginAdapter instances and registers them
 * into the plugin registry at app startup.
 */

import { readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath } from '../../utils/pathUtils';
import { registerIMPlugin } from './pluginRegistry';
import type { IMPluginManifest, IMPluginRegistration, PluginTokenResult } from './pluginRegistry';
import type { NormalizedIMMessage } from './inboundRouter';
import { GenericPluginAdapter } from './adapters/genericPlugin';
import { getTauriFetch } from '../llm/tauriFetch';
import { startPluginHeartbeat } from './pluginHeartbeat';

// ── Manifest Schema ──

export interface PluginManifestFile {
  platform: string;
  displayName: string;
  shortLabel: string;
  version?: string;
  description?: string;
  capabilities: {
    markdown: boolean;
    card: boolean;
    messageUpdate: boolean;
    connectionType: 'webhook' | 'websocket' | 'heartbeat';
  };
  /** API config for sending messages */
  send: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** Body template — {{token}}, {{chatId}}, {{content}}, {{title}} are replaced */
    bodyTemplate: Record<string, unknown>;
    /** JSON path to message ID in response (e.g. "data.message_id") */
    responseMessageIdPath?: string;
  };
  /** Token auth config */
  auth?: {
    type: 'oauth2_client_credentials' | 'basic' | 'bearer_static';
    tokenUrl?: string;
    /** JSON path to token in response */
    tokenPath?: string;
    /** JSON path to expiry in response (seconds) */
    expiresPath?: string;
    /** Request body template for token exchange */
    bodyTemplate?: Record<string, unknown>;
  };
  /** Inbound message field mappings (JSON paths) */
  inbound?: {
    text: string;
    senderId: string;
    senderName?: string;
    chatId: string;
    isDirect?: string;
    /** If this field is absent in payload, treat as DM (e.g. "channel_id") */
    isDirectAbsent?: string;
    isBotFilter?: string;
  };
  /** Heartbeat config for callback registration */
  heartbeat?: {
    url: string;
    intervalMs: number;
    authType?: 'basic' | 'bearer';
    bodyTemplate: Record<string, unknown>;
  };
  /** Max message length */
  maxLength?: number;
  chunkMode?: 'length' | 'newline';
}

// ── Plugin Discovery ──

const PLUGINS_DIR = 'plugins';

/**
 * Discover and load all IM plugins from ~/.abu/plugins/
 * Called once at app startup.
 */
export async function loadIMPlugins(): Promise<void> {
  try {
    const home = await homeDir();
    const pluginsPath = joinPath(home, '.abu', PLUGINS_DIR);

    let entries: { name: string; isDirectory: boolean }[];
    try {
      const dirEntries = await readDir(pluginsPath);
      entries = dirEntries
        .filter((e) => e.isDirectory)
        .map((e) => ({ name: e.name, isDirectory: true }));
    } catch {
      // No plugins directory — normal, skip silently
      return;
    }

    for (const entry of entries) {
      try {
        const pluginDir = joinPath(pluginsPath, entry.name);
        await loadSinglePlugin(pluginDir);
      } catch (err) {
        console.warn(`[PluginLoader] Failed to load plugin "${entry.name}":`, err);
      }
    }
  } catch (err) {
    console.warn('[PluginLoader] Plugin discovery failed:', err);
  }
}

async function loadSinglePlugin(pluginDir: string): Promise<void> {
  const manifestPath = joinPath(pluginDir, 'manifest.json');
  const manifestText = await readTextFile(manifestPath);
  const manifest = JSON.parse(manifestText) as PluginManifestFile;

  if (!manifest.platform || !manifest.displayName) {
    throw new Error('Invalid manifest: missing platform or displayName');
  }

  // Read optional user config
  let userConfig: Record<string, unknown> = {};
  try {
    const configPath = joinPath(pluginDir, 'config.json');
    const configText = await readTextFile(configPath);
    userConfig = JSON.parse(configText);
  } catch {
    // No config.json — ok, user hasn't configured yet
  }

  // Build adapter
  const adapter = new GenericPluginAdapter(manifest);

  // Build plugin manifest
  const pluginManifest: IMPluginManifest = {
    platform: manifest.platform,
    displayName: manifest.displayName,
    shortLabel: manifest.shortLabel || manifest.platform.slice(0, 2).toUpperCase(),
    capabilities: manifest.capabilities,
  };

  // Build registration
  const registration: IMPluginRegistration = {
    manifest: pluginManifest,
    adapter,
    parseInbound: (payload) => parseManifestInbound(manifest, payload),
  };

  // Add token fetcher based on auth type
  if (manifest.auth?.type === 'oauth2_client_credentials' && manifest.auth.tokenUrl) {
    registration.fetchToken = (appId, appSecret) =>
      fetchManifestToken(manifest, appId, appSecret);
  } else if (manifest.auth?.type === 'basic') {
    // Basic auth doesn't need token exchange — return a placeholder
    // The adapter handles Basic auth headers directly from userConfig
    registration.fetchToken = async () => ({
      token: 'basic-auth-no-token',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });
  }

  // Store user config on adapter for runtime access
  adapter.setUserConfig(userConfig);
  adapter.setManifest(manifest);

  registerIMPlugin(registration);

  // Start heartbeat if configured and user has provided credentials
  if (manifest.heartbeat && userConfig.botId) {
    startPluginHeartbeat(manifest, userConfig);
  }

  console.log(`[PluginLoader] Loaded plugin: ${manifest.displayName} (${manifest.platform})`);
}

// ── Manifest-Driven Operations ──

/**
 * Parse inbound webhook payload using manifest field mappings.
 */
function parseManifestInbound(
  manifest: PluginManifestFile,
  payload: Record<string, unknown>,
): NormalizedIMMessage | null {
  const mapping = manifest.inbound;
  if (!mapping) return null;

  const text = extractPath(payload, mapping.text);
  const senderId = extractPath(payload, mapping.senderId);
  if (!text || !senderId) return null;

  // Bot filter
  if (mapping.isBotFilter) {
    const isBot = extractPath(payload, mapping.isBotFilter);
    if (isBot === true || isBot === 'true') return null;
  }

  const chatId = extractPath(payload, mapping.chatId) ?? '';
  const senderName = mapping.senderName ? extractPath(payload, mapping.senderName) : senderId;
  // Detect DM: use manifest mapping, or check common "no group identifier" heuristic
  let isDirect = false;
  if (mapping.isDirect) {
    const directVal = extractPath(payload, mapping.isDirect);
    isDirect = directVal === 'direct' || directVal === 'p2p' || directVal === true;
  } else if (mapping.isDirectAbsent) {
    // Heuristic: if a specific field is absent, it's a DM (e.g. no channel_id = DM)
    isDirect = !extractPath(payload, mapping.isDirectAbsent);
  }

  // Extract message ID for dedup (try common field names)
  const messageId = String(
    extractPath(payload, 'message_key') ??
    extractPath(payload, 'message_id') ??
    extractPath(payload, 'msg_id') ??
    ''
  );

  // Mention detection: support standard @Name and DChat format @<=#botId=>
  const textStr = String(text);
  const botId = String(extractPath(payload, 'bot_id') ?? '');
  // DM is always treated as mention (user is talking directly to bot)
  const isMention = isDirect ||
    /(@Abu|@abu)/i.test(textStr) ||
    (!!manifest.displayName && new RegExp(`@${manifest.displayName}`, 'i').test(textStr)) ||
    (!!botId && textStr.includes(`@<=#${botId}=>`));

  // Clean mention tags: standard @name and DChat @<=#id=>
  const cleanText = textStr
    .replace(/@<=#\d+=>\s*/g, '')  // DChat format
    .replace(/@\S+\s*/g, '')       // standard format
    .trim();

  console.log(`[PluginParser] ${manifest.platform}: senderId=${senderId} text="${cleanText}" isMention=${isMention} isDirect=${isDirect} messageId=${messageId} raw=${JSON.stringify(payload).slice(0, 300)}`);

  return {
    senderId: String(senderId),
    senderName: String(senderName ?? senderId),
    text: cleanText || textStr,  // fallback to original if cleaning removes everything
    isMention,
    isDirect,
    chatId: String(chatId),
    platform: manifest.platform,
    replyContext: {
      platform: manifest.platform,
      chatId: String(chatId),
      messageId: messageId || undefined,
    },
    raw: payload,
  };
}

/**
 * Fetch access token using manifest auth config.
 */
async function fetchManifestToken(
  manifest: PluginManifestFile,
  appId: string,
  appSecret: string,
): Promise<PluginTokenResult> {
  const auth = manifest.auth;
  if (!auth?.tokenUrl) throw new Error('No tokenUrl in manifest');

  const bodyTemplate = auth.bodyTemplate ?? { app_id: '{{appId}}', app_secret: '{{appSecret}}' };
  const body = replaceTemplateVars(bodyTemplate, { appId, appSecret, token: '' });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Basic auth
  if (auth.type === 'basic') {
    headers['Authorization'] = `Basic ${btoa(`${appId}:${appSecret}`)}`;
  }

  const f = await getTauriFetch();
  const resp = await f(auth.tokenUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`[${manifest.platform}] Token fetch failed: HTTP ${resp.status}`);
  }

  const data = await resp.json() as Record<string, unknown>;

  const token = extractPath(data, auth.tokenPath ?? 'access_token');
  if (!token) {
    throw new Error(`[${manifest.platform}] Token not found at path: ${auth.tokenPath}`);
  }

  const expireSeconds = Number(extractPath(data, auth.expiresPath ?? 'expire') ?? 7200);

  return {
    token: String(token),
    expiresAt: Date.now() + expireSeconds * 1000,
  };
}

// ── Utilities ──

/**
 * Extract a value from a nested object using dot-notation path.
 * e.g. extractPath({ data: { id: 'x' } }, 'data.id') → 'x'
 */
function extractPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Replace {{var}} placeholders in a template object with actual values.
 */
function replaceTemplateVars(
  template: Record<string, unknown>,
  vars: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value === 'string') {
      let replaced = value;
      for (const [varName, varValue] of Object.entries(vars)) {
        replaced = replaced.replace(new RegExp(`\\{\\{${varName}\\}\\}`, 'g'), varValue);
      }
      result[key] = replaced;
    } else if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = replaceTemplateVars(value as Record<string, unknown>, vars);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export { extractPath, replaceTemplateVars };
