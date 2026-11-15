/**
 * The consumer languages, without a schema: modules that only list or check codes (the public
 * report page's first paint) import this instead of languages.ts, which brings in zod.
 */
// prettier-ignore
export const languages = [
  'en', 'de', 'es', 'es-mx', 'fr', 'it', 'ja', 'ko', 'pl',
  'pt-br', 'ru', 'zh-chs', 'zh-cht',
] as const;
export type Lang = (typeof languages)[number];
