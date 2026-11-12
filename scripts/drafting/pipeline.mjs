// Offline drafting policy. Matching, source ranges, schemas, and markup stay app-owned.
export const groups = [
  'Exotic Weapons',
  'Weapon Perks',
  'Armor Mods',
  'Subclass',
  'Set Bonuses',
  'Exotic Class Items',
];
export function groupFor(category) {
  if (
    [
      'weapon-exotic',
      'weapon-trait-exotic',
      'weapon-frame-exotic',
      'weapon-perk-exotic',
      'weapon-catalyst-exotic',
    ].includes(category)
  )
    return 'Exotic Weapons';
  if (
    ['weapon-trait', 'weapon-trait-origin', 'weapon-frame', 'weapon-perk', 'weapon-mod'].includes(
      category,
    )
  )
    return 'Weapon Perks';
  if (['armor-mod-general', 'armor-mod-combat', 'armor-mod-activity'].includes(category))
    return 'Armor Mods';
  if (category.startsWith('subclass-') || category === 'verbs') return 'Subclass';
  if (category === 'armor-set-bonus') return 'Set Bonuses';
  if (category === 'armor-trait-exotic-class-item') return 'Exotic Class Items';
}

const normal = (text) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function baseExoticFor(item, editor, canonicalHash) {
  const stem = normal(item.name.replace(/^Spirit of (the )?/i, ''));
  const candidates = Object.values(editor.items).filter(
    (base) =>
      base.categoryId === 'armor-trait-exotic' &&
      [base.name, base.itemName ?? ''].some((name) => ` ${normal(name)} `.includes(` ${stem} `)),
  );
  const bases = new Map(candidates.map((base) => [canonicalHash(base.hash, editor), base]));
  if (bases.size !== 1) return undefined;
  const [hash, base] = [...bases][0];
  const english = editor.bundle.tooltips[hash]?.text.en?.text;
  return english?.trim() ? { hash, name: base.itemName ?? base.name, english } : undefined;
}

export function buildInputs(editor, source, sourceCommit, app) {
  const evidence = app.reviewEvidence(editor, source, {}, '');
  const proposals = new Map(
    evidence.map((entry) => [entry.hash, app.proposalFor(entry.base, editor, source)]),
  );
  const display = app.displayMatches(
    editor,
    source,
    {},
    app.emptyProgress(),
    undefined,
    app.scope,
    proposals,
  );
  const counts = Object.fromEntries(
    groups.map((group) => [
      group,
      {
        eligible: 0,
        hasText: 0,
        noMatch: 0,
        uncertainOnly: 0,
        excludedByGuide: 0,
        invalidSource: 0,
      },
    ]),
  );
  const items = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of evidence) {
    const item = app.itemFor(entry.hash, editor);
    if (!item || app.canonicalHash(entry.hash, editor) !== entry.hash || seen.has(entry.hash))
      continue;
    seen.add(entry.hash);
    const group = groupFor(item.categoryId);
    if (!group) continue;
    const skip = (reason) => {
      counts[group][reason]++;
      skipped.push({ hash: entry.hash, name: entry.name, group, reason });
    };
    if (group === 'Exotic Weapons') {
      skip('excludedByGuide');
      continue;
    }
    if (entry.base.text.en?.text?.trim()) {
      skip('hasText');
      continue;
    }
    // Saved links win over automatic proposals, exactly as in the pane. Stale saved
    // links never silently fall back to a different automatic candidate.
    const resolution = entry.base.compendium
      ? app.resolveCompendiumLink(entry.base.compendium, source)
      : display.matches.get(entry.hash);
    if (!resolution || !('row' in resolution)) {
      skip(proposals.get(entry.hash)?.candidates.length ? 'uncertainOnly' : 'noMatch');
      continue;
    }
    const location = app.matchLocation(resolution, source);
    const range = location.range;
    const text = range && app.rangeText(source, location.gid, range);
    if (
      !range ||
      !/^[A-Z]+\d+(?::[A-Z]+\d+)?(?:, [A-Z]+\d+(?::[A-Z]+\d+)?)*$/.test(range) ||
      !text ||
      text.replace(/\s+/g, ' ').trim() !== resolution.row.cell.plain.replace(/\s+/g, ' ').trim()
    ) {
      skip('invalidSource');
      continue;
    }
    counts[group].eligible++;
    items.push({
      hash: entry.hash,
      name: item.name,
      category: item.categoryId,
      group,
      source: { tab: location.tab, gid: location.gid, range, text },
      sourceCommit,
      bundleHashExists: !!editor.bundle.tooltips[entry.hash],
      ...(group === 'Exotic Class Items'
        ? { baseExotic: baseExoticFor(item, editor, app.canonicalHash) ?? null }
        : {}),
    });
  }
  return { items, counts, skipped };
}

// Compare numeric tokens rather than substrings: 12 cannot justify 2. Markup
// identifiers and link targets are syntax, not game numbers.
export const numbers = (text) =>
  new Set(
    (
      text
        .replace(/(<(?:title|link)\s+[^<>\n]*?)\s*\[[^\]]*\](\s*\/>)/g, '$1$2')
        .replace(/#[A-Za-z][A-Za-z0-9]*/g, '')
        .match(/\d+(?:\.\d+)?/g) ?? []
    ).map((n) => String(Number(n))),
  );

// Only the guide's named multiplier conversions justify a new numeric value.
// Keep their evidence attached to the metric and uncertainty, rather than
// adding a computed number to a general whitelist (which could justify damage).
export function convertedNumbers(source) {
  return [
    ...source.matchAll(
      /\b(0\.\d+)(\?)?x\s+((?:[A-Za-z/-]+\s+){0,5}Duration(?:\s+Multiplier)?|Accuracy\s+Cone\s+Size(?:\s+Multiplier)?|Draw\s+Time(?:\s+Multiplier)?)/gi,
    ),
  ].map((match) => {
    const metric = match[3]
      .replace(/\s+Multiplier$/i, '')
      .replace(/\s+Animation(?= Duration$)/i, '');
    const label = /Duration$/i.test(metric)
      ? metric.replace(/Duration$/i, 'Animation Duration')
      : metric;
    return {
      value: String(Number(((1 - Number(match[1])) * 100).toFixed(8))),
      uncertain: !!match[2],
      label,
    };
  });
}
export function validateDraft(item, english, editor, app) {
  if (typeof english !== 'string' || !english.trim()) return ['Missing English'];
  const errors = [];
  if (english.length > 20000 || english.length > Math.max(240, item.source.text.length * 1.5))
    errors.push('Length sanity');
  const imports = app.tooltipImports(editor.bundle.tooltips, {}, 'en', editor.aliases);
  const globals = {
    variables: imports[2] ?? '',
    titles: imports[3] ?? '',
    imports,
    type: item.category === 'weapon-trait' ? 'Weapon Trait' : '',
  };
  errors.push(
    ...app
      .parseMarkup(english, globals)
      .diagnostics.filter((d) => d.severity === 'error')
      .map((d) => d.message),
  );
  if (app.retiredWarnings(english).length) errors.push('Retired markup');
  // Class-item wording may come from the base, but its values must come from the cell (guide A1).
  const ownerNote = item.ownerFeedback?.verdict === 'change' ? item.ownerFeedback.note ?? '' : '';
  const allowed = new Set([...numbers(item.source.text), ...numbers(ownerNote)]);
  const conversions = convertedNumbers(item.source.text);
  // A conversion is allowed only in its correct phrase. Remove those phrases
  // before checking the remaining literal numbers, so the same number elsewhere
  // cannot borrow the conversion's evidence.
  const literalEnglish = english.replace(
    /(\d+(?:\.\d+)?)(\?)?%\s+decreased\s+([A-Za-z/ -]*?(?:Animation Duration|Accuracy Cone Size|Draw Time))/gi,
    (phrase, value, question, label) =>
      conversions.some(
        (conversion) =>
          conversion.value === String(Number(value)) &&
          conversion.uncertain === !!question &&
          normal(conversion.label) === normal(label),
      )
        ? phrase.replace(/\d+(?:\.\d+)?/, '')
        : phrase,
  );
  for (const number of numbers(literalEnglish))
    if (!allowed.has(number)) errors.push(`Unsupported number: ${number}`);
  // Exotic cross-references must both exist and be present in the supplied evidence.
  const names = new Set(
    Object.values(editor.items)
      .flatMap((entry) => [entry.name, entry.itemName].filter(Boolean))
      .map(normal),
  );
  const evidence = normal(
    `${item.source.text} ${ownerNote} ${item.baseExotic?.english ?? ''} ${item.baseExotic?.name ?? ''}`,
  );
  for (const match of english.matchAll(/<yellow\s+(.+?)\s*\/>/g)) {
    const name = normal(match[1]);
    if (!names.has(name) || !evidence.includes(name))
      errors.push(`Unsupported item name: ${match[1]}`);
  }
  if (item.category !== 'weapon-trait' && /\{\{|^enhanced \(/m.test(english))
    errors.push('Enhanced markup outside weapon-trait');
  return [...new Set(errors)];
}

export function selectSample(items, perGroup = 6) {
  return groups.flatMap((group) =>
    items
      .filter((item) => item.group === group)
      .sort((a, b) => Number(!!b.baseExotic) - Number(!!a.baseExotic) || a.hash - b.hash)
      .slice(0, perGroup),
  );
}

export const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function sampleHtml(items, drafts, errors) {
  const e = escapeHtml;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bulk drafting sample</title>
<style>body{font:14px system-ui;margin:24px;max-width:1500px;background:#17191d;color:#eee}article{border-top:1px solid #555;padding:16px 0}.columns{display:grid;grid-template-columns:1fr 1fr;gap:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;margin:8px 0}h2{font-size:17px}h3{font-size:14px;color:#bbb}a{color:#9cc7ff}.fail{color:#ff9b9b}@media(max-width:700px){.columns{grid-template-columns:1fr}}</style>
<h1>Bulk drafting sample</h1><p>Suggestions only. Drafts are shown as raw Clarity markup, beside their exact Compendium source. Exotic Weapons are excluded by style guide v4.5. Class item base wording appears beneath its draft.</p>
${items.map((item) => `<article><h2>${e(item.name)} · ${e(item.group)} · ${item.hash}</h2><a href="https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/edit#gid=${encodeURIComponent(item.source.gid)}&amp;range=${encodeURIComponent(item.source.range.split(', ')[0])}">${e(item.source.tab)} · ${e(item.source.range)}</a><div class="columns"><section><h3>Compendium source</h3><pre>${e(item.source.text)}</pre></section><section><h3>Suggested draft</h3><pre>${e(drafts[item.hash] ?? 'DROPPED')}</pre>${errors[item.hash]?.length ? `<p class="fail">${e(errors[item.hash].join('; '))}</p>` : ''}${item.baseExotic ? `<h3>Base exotic: ${e(item.baseExotic.name)}</h3><pre>${e(item.baseExotic.english)}</pre>` : ''}</section></div></article>`).join('\n')}`;
}
