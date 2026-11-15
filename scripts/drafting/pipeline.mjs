// Offline drafting policy. Matching, source ranges, schemas, and markup stay app-owned.
import { proseOf, itemStyleLint } from './style.mjs';
export const groups = [
  'Exotic Weapons',
  'Weapon Perks',
  'Armor Mods',
  'Subclass',
  'Set Bonuses',
  'Exotic Class Items',
];
// Owner 2026-11-15: moving to Inactive & Placeholders; no draft is needed.
export const ownerExcludedHashes = new Set([2077016094, 2733010662, 2734970071, 3458160468]);
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
  // Equipment names are stronger identities than thematic perk names (for
  // example Dragon's Shadow versus Wish-Dragon Teeth/Talons).
  const equipmentMatches = candidates.filter((base) =>
    ` ${normal(base.itemName ?? '')} `.includes(` ${stem} `),
  );
  const bases = new Map(
    (equipmentMatches.length ? equipmentMatches : candidates).map((base) => [
      canonicalHash(base.hash, editor),
      base,
    ]),
  );
  if (bases.size !== 1) return undefined;
  const [hash, base] = [...bases][0];
  const english = editor.bundle.tooltips[hash]?.text.en?.text;
  return english?.trim() ? { hash, name: base.itemName ?? base.name, english } : undefined;
}

export function buildInputs(
  editor,
  source,
  sourceCommit,
  app,
  { includeExoticWeapons = false } = {},
) {
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
    if (
      (!includeExoticWeapons && group === 'Exotic Weapons') ||
      ownerExcludedHashes.has(entry.hash)
    ) {
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
      enhancedCategory: app.categoriesWithEnhanced?.(editor).has(item.categoryId) ?? false,
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
        .replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, (value) => value.replaceAll(',', ''))
        .replace(/(<(?:title|link)\s+[^<>\n]*?)\s*\[[^\]]*\](\s*\/>)/g, '$1$2')
        .replace(/#[A-Za-z][A-Za-z0-9]*/g, '')
        .match(/\d+(?:\.\d+)?/g) ?? []
    ).map((n) => String(Number(n))),
  );

// Only the guide's named multiplier conversions justify a new numeric value.
// Keep their evidence attached to the metric and uncertainty, rather than
// adding a computed number to a general whitelist (which could justify damage).
export function convertedNumbers(source) {
  // Both endpoints inherit the explicitly written metric in a source range.
  const expanded = source.replace(
    /\b(0\.\d+)(\?)?x?\s*[–-]\s*(0\.\d+)(\?)?x\s+((?:[A-Za-z/-]+\s+){0,5}Duration(?:\s+Multiplier)?|Accuracy\s+Cone\s+Size(?:\s+Multiplier)?|Draw\s+Time(?:\s+Multiplier)?)/gi,
    (_, a, aq, b, bq, metric) => `${a}${aq ?? ''}x ${metric}; ${b}${bq ?? ''}x ${metric}`,
  );
  return [
    ...expanded.matchAll(
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
  errors.push(...itemStyleLint(item, english));
  if (/^\s*#Reload\s*$/m.test(english) && !/\breloads?\b/i.test(item.source.text))
    errors.push('Unsupported manual-reload claim: source does not say reload');
  if (/&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/i.test(english))
    errors.push('HTML entities in draft text; use raw characters');
  const exactOwnerRewrite = [item.ownerFeedback?.note ?? '', ...(item.ownerCorrections ?? [])].some(
    (note) => /^Rewritten version:\s*\n([\s\S]*)$/.exec(note)?.[1] === english,
  );
  if (
    english.length > 20000 ||
    (!exactOwnerRewrite && proseOf(english).length > Math.max(240, item.source.text.length * 1.5))
  )
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
  const ownerNote = item.ownerFeedback?.verdict === 'change' ? (item.ownerFeedback.note ?? '') : '';
  const allowed = new Set([
    ...numbers(item.source.text),
    ...numbers(ownerNote),
    ...numbers((item.ownerCorrections ?? []).join('\n')),
  ]);
  const conversions = convertedNumbers(item.source.text);
  // A conversion is allowed only in its correct phrase. Remove those phrases
  // before checking the remaining literal numbers, so the same number elsewhere
  // cannot borrow the conversion's evidence.
  // A named buff label is wording, not a borrowed stat value. Permit the
  // parent's exact Resist label only beside its identical sourced DR pair.
  const withParentLabels =
    item.category === 'armor-trait-exotic-class-item' && item.baseExotic
      ? english.replace(
          /(<pve\s+[\d.]+%\s*\/>\s*<pvp\s+\[[\d.]+%\]\s*\/>\s+Damage Resistance)\s+\((Resist x\d+)\)/g,
          (phrase, stat, label) =>
            item.baseExotic.english.includes(phrase) &&
            [...numbers(stat)].every((value) => numbers(item.source.text).has(value))
              ? phrase.replace(label, 'Resist')
              : phrase,
        )
      : english;
  const literalEnglish = withParentLabels.replace(
    /((?:\d+(?:\.\d+)?\??%?\s*[–|-]\s*)*\d+(?:\.\d+)?\??)%\s+decreased\s+([A-Za-z/ -]*?(?:Animation Duration|Accuracy Cone Size|Draw Time))/gi,
    (phrase, values, label) =>
      values.split(/\s*[–|-]\s*/).every((token) => {
        const [, value, question] = /^(\d+(?:\.\d+)?)(\?)?%?$/.exec(token) ?? [];
        return (
          value &&
          conversions.some(
            (conversion) =>
              conversion.value === String(Number(value)) &&
              conversion.uncertain === !!question &&
              normal(conversion.label) === normal(label),
          )
        );
      })
        ? phrase.replace(values, '')
        : phrase,
  );
  // Resulting fragment values require an explicit base+bonus from THIS cell and
  // a named supplemental fragment cell. Remove only that parenthetical result.
  const withRatios = literalEnglish.replace(
    /((?:\d+(?:\.\d+)?\??%\|)*\d+(?:\.\d+)?\??)% of (?:(?:its|the) )?(?:normal|base) (?:damage|(?:[A-Za-z ]+ )?rate)\b/gi,
    (phrase, values) =>
      values.split('|').every((value) => {
        const parsed = /^(\d+(?:\.\d+)?)(\?)?%?$/.exec(value);
        return (
          parsed &&
          [...item.source.text.matchAll(/\b(\d+(?:\.\d+)?)(\?)?x\b/g)].some(
            (match) =>
              Number((Number(match[1]) * 100).toFixed(8)) === Number(parsed[1]) &&
              !!match[2] === !!parsed[2],
          )
        );
      })
        ? phrase.replace(values, '')
        : phrase,
  );
  const withFragments = withRatios.replace(
    /\(([\d.]+)(\?)?\s+with\s+<\w+\s+([^<>]+?)\s*\/>\)/g,
    (phrase, total, question, name) =>
      (item.fragmentImprovements ?? []).some(
        (proof) =>
          proof.fragment === name &&
          proof.sourceText &&
          !question &&
          String(proof.total) === String(Number(total)) &&
          item.source.text.includes(`${proof.base}+${proof.bonus}`) &&
          Number(proof.base) + Number(proof.bonus) === Number(total),
      )
        ? phrase.replace(/[\d.]+/, '')
        : phrase,
  );
  // The owner-established Siphon family uses one count per source tier. This
  // licenses selector digits only, never those digits elsewhere in the prose.
  const withSelectors =
    item.category.startsWith('armor-mod') && /Siphon$/.test(item.name ?? '')
      ? withFragments.replace(/with 1\|2\|3 mods equipped/g, 'with mods equipped')
      : withFragments;
  const stackCap = /(?:maximum of|up to(?: a maximum of)?)\s+x?(\d+)\s+stacks?/i.exec(
    item.source.text,
  )?.[1];
  const withStackLabels =
    stackCap && Number(stackCap) <= 20
      ? withSelectors.replace(
          new RegExp(
            `at ${Array.from({ length: Number(stackCap) }, (_, n) => n + 1).join('\\|')} stacks`,
            'g',
          ),
          'at stacks',
        )
      : withSelectors;
  // An import identifier is a reference checked by the core parser, not a
  // numerical mechanic. Strip only the complete supported import declaration.
  // A source's explicit duration 'after a second' denotes one second. This
  // narrow normalization does not license indefinite stack/count numerals.
  const withDuration = /\bafter a second\b/i.test(item.source.text)
    ? withStackLabels.replace(/\bafter 1 second\b/gi, 'after a second')
    : withStackLabels;
  const mechanics = withDuration.replace(/^\s*import\s+\w+\s+from\s+\d+\s*$/gm, '');
  for (const number of numbers(mechanics))
    if (!allowed.has(number)) errors.push(`Unsupported number: ${number}`);
  // Exotic cross-references must both exist and be present in the supplied evidence.
  // Sheet spelling can put the possessive on another word of the same equipment
  // name (Young Ahamkara Spine's). Normalize that punctuation for identity only.
  const referenceNormal = (text) => normal(text.replace(/[’']s\b/gi, ''));
  const names = new Set(
    Object.values(editor.items)
      .flatMap((entry) => [entry.name, entry.itemName].filter(Boolean))
      .map(referenceNormal),
  );
  const evidence = referenceNormal(
    `${item.source.text} ${ownerNote} ${item.baseExotic?.english ?? ''} ${item.baseExotic?.name ?? ''}`,
  );
  for (const match of english.matchAll(/<yellow\s+(.+?)\s*\/>/g)) {
    const name = referenceNormal(match[1]);
    // Sheets often omit a leading article from the same canonical name.
    // Require complete words so 'staggers' cannot justify The Stag.
    const sourceNames = [name, ...(name.startsWith('the ') ? [name.slice(4)] : [])];
    if (
      !names.has(name) ||
      !sourceNames.some((candidate) =>
        [candidate, ...(!candidate.endsWith('s') ? [candidate + 's'] : [])].some((form) =>
          ` ${evidence} `.includes(` ${form} `),
        ),
      )
    )
      errors.push(`Unsupported item name: ${match[1]}`);
  }
  if (
    item.category !== 'weapon-trait' &&
    !item.enhancedCategory &&
    /\{\{|<enhanced\/>|^enhanced \(/m.test(english)
  )
    errors.push('Enhanced markup outside an enhanced-capable category');
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
