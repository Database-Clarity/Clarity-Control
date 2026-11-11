export interface Env {
  REPORTS_DB?: import('./reports.js').ReportsDatabase;
  REPORTS_FILES_DB?: import('./reports.js').ReportsDatabase;
  TURNSTILE_SECRET?: string;
  /** Local development only; never set on the production Worker/widget. */
  REPORTS_ALLOW_LOCALHOST?: string;
  SITE_ORIGIN: string;
  /** Extra allowed site origins, comma-separated (CORS and sign-in return); `SITE_ORIGIN` is always allowed. */
  SITE_ORIGINS?: string;
  SITE_URL: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  DATA_BRANCH: string;
  LIVE_BRANCH: string;
  GENERATOR_OWNER: string;
  GENERATOR_REPO: string;
  GENERATOR_BRANCH: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_SLUG: string;
  GITHUB_INSTALLATION_ID: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_PRIVATE_KEY: string;
  SESSION_SECRET: string;
  /** Enable-time Ed25519 PKCS8 PEM secret; absent during the write-disabled rollout. */
  PUBLISH_SIGNING_KEY?: string;
  OAUTH_CALLBACK_URL: string;
  COMPENDIUM_OWNER?: string;
  COMPENDIUM_REPO?: string;
  COMPENDIUM_REF?: string;
  COMPENDIUM_WORKFLOW?: string;
  /** Branch for encrypted synced settings; defaults to `editor-settings`. */
  SETTINGS_BRANCH?: string;
}

export interface Identity {
  id: number;
  login: string;
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
