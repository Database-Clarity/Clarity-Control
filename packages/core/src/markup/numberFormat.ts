import type { Lang } from '../languages.js';
import { numberSlots } from './numberSlots.js';

const commaLanguages = new Set<Lang>(['de', 'es', 'fr', 'it', 'pl', 'pt-br', 'ru']);
/** After variable expansion and maths only. Authoring text and liveDescriptions keep dots. */
export function formatNumbers(text: string, lang: Lang = 'en'): string {
  if (!commaLanguages.has(lang) || !/[.,]/.test(text)) return text;
  let output = '',
    at = 0;
  for (const slot of numberSlots(text)) {
    if (slot.kind === 'M') continue;
    const value = slot.value.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g, (number) =>
      number.replaceAll(',', '').replace('.', ','),
    );
    output += text.slice(at, slot.from) + value;
    at = slot.to;
  }
  return output + text.slice(at);
}
