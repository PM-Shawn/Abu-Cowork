/**
 * Apps (docs/app-spec.md) and the team files a plugin ships under `teams/`
 * (docs/plugin-spec.md §6). Validation lives in `electron/shared/appSpec.mjs`
 * and `electron/shared/pluginSpec.mjs`, so the renderer, the Electron hosts
 * and the marketplace check all apply the same rules.
 */

export type AppLocale = 'zh-CN' | 'en-US';

/** A plain string, or one string per locale (at least one locale present). */
export type LocalizedText = string | Partial<Record<AppLocale, string>>;

/**
 * Who a scene (or the whole app) hands a conversation to. Targets carry where
 * they come from: `builtin-team:` / `builtin:` (Abu), `plugin:<plugin>/…`,
 * `mine:` (the user's own), `enterprise-team:` / `enterprise-agent:` /
 * `enterprise:` (the organization). A team or an expert can bring a skill the
 * conversation starts with.
 */
export type AppRunRef =
  | { team: string; skill?: string }
  | { expert: string; skill?: string }
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

/** Display fields of an app file (`interface`). */
export interface AppInterface {
  displayName: string;
  shortDescription: string;
  longDescription?: string;
  developerName?: string;
  category?: string;
  brandColor?: string;
  logo?: string;
  logoDark?: string;
}

/** `.abu-app/app.json` after validation (`parseAppFile`). */
export interface ParsedAppFile {
  name: string;
  version: string;
  minAbuVersion: string;
  interface: AppInterface;
  /** Names of the plugins the app's references come from. */
  plugins: string[];
  config: AppConfig;
}

/**
 * Where an app came from: a market, a folder on this computer, 「创建应用」,
 * or the organization console. Decides the id, whether it can be updated, and
 * what an old conversation says once the app is gone.
 */
export type AppOrigin =
  | { kind: 'market'; market: string }
  | { kind: 'folder'; dir: string }
  | { kind: 'created'; authoringId: string }
  | { kind: 'enterprise' };

export type AppOriginKind = AppOrigin['kind'];

/** Where an app the user added on this computer came from (organization apps are not added). */
export type AddedAppOrigin = Exclude<AppOrigin, { kind: 'enterprise' }>;

/** An app the switcher can enter, or the general shell (`origin` null). */
export interface AppDefinition {
  appId: string;
  name: string;
  description?: string;
  /** Absolute paths to the app's own images, or undefined. */
  logo?: string;
  logoDark?: string;
  /** An emoji or an `icon:<icon>/<tint>` preset, as an organization sets it for its app. */
  icon?: string;
  config: AppConfig;
  /** The app's version; null for the general shell. */
  version: string | null;
  origin: AppOrigin | null;
  /** Plugins the app's `plugin:` references come from (by name). */
  plugins: string[];
}

export const GENERAL_APP_ID = '__general__';

/**
 * What a conversation remembers about the app it was started in: enough to
 * label it, to run it (the scene's `run`), and to build the prompt section —
 * captured at creation, so an app update or removal never rewrites an
 * existing conversation's behaviour.
 */
export interface ConversationAppBinding {
  version: 2;
  appId: string;
  appVersion: string;
  origin: AppOriginKind;
  appName: string;
  appLogo?: string;
  appLogoDark?: string;
  appIcon?: string;
  modeId: string;
  sceneId?: string;
  run?: AppRunRef;
  /** App, mode and scene `promptAppend` joined with blank lines, in that order. */
  promptAppend?: string;
}
