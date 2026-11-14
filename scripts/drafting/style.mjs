// Owner-facing prose gates. Comments are source flags, never prose exemptions.
export const proseOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  .replace(/<[a-z][\w-]*\s*/gi, '').replace(/\/>/g, '').replace(/\[[#A-Za-z_][^\]]*\]/g, '');

const banned = [
  ['ability narration', /\b(?:throws?|performs?)\s+your\b/i],
  ['with Primary ammo', /\bwith\s+Primary\s+ammo\b/i],
  ['multiplier phrasing', /\bmultiplier\b/i],
  ['fixed energy', /\bfixed\b(?=[^\n.!]{0,70}\benergy\b)/i],
  ['damage over meters', /\bdamage[^\n.!]*?\bover\s+[\d.?+]+\s+meters\b/i],
  ['apply binary keyword', /\b(?:apply|applies|applying)\s+(?:Freeze|Blind|Suppression|Suspend)\b/i],
  ['capitalized additional', /\bAdditional\b/],
  ['plural firing burst', /\bbursts\s+of\b|\b(?:fires?|firing)\s+bursts\b/i],
  ['inflict phrasing', /\binflict(?:s|ing|ed)?\b/i],
  ['Beginning a manual action', /\bbeginning\s+(?:a\s+)?(?:manual\s+)?vent\b/i],
  ['mid-sentence Stacks or Mods', /\b(?:Stacks|Mods)\b/],
  ['redundant timing tail', /\b(?:of the first|of each other)\b/i],
  ['tick-count tail', /,\s*up to\s+[\d.?]+\s+times\b/i],
  ['bare rank threshold', /\b(?:Elite|Miniboss|Boss|T\d+)\s+(?:or|and)\s+higher\b/i],
];

export function styleLint(english) {
  const prose = proseOf(english);
  const errors = banned.filter(([, pattern]) => pattern.test(prose)).map(([label]) => `Style: ${label}`);
  for (const fragment of prose.matchAll(/\([^\n)]*\bwith\b[^\n)]*(?:Whisper of|Ember of|Spark of|Echo of|Thread of|Facet of)[^\n)]*\)/gi)) {
    if (/\+\s*[\d.?]/.test(fragment[0])) errors.push('Style: +X with fragment improvement');
    if (/\b(?:seconds?|s|meters?|m)\b/i.test(fragment[0])) errors.push('Style: units in fragment improvement');
  }
  const lines = prose.split('\n');
  const structural = (line) => /^\s*(?:•|\/\/|#|var\b|import\b|enhanced\s*\(|\)\s*$)/.test(line);
  for (let i = 1; i < lines.length; i++) {
    const before = lines[i - 1].trim();
    const after = lines[i].trim();
    if (before && after && !structural(before) && !structural(after) && !before.endsWith(':'))
      errors.push('Style: missing separator paragraph between prose blocks');
  }
  for (const paragraph of prose.split(/\n\s*\n/)) {
    if (/[.!?]\s+[\d.?]+\s*(?:second|s)\s+cooldown\b/i.test(paragraph))
      errors.push('Style: independent cooldown needs a separator paragraph');
  }
  for (const line of english.split('\n').entries()) {
    const [i, value] = line;
    if (/^\s*#(?:ChunkEnergy\w*|Reload)\s*$/.test(value) && i && english.split('\n')[i - 1].trim())
      errors.push('Style: missing separator paragraph before global disclaimer');
  }
  return [...new Set(errors)];
}

export function sourceMathFlags(item) {
  const text = item.source.text;
  const ticks = /up to\s+(\d+)\s*(?:\[[^\]]*\]\s*)?times/i.exec(text);
  const damage = /dealing\s+(\d+(?:\.\d+)?)\s*(?:\[[^\]]*\]\s*)?(?:Kinetic\s+)?Damage\s+every tick/i.exec(text);
  const total = /totall?ing\s+(\d+(?:\.\d+)?)/i.exec(text);
  if (ticks && damage && total && Number(ticks[1]) * Number(damage[1]) !== Number(total[1]))
    return ['The source total does not match its per-tick damage and tick count. Values are retained; the damage model needs verification.'];
  return [];
}
