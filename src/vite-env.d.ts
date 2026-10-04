/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONSOLE_URL?: string;
  readonly VITE_PERSONAL_ACCOUNT_SERVER_URL?: string;
  // Langfuse observability (Phase A self-test). Empty = observability disabled.
  readonly VITE_LANGFUSE_PUBLIC_KEY?: string;
  readonly VITE_LANGFUSE_SECRET_KEY?: string;
  readonly VITE_LANGFUSE_BASE_URL?: string;
  // "1" only in the local Electron dev build (preelectron:dev). Gates the developer design preview.
  readonly VITE_ABU_DESIGN_PREVIEW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
