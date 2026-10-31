export interface Env {
  SITE_ORIGIN: string;
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
  OAUTH_CALLBACK_URL: string;
  COMPENDIUM_OWNER?: string;
  COMPENDIUM_REPO?: string;
  COMPENDIUM_REF?: string;
  COMPENDIUM_WORKFLOW?: string;
}

export interface Identity {
  id: number;
  login: string;
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
