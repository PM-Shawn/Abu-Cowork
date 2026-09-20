/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONSOLE_URL?: string;
  readonly VITE_PERSONAL_ACCOUNT_SERVER_URL?: string;
  // Langfuse observability (Phase A self-test). Empty = observability disabled.
  readonly VITE_LANGFUSE_PUBLIC_KEY?: string;
  readonly VITE_LANGFUSE_SECRET_KEY?: string;
  readonly VITE_LANGFUSE_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
