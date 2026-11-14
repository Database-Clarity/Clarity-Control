import { markupImports } from '../markup/prepare.js';

// Compendium approval equivalence only; never use for publication or source hashes.
export function normaliseCompendiumEnglish(text: string): string {
  if (!text.includes('<enhanced/>')) return text;
  const imports = markupImports(text).length > 0;
  const numericVariable = /^\s*var\s+e\d\w*\s*=/m.test(text);
  return text.replace(/<enhanced\/>(?![a-zA-Z])/g, (tag, offset: number) => {
    // Historical #eN arrows exist, but imports can supply a user variable.
    // Without resolving the import closure, numeric equivalence must fail closed.
    const number = /^\d+/.exec(text.slice(offset + tag.length))?.[0];
    return number && (imports || numericVariable) ? tag : '#e';
  });
}
