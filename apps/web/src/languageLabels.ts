const names: Record<string, string> = {
  en: 'English', de: 'German', es: 'Spanish', 'es-mx': 'Spanish (Mexico)',
  fr: 'French', it: 'Italian', ja: 'Japanese', ko: 'Korean', pl: 'Polish',
  'pt-br': 'Portuguese (Brazil)', ru: 'Russian', 'zh-chs': 'Chinese (Simplified)',
  'zh-cht': 'Chinese (Traditional)',
};

export function languageLabel(code: string): string {
  return Object.hasOwn(names, code) ? names[code] : (code || 'Unknown language');
}
