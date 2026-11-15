// Owner-facing prose gates. Comments are source flags, never prose exemptions.
export const proseOf = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<[a-z][\w-]*\s*/gi, '')
    .replace(/\/>/g, '')
    .replace(/\[[#A-Za-z_][^\]]*\]/g, '');

const banned = [
  ['HARD lowercase buffs and debuffs', /\b(?:Buffs?|Debuffs?)\b/],
  ['HARD Invisibility brevity', /\bVoid Invisibility\b/],
  ['HARD redundant impact-site radius', /\baround the impact site\b/i],
  [
    'HARD refresh terminology',
    /\b(?:restore|restores|reset|resets)\s+(?:its|the|their|the buff's)\s+duration\b/i,
  ],
  ['HARD source buff name', /\b4 stacks of Resist\b/i],
  ['HARD Upon opener', /^\s*Upon\b/im],
  ['HARD condition header', /^\s*(?:While|When|After|If|During|On|With)\b[^\n]*:\s*$/im],
  ['HARD comma condition prefix', /^\s*(?:After|While|When|Upon|If|During|With)\b[^\n,.!?]*,\s/im],
  ['HARD attached stack maximum', /,\s*up to\s+[\d.?]+\s+stacks?\b/i],
  ['HARD redundant duration refresh', /\bretriggering\s+refreshes?\s+the\s+duration\b/i],
  ['HARD damage instance', /\bdamage\s+instances?\b/i],
  ['HARD innate', /\binnate\b/i],
  [
    'total damage sum',
    /\btotal(?:s|ling|ing)?\b(?:(?!\bticks?\b)[^\n.!]){0,70}\bdamage\b|\bdamage\s+in\s+total\b/i,
  ],
  [
    'aggregate projectile damage sum',
    /\b(?:all|both)\s+(?:\d+\s+)?(?:seekers|projectiles|knives|blasts|explosions)\s+can\s+deal\s+up to\b/i,
  ],
  ['aggregate cloud damage sum', /\bcloud can deal up to [^\n]*\bdamage over [\d.?]+ seconds?\b/i],
  ['ambiguous field reference', /\bin the field\b/i],
  ['obsolete precision stat', /\bPrecision Angle Threshold\b/i],
  ['player distance wording', /\benemies\s+less than\s+[\d.?]+\s+meters\s+away\b/i],
  ['ability narration', /\b(?:throws?|performs?)\s+your\b/i],
  ['with Primary ammo', /\bwith\s+Primary\s+ammo\b/i],
  ['multiplier phrasing', /\bmultiplier\b/i],
  ['fixed energy', /\bfixed\b(?=[^\n.!]{0,70}\benergy\b)/i],
  ['damage over meters', /\bdamage[^\n.!]*?\bover\s+[\d.?+]+\s+meters\b/i],
  [
    'apply binary keyword',
    /\b(?:apply|applies|applying)\s+(?:Freeze|Blind|Suppression|Suspend)\b/i,
  ],
  ['capitalized additional', /\bAdditional\b/],
  ['plural firing burst', /\bbursts\s+of\b|\b(?:fires?|firing)\s+bursts\b/i],
  ['inflict phrasing', /\binflict(?:s|ing|ed)?\b/i],
  ['Beginning a manual action', /\bbeginning\s+(?:a\s+)?(?:manual\s+)?vent\b/i],
  ['redundant timing tail', /\b(?:of the first|of each other)\b/i],
  ['tick-count tail', /,\s*up to\s+[\d.?]+\s+times\b/i],
  ['bare rank threshold', /\b(?:Elite|Miniboss|Boss|T\d+)\s+(?:or|and)\s+higher\b/i],
];

export function styleLint(english) {
  const prose = proseOf(english);
  const errors = banned
    .filter(([, pattern]) => pattern.test(prose))
    .map(([label]) => `Style: ${label}`);
  for (const paragraph of prose.split(/\n\s*\n/))
    if ((paragraph.match(/^\s*• /gm) ?? []).length === 1)
      errors.push('Style: one-item list must be a sentence');
  if (/\b0\.03\s*(?:seconds?|s)\b(?!\s*\(one game tick\))/i.test(prose))
    errors.push('Style: identify the one-game-tick timing');
  for (const match of prose.matchAll(/\b(?:Stacks|Mods)\b/g)) {
    const prefix = prose.slice(0, match.index),
      before = prefix.trim();
    if (before && !/[.!?]$/.test(before) && !/\n\s*\n\s*$/.test(prefix))
      errors.push('Style: mid-sentence Stacks or Mods');
  }
  const untagged = english.replace(/<[^<>]*\/>/g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\bUnravel(?:ing)?\b/.test(untagged)) errors.push('Style: untagged Strand Unravel keyword');
  if (/\b(?:Unraveling|Unravelling) Projectiles\b/i.test(prose))
    errors.push('Style: use Unravel seekers');
  if (
    /\bCone Growth\b/.test(english) &&
    !/<title\s+[^<>]*Cone Growth\s+\[[^\]]+\]\s*\/>/.test(english)
  )
    errors.push('Style: Cone Growth needs its global title');
  for (const fragment of prose.matchAll(
    /\([^\n)]*\bwith\b[^\n)]*(?:Whisper of|Ember of|Spark of|Echo of|Thread of|Facet of)[^\n)]*\)/gi,
  )) {
    if (/\+\s*[\d.?]/.test(fragment[0])) errors.push('Style: +X with fragment improvement');
    if (/\b(?:seconds?|s|meters?|m)\b/i.test(fragment[0]))
      errors.push('Style: units in fragment improvement');
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
  const damage =
    /dealing\s+(\d+(?:\.\d+)?)\s*(?:\[[^\]]*\]\s*)?(?:Kinetic\s+)?Damage\s+every tick/i.exec(text);
  const total = /totall?ing\s+(\d+(?:\.\d+)?)/i.exec(text);
  if (ticks && damage && total && Number(ticks[1]) * Number(damage[1]) !== Number(total[1]))
    return [
      'The source total does not match its per-tick damage and tick count. Values are retained; the damage model needs verification.',
    ];
  return [];
}

export function itemStyleLint(item, english) {
  const errors = styleLint(english);
  if (
    item.enhancedCategory &&
    /\{\{|<enhanced\/>/.test(english) &&
    !/^enhanced \(\r?\n[\s\S]*?<enhanced\/>\s+[A-Za-z][^\n]*\r?\n\)/m.test(english)
  )
    errors.push('Style: enhanced value needs a separate enhanced-only explanation');
  if (
    item.enhancedCategory &&
    /^enhanced \([\s\S]*?<enhanced\/>[^\n]*\bincreased to\b/m.test(english)
  )
    errors.push('Style: enhanced explanation must state the change, not only the result');
  const enhancedBlock = /^enhanced \([\s\S]*?\n\)/m.exec(english)?.[0];
  if (
    item.enhancedCategory &&
    enhancedBlock &&
    !/\([^\n]*(?:<arrow\/>|→|->)[^\n]*\)/.test(enhancedBlock)
  )
    errors.push('Style: enhanced explanation needs (old to new) values');
  if (item.ownerFeedback?.verdict !== 'change') return errors;
  const rewrite = /^Rewritten version:\s*\n([\s\S]*)$/.exec(item.ownerFeedback.note ?? '');
  if (rewrite && english !== rewrite[1]) errors.push('Style: owner rewrite must be verbatim');
  if (item.name === "Riven's Curse") {
    if (!english.includes('with 1|2|3|4|5 mods equipped'))
      errors.push('Style: missing five-mod selector');
    if (!english.includes('Dreaming City')) errors.push('Style: missing Dreaming City restriction');
  }
  if (item.category.startsWith('armor-mod') && /Siphon$/.test(item.name ?? '')) {
    if (!/^import\b/m.test(english) || !/^var element\s*=/m.test(english))
      errors.push('Style: elemental Siphon needs canonical import and element override');
  }
  if (item.name === 'Stunloader') {
    if (!/\breserves\b/i.test(english)) errors.push('Style: refill reserves origin missing');
    if (!/\b60%/.test(english)) errors.push('Style: enhanced refill value missing');
    if (item.enhancedCategory && (!/\{\{/.test(english) || !/<enhanced\/>/.test(english)))
      errors.push('Style: use native base/enhanced markup and arrow');
  }
  return errors;
}
