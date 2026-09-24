/**
 * App configuration carried by a plugin manifest's `app` field, and the team
 * files a package ships under `teams/`. Field names follow the developer spec
 * (docs/plugin-spec.md §6 and §8); validation lives in
 * `electron/shared/pluginAppSpec.mjs` so the installer, the authoring tool and
 * the marketplace check all apply the same rules.
 */

export type AppLocale = 'zh-CN' | 'en-US';

/** A plain string, or one string per locale (at least one locale present). */
export type LocalizedText = string | Partial<Record<AppLocale, string>>;

/** Who a scene (or the whole app) hands a conversation to. */
export type AppRunRef =
  | { team: string }
  | { expert: string }
  | { skill: string };

export type AppBuiltinNavTarget =
  | 'builtin:chat'
  | 'builtin:todos'
  | 'builtin:inbox'
  | 'builtin:team'
  | 'builtin:extensions'
  | 'builtin:automation';

export type AppNavTarget = AppBuiltinNavTarget | `url:${string}`;

export interface AppNavItem {
  id: string;
  title?: LocalizedText;
  icon?: string;
  order?: number;
  target: AppNavTarget;
}

export interface AppPromptTemplate {
  id: string;
  title: LocalizedText;
  prompt: LocalizedText;
}

export interface AppScene {
  id: string;
  title: LocalizedText;
  icon?: string;
  run?: AppRunRef;
  promptAppend?: string;
  placeholder?: LocalizedText;
  templates: AppPromptTemplate[];
}

export interface AppMode {
  modeId: string;
  title: LocalizedText;
  icon?: string;
  promptAppend?: string;
  scenes: AppScene[];
}

export interface AppHome {
  header?: { title?: LocalizedText; slogan?: LocalizedText };
  modes: { defaultSelected?: string; items: AppMode[] };
}

export interface AppConfig {
  version: 1;
  home: AppHome;
  defaultRun?: AppRunRef;
  promptAppend?: string;
  nav?: { items: AppNavItem[] };
  allowedOrigins?: string[];
  requiredConnectors?: string[];
  composer?: { placeholder?: LocalizedText };
}

/** `teams/<id>.json` as written by the package author. */
export interface PluginTeamFile {
  name: LocalizedText;
  leader: string;
  members: string[];
  leaderNote?: string;
  requirePlanApproval?: boolean;
  avatar?: string;
  description: LocalizedText;
  intro?: LocalizedText;
  expertise?: LocalizedText[];
  samplePrompts?: LocalizedText[];
}

/**
 * A team file after validation: member references resolved to role ids
 * (`plugin:<name>` for the package's own experts, `builtin:<name>` for Abu's).
 */
export interface ParsedPluginTeam {
  id: string;
  name: LocalizedText;
  leaderRoleId: string;
  memberRoleIds: string[];
  leaderNote?: string;
  requirePlanApproval: boolean;
  avatar?: string;
  description: LocalizedText;
  intro?: LocalizedText;
  expertise: LocalizedText[];
  samplePrompts: LocalizedText[];
}

/** An app the switcher can enter: an installed plugin with `app`, or the general shell. */
export interface AppDefinition {
  appId: string;
  name: string;
  description?: string;
  /** Absolute paths inside the installed package, or undefined. */
  logo?: string;
  logoDark?: string;
  config: AppConfig;
  pluginKey: string | null;
  pluginVersion: string | null;
}

export const GENERAL_APP_ID = '__general__';

/**
 * What a conversation remembers about the app it was started in: enough to
 * label it, to run it (the scene's `run`), and to build the prompt section —
 * captured at creation, so an app update or removal never rewrites an
 * existing conversation's behaviour.
 */
export interface ConversationAppBinding {
  version: 1;
  appId: string;
  pluginKey: string;
  pluginVersion: string;
  appName: string;
  appLogo?: string;
  appLogoDark?: string;
  modeId: string;
  sceneId?: string;
  run?: AppRunRef;
  /** App, mode and scene `promptAppend` joined with blank lines, in that order. */
  promptAppend?: string;
}
