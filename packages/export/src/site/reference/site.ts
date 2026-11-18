import type { FormatV1File } from '../../v1/compile.js';
import { exportLanguages, styles, symbolIds } from '../../v1/vocabulary.js';
import { styleFormats } from '../../v1/styles.js';
import { decodeV1 } from '../../../decoder/decode-v1.mjs';
import assets from './assets.json';
import { rendererSource } from './renderer.js';
import { pageCss, themeTokens, tooltipCss } from './styles.js';
import { features, featureTable, formatSchema } from './features.js';
import { behaviorSource, pageSource } from './behaviors.js';

const bytes = (value: string) => Buffer.from(value, 'utf8');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const html = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const embedded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
const code = (value: string, id?: string) =>
  `<pre${id ? ` id="${id}"` : ''}><code>${html(value)}</code></pre>`;
const example = (id: string, value: unknown) =>
  `<script type="application/json" data-example="${id}">${embedded(value)}</script>`;
const credit =
  'Credit Clarity as the external source, link https://d2clarity.com, and link https://d2clarity.com/discord for tooltip feedback. Clearly label your changes to the data, and keep cached copies updated. See https://www.d2clarity.com/partnerships for the full requirements.';
const creditHtml =
  '<p>Credit <a href="https://d2clarity.com">Clarity</a> as the external source, and include <a href="https://d2clarity.com/discord">Discord for tooltip feedback</a>. Label changes you make, and keep local copies current. <a href="https://www.d2clarity.com/partnerships">Full data usage requirements</a>.</p>';
const bungiePolicy = 'https://www.bungie.net/7/en/Legal/IntellectualPropertyTrademarks';
const bungieCredit =
  'Destiny symbols (the symbol SVGs and DestinySymbols font) are (c) Bungie, Inc. and used under Bungie\'s fan content policy';
const bungieCreditNote = `${bungieCredit}: ${bungiePolicy}.`;
function compactExample(value: unknown) {
  const line = value as { parts?: unknown[]; style?: string[] };
  if (!line.parts) return JSON.stringify(value);
  return `{\n${line.style ? '  "style": ' + JSON.stringify(line.style) + ',\n' : ''}  "parts": [\n    ${line.parts.map((part) => JSON.stringify(part)).join(',\n    ')}\n  ]\n}`;
}
function symbolRulesTable() {
  return `<div class="table-wrap"><table class="symbol-rules"><thead><tr><th>Symbol</th>${styles.map((style) => `<th>${style}</th>`).join('')}</tr></thead><tbody>${symbolIds
    .map(
      (symbol) =>
        `<tr><th>${symbol}</th>${styles
          .map((style) => {
            const rule = styleFormats[style].symbols[symbol];
            return `<td>${rule?.mode === 'replace' ? `<code>${html(rule.before + (rule.after ? '…' + rule.after : ''))}</code>` : rule?.mode === 'keep' ? 'Kept' : 'Dropped'}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}
function assetDownloads(kit: ReadonlyMap<string, Uint8Array>) {
  const groups = [
    [
      'Symbols',
      'symbols/',
      'Light and dark SVGs, the symbol font, and its complete glyph map. See usage.json for source attribution and unverified redistribution terms.',
    ],
    [
      'Clarity Cut fonts',
      'brand/ClarityCut/',
      'Variable wght and static weights in TTF and WOFF2. Keep OFL.txt and FONTLOG.md beside the fonts.',
    ],
    [
      'Brand assets',
      'brand/',
      'Approved k75 lockups, marks, brand colours, and semantic theme tokens. Preserve SVG proportions and use the matching theme variant.',
    ],
    [
      'Reference code and metadata',
      '',
      'Renderer, decoder, display examples, schema, feature table, licences, credit rules, and asset notes. Code is MIT; artwork and fonts have separate terms.',
    ],
  ];
  const remaining = new Set(kit.keys());
  return groups
    .map(([title, prefix, note]) => {
      const paths = [...remaining].filter((path) => path.startsWith(prefix)).sort();
      paths.forEach((path) => remaining.delete(path));
      return `<h3>${title}</h3><p>${note}</p><ul class="asset-list">${paths.map((path) => `<li><a href="kit/${encodeURI(path)}" download>${html(path.slice(prefix.length))}</a></li>`).join('')}</ul>`;
    })
    .join('');
}
const mit = `MIT License

Copyright (c) 2022 Icemourne

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// A deterministic store-only ZIP: no platform-dependent compression, timestamps, or tooling.
export function kitZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [path, value] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const name = bytes(path),
      data = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(33, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, name, data);
    central.push(entry, name);
    offset += head.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const proposals = [
  {
    id: 'DI-P1',
    group: 'Desktop, interactive',
    title: 'Popover on hover',
    hint: 'Hover or focus a note. Escape closes it. Links open normally.',
    mode: 'popover',
  },
  {
    id: 'DI-P3',
    group: 'Desktop, interactive',
    title: 'Expand in place',
    hint: 'Activate a note to show its text below that line; activate again to collapse it.',
    mode: 'expand',
  },
  {
    id: 'DN-P1',
    group: 'Desktop, non-interactive',
    title: 'Hold a key',
    hint: 'Hover or focus this example, then hold D for details. Release D to hide them. Use footnotes when a host cannot read a key.',
    mode: 'hold',
  },
  {
    id: 'DN-P2',
    group: 'Desktop, non-interactive',
    title: 'Footnotes',
    hint: 'Details always follow the text. Nothing inside the tooltip takes focus.',
    mode: 'footnotes',
  },
  {
    id: 'TI-P1',
    group: 'Touch, interactive',
    title: 'Bottom sheet',
    hint: 'Tap an underlined word to open details in a sheet. Close or Escape returns focus.',
    mode: 'sheet',
  },
  {
    id: 'TI-P2',
    group: 'Touch, interactive',
    title: 'Expand in place',
    hint: 'Tap a note to expand it below its line; tap it again to collapse it.',
    mode: 'expand',
  },
  {
    id: 'TN-P1',
    group: 'Touch, non-interactive',
    title: 'Tap the perk again',
    hint: 'The tooltip is already open. Tap its perk button again to toggle details outside the non-interactive content.',
    mode: 'tap',
  },
  {
    id: 'TN-P2',
    group: 'Touch, non-interactive',
    title: 'Footnotes',
    hint: 'Details stay visible beneath the tooltip, with addresses written out.',
    mode: 'footnotes',
  },
  {
    id: 'TN-P3',
    group: 'Touch, non-interactive',
    title: 'Long-press',
    hint: 'Hold the perk button for half a second. Movement cancels the gesture. Enter also opens details; Escape hides them.',
    mode: 'long',
  },
];

/** Built by the installed build-site bundle, using the actual bytes built by its pinned engine. */
export function referenceSite(
  read: (path: string) => Uint8Array | undefined,
): Map<string, Uint8Array> {
  const output = new Map<string, Uint8Array>();
  const put = (path: string, value: unknown) =>
    output.set(path, bytes(typeof value === 'string' ? value : json(value)));
  const kit = new Map<string, Uint8Array>();
  for (const [name, base64] of Object.entries(assets.files))
    // Public manifest paths use plain path segments; preserve the variable font under a safe name.
    kit.set(name.replace('ClarityCut[wght]', 'ClarityCut-Variable'), Buffer.from(base64, 'base64'));
  kit.set('clarity-tooltip.js', bytes(rendererSource));
  kit.set('clarity-tooltip.css', bytes(tooltipCss));
  kit.set(
    'decode-v1.mjs',
    bytes(`// SPDX-License-Identifier: MIT\nexport const decodeV1 = ${decodeV1.toString()};\n`),
  );
  kit.set('display-examples.js', bytes(behaviorSource));
  kit.set('LICENSE', bytes(mit));
  kit.set('features.json', bytes(json(featureTable())));
  kit.set('format-v1.schema.json', bytes(json(formatSchema())));
  kit.set(
    'brand/colours.json',
    bytes(json({ green: '#24EC54', cyan: '#1CDCFC', themes: themeTokens })),
  );
  kit.set('CREDITS.txt', bytes(credit + '\n\n' + bungieCreditNote + '\n'));
  const usage = Object.fromEntries(
    [...kit.keys()].map((path) => [
      path,
      path.startsWith('symbols/')
        ? path.endsWith('.svg')
          ? assets.provenance[
              path.split('/').pop()!.replace('.svg', '') as keyof typeof assets.provenance
            ] + ' Choose the variant matching the tooltip surface.'
          : path.endsWith('.woff2')
            ? 'DestinySymbols from the editor. Bungie-derived glyphs; redistribution licence has not been verified. Use glyph-map.json for code points.'
            : 'Full Unicode code-point to glyph-name map for DestinySymbols. Some glyphs are controls, not tooltip icons.'
        : path.includes('ClarityCut/')
          ? path.endsWith('OFL.txt') || path.endsWith('FONTLOG.md')
            ? 'Keep beside every redistributed Clarity Cut font.'
            : 'Clarity Cut, the renamed Orbitron derivative. Variable font: wght axis; static files: named weights. SIL OFL 1.1; retain OFL.txt and FONTLOG.md.'
          : path.endsWith('.svg')
            ? 'Approved Clarity Control k75 lockup or mark. Choose the matching light/dark variant; preserve proportions. Owner-provided artwork; separate redistribution terms have not been supplied.'
            : path === 'brand/colours.json'
              ? 'Clarity brand green and cyan, plus semantic theme tokens. Use theme-specific link and focus ink colours.'
              : path === 'CREDITS.txt'
                ? 'Display the source credit and feedback links in your app. Full requirements are linked.'
                : 'Reference code and documentation, MIT. Keep LICENSE with copied code.',
    ]),
  );
  for (const path of kit.keys())
    if (path.startsWith('symbols/') && /\.(svg|woff2)$/.test(path))
      usage[path] += ' ' + bungieCreditNote;
  usage['usage.json'] =
    'Per-asset source, usage, and licence notes. Read before redistributing assets.';
  usage['contents.json'] = 'Complete list of files in partner-kit.zip.';
  kit.set('usage.json', bytes(json(usage)));
  kit.set('contents.json', bytes(json([...kit.keys(), 'contents.json'].sort())));
  for (const [name, value] of kit) output.set('reference/kit/' + name, value);
  output.set('reference/partner-kit.zip', kitZip(kit));
  put('reference/kit/contents.json', [...kit.keys()].sort());
  put('reference/clarity-tooltip.js', rendererSource);
  put('reference/clarity-tooltip.css', tooltipCss);
  put(
    'reference/decode-v1.mjs',
    `// SPDX-License-Identifier: MIT\nexport const decodeV1 = ${decodeV1.toString()};\n`,
  );
  put('reference/display-examples.js', behaviorSource);
  put('reference/page.js', pageSource);
  put('reference/page.css', pageCss);
  put('reference/LICENSE', mit);
  put('reference/features.json', featureTable());
  put('reference/format-v1.schema.json', formatSchema());
  const getFile = (shape: string) => {
    const value = read(`reference/v1/${shape}/en.json`);
    return value ? (JSON.parse(Buffer.from(value).toString('utf8')) as FormatV1File) : undefined;
  };
  const linesFile = getFile('lines'),
    textFile = getFile('text');
  const showcase = (file: FormatV1File | undefined) => {
    const perk = file?.perks['-1'];
    return file && perk
      ? {
          ...file,
          descriptions: [file.descriptions[perk.description]!],
          perks: { '-1': { ...perk, description: 0 } },
        }
      : undefined;
  };
  const linesShowcase = showcase(linesFile),
    textShowcase = showcase(textFile);
  if (linesShowcase) put('reference/showcase/lines.json', linesShowcase);
  if (textShowcase) put('reference/showcase/text.json', textShowcase);
  // A failed first build still publishes the static docs and an explicit unavailable state.
  const liveShowcase = linesShowcase ?? {
    format: 1,
    shape: 'lines',
    languages: ['en'],
    descriptions: [
      {
        en: 'The pinned reference file is unavailable. Retry after the next successful data build.',
      },
    ],
    perks: { '-1': { name: 'Reference unavailable', description: 0 } },
  };
  const startCode = `import { decode, renderDom } from './clarity-tooltip.js';
const url = 'https://data.d2clarity.com/reference/v1/lines/en.json';
const response = await fetch(url);
if (!response.ok) throw new Error('Data unavailable');
const file = await response.json();
const perks = decode(file);
const perk = perks['-1'];
const lines = perk.descriptions.en;
const content = renderDom(lines, { notes: 'popover' });
document.querySelector('#tooltip').replaceChildren(content);`;
  const sectionBodies: [string, string, string][] = [
    [
      'start',
      'Get started',
      `<p>Clarity publishes Destiny 2 perk research as format v1 JSON. Read one distinct description from the shared table, then draw it with the reference renderer.</p>${code(startCode)}<p>Load <a href="clarity-tooltip.css">clarity-tooltip.css</a> for the optional tooltip styles. Apps own their tooltip window and placement.</p><p>Credit <a href="https://d2clarity.com">Clarity</a> as the external source, and include <a href="https://d2clarity.com/discord">Discord for tooltip feedback</a>. Label changes you make, and keep local copies current. <a href="https://www.d2clarity.com/partnerships">Full data usage requirements</a>.</p>`,
    ],
    [
      'live',
      'Live renderer',
      `<noscript><p>The documentation is available without JavaScript. Enable scripts for the live picker, or download the <a href="showcase/lines.json">showcase JSON</a>.</p></noscript><div class="controls" data-js><label class="search">Search name or hash<input id="query" type="search" placeholder="Perk name or hash"></label><label class="picker">Tooltip<select id="picker"><option value="-1">Feature showcase</option></select></label><label>Language<select id="language">${exportLanguages.map((lang) => `<option>${lang}</option>`).join('')}</select></label></div><div class="load-status"><p id="load-state" role="status">The picker loads the published reference file. The showcase comes from that same build.</p><button id="retry" hidden data-js>Retry</button></div><p id="match-count" role="status"></p><div class="live-grid"><div><h3 id="selected-name">Feature showcase</h3><p>Every chosen display concept below draws the selected tooltip. <a href="#display">Jump to display examples</a>.</p><div id="live-summary" class="tip" data-js></div><noscript><p><a href="showcase/lines.json">Download the feature showcase JSON</a>, or enable scripts to draw it here.</p></noscript></div><div><h3>Selected tooltip JSON</h3><pre id="live-json" class="json">${html(json(decodeV1(liveShowcase)['-1']))}</pre></div></div>`,
    ],
    [
      'file',
      'The file',
      `<p><code>format: 1</code> identifies this contract; <code>shape</code> is lines or text; <code>languages</code> lists the file's language ids. <code>descriptions</code> stores each distinct description once. Each hash in <code>perks</code> points to it by a zero-based <code>description</code> index.</p><p>Perk keys are optional and chosen by the project's file settings: <code>name</code>, <code>itemHash</code>, <code>itemName</code>, <code>category</code>, <code>edited</code>, and <code>references</code>. <code>edited.&lt;lang&gt;.at</code> is an ISO timestamp, and <code>.by</code> is the editor's name. Time and name are independent choices. <code>.at</code> and <code>.by</code> are omitted when unknown, and <code>edited</code> may be absent. In a per-language file, an English stand-in carries <code>edited.en</code> whenever the file selects <code>edited</code> or <code>editedBy</code>; it may be <code>{}</code> when both values are unknown. With neither selected, there is no <code>edited</code> and no stand-in marker. <code>references</code> contains target perk hashes in the same file.</p><p>The sample below is a shortened view of the actual file; indexes are those of the full download. <a href="v1/lines/en.json">Download the complete lines file</a>.</p>${code(linesFile ? json({ ...linesFile, descriptions: linesFile.descriptions.slice(0, 1), perks: Object.fromEntries(Object.entries(linesFile.perks).slice(0, 2)) }) : 'Awaiting the first reference build.', 'file-json')}`,
    ],
    [
      'lines',
      'Lines shape',
      `<p>A description is an array of lines. A line is either <code>{"spacer":true}</code> or <code>{"parts":[...]}</code>, with optional <code>style</code>. A spacer creates a gap. Text keeps its own whitespace and bullets.</p>${code(json([{ parts: [{ text: 'Above the gap.' }] }, { spacer: true }, { style: ['bold'], parts: [{ text: 'A bold line.' }] }]))}`,
    ],
    [
      'parts',
      'Parts',
      `<p>Unknown keys, styles, and element values are ignored. An unknown icon falls back to its <code>text</code>, if present. Notes inside notes are written inline. Numbers for notes and links share reading order; repeated notes or addresses keep their number.</p>${features.map((f) => `<article id="part-${f.id}" class="feature"><h3>${html(f.id)}</h3><div><p>${html(f.description)}</p>${code(compactExample(f.example))}${example('part-' + f.id, f.example)}</div><div class="tip" data-feature="part-${f.id}">${html(f.fallback)}</div></article>`).join('')}`,
    ],
    [
      'text',
      'Text shape and starting styles',
      `<p>A text description is one string per language. It has no parts, notes, or interactive behavior to recover. These are starting styles; partners can customize every rule. Element words always keep their text, while element metadata is absent in text shape.</p><div class="table-wrap"><table><thead><tr><th>Style</th><th>Shape</th><th>Symbols and bold</th><th>Notes and links</th></tr></thead><tbody><tr><td>Structured</td><td>lines</td><td>All symbols and styles kept</td><td>Kept as structured parts</td></tr><tr><td>Markdown</td><td>text</td><td>Icons become names; arrow →; enhanced [enh]; bold **text**; other styles dropped</td><td>Notes dropped; links [label](address)</td></tr><tr><td>Discord</td><td>text</td><td>Icons dropped; arrow →; enhanced [enh]; bold **text**; other styles dropped</td><td>Notes dropped; links [label](address)</td></tr><tr><td>Plain</td><td>text</td><td>All symbols and styles dropped except arrow →</td><td>Labels kept; note bodies and link addresses dropped</td></tr></tbody></table></div><details><summary>Exact rule for every symbol in all four starting styles</summary>${symbolRulesTable()}</details><p>The internal text file starts from Markdown. <a href="v1/text/en.json">Download the complete text file</a>.</p>${code(textShowcase ? String(textShowcase.descriptions[0]?.en ?? '') : 'Awaiting the first reference build.', 'text-example')}`,
    ],
    [
      'languages',
      'Languages',
      `<p>The 13 ids are <code>${exportLanguages.join(', ')}</code>. A project may choose one combined file (<code>&lt;project&gt;/v1/&lt;file&gt;.json</code>) or one complete file per language (<code>&lt;project&gt;/v1/&lt;file&gt;/&lt;lang&gt;.json</code>).</p><p>Missing translations and translations at least 90 days behind English use English text in per-language files. When the file selects <code>edited</code> or <code>editedBy</code>, an English stand-in carries <code>edited.en</code>. Its <code>.at</code> and <code>.by</code> fields are omitted when unknown, so the marker can be <code>{"edited":{"en":{}}}</code>. With neither selected, the file exports no <code>edited</code> and no stand-in marker.</p>`,
    ],
    [
      'updates',
      'Updates',
      `<p>Fetch <code>/&lt;project&gt;/index.json</code>, find the entry by file id and language, and download its <code>path</code> when <code>sha256</code> changes. <code>current</code> means built from the current pinned data; <code>stale</code> means a build failed and previous bytes remain; <code>frozen</code> means the URL stopped updating.</p><p>Kept old URLs continue updating for three months, then are deleted. Their index entry includes <code>updatesUntil</code>. Check <code>status</code> and that deadline rather than assuming every URL remains current.</p><p><a href="index.json">Reference project index</a></p>`,
    ],
    [
      'versions',
      'Versions and compatibility',
      `<p>The header's <code>format</code> and the URL's <code>v1</code> identify the contract. Adding or removing a key, type, or symbol present in a file is a breaking vocabulary change. Unknown keys must be ignored by readers. A later engine symbol stays out of an existing partner file until its owner chooses it. Kept URLs freeze when their vocabulary would break.</p>`,
    ],
    [
      'display',
      'Display options',
      `<p>All nine owner-selected concepts use the renderer over the same selected tooltip. Interactive examples support keyboard activation; non-interactive tooltip content emits no focusable element. Host perk buttons remain outside that content.</p><div class="concepts">${proposals.map((p) => `<article id="${p.id}" data-case="${p.group.toLowerCase().replaceAll(', ', '-')}" data-proposal="${p.id}" tabindex="${p.mode === 'hold' ? '0' : '-1'}"><h3>${p.group}: ${p.title}</h3><p class="muted">${p.hint}</p>${p.mode === 'tap' || p.mode === 'long' ? `<button class="perk-trigger" data-js>${p.mode === 'tap' ? 'Tap perk again' : 'Hold perk for details'}</button>` : ''}<div data-render><p>Enable scripts for this live concept.</p></div></article>`).join('')}</div><h3>Copyable host behavior</h3><p>Call the relevant function after placing the rendered tooltip. Pass its host element, details panel, and (for the sheet) a modal dialog with a <code>[data-body]</code> element. Call the returned cleanup before replacing the tooltip.</p><div class="copy-row"><button data-js data-copy="behavior-code">Copy behavior examples</button></div>${code(behaviorSource, 'behavior-code')}<p>Expand in place uses <code>renderDom(lines, { notes: 'expand' })</code>. Footnotes use <code>renderDom(lines, { notes: 'numbered', interactive: false })</code> followed by <code>renderDetails(lines, { interactive: false })</code>.</p><details><summary>Other considered approaches</summary><p>Desktop interactive: numbered side panel. Desktop non-interactive: step through with a key, write details inline, or reveal after a pause. Touch interactive: numbered buttons. Touch non-interactive: a moving details strip or written inline. These alternatives are listed for comparison; the live concepts above are the approved set.</p></details>`,
    ],
    [
      'renderer',
      'Reference renderer and decoder',
      `<p>One dependency-free ES module exports <code>decode</code>, <code>details</code>, <code>renderDom</code>, <code>renderDetails</code>, and <code>renderText</code>. It bundles light and dark SVG symbols. Supply <code>icon(id)</code> to override the artwork. Set the root's <code>data-theme</code> to light or dark, or omit it to follow the system.</p>${code(`details(lines); // [{ n, kind, label, note? , link? }]
renderDom(lines, { notes: 'popover', interactive: true, icon: id => null });
// notes: 'popover' | 'numbered' | 'expand' | 'inline'
renderDetails(lines, { interactive: false }); // numbered <ol>
renderText(lines, { notes: 'footnotes', links: 'address', icons: 'names', bold: 'drop' });
// notes: 'inline' | 'footnotes' | 'drop'; links: 'address' | 'markdown' | 'drop'
// icons: 'names' | 'drop'; bold: 'markdown' | 'drop'
// A text-shape string passes through unchanged.`)}<p><a href="clarity-tooltip.js" download>Download renderer</a>, <a href="clarity-tooltip.css" download>optional stylesheet</a>, <a href="decode-v1.mjs" download>standalone decoder</a>, and <a href="LICENSE">MIT licence for the code</a>. Artwork and fonts have separate provenance in the kit.</p><details><summary>Renderer source</summary><div class="copy-row"><button data-js data-copy="renderer-code">Copy renderer</button></div>${code(rendererSource, 'renderer-code')}</details>`,
    ],
    [
      'agents',
      'Machine-readable reference',
      `<p><a href="/llms.txt">llms.txt</a> summarizes the URLs and credit requirements. <a href="format-v1.schema.json">JSON Schema 2020-12</a> covers both shapes and the project index. <a href="features.json">features.json</a> lists the vocabulary, examples, anchors, and plain-text fallbacks.</p><p>Fixed showcase URLs: <a href="showcase/lines.json">lines</a> and <a href="showcase/text.json">text</a>. <a href="reference.md">Markdown version of this page</a>. JSON examples also appear in <code>script[type="application/json"][data-example]</code> elements. Public files permit cross-origin reads.</p>`,
    ],
    [
      'kit',
      'Partner kit',
      `<p><a href="partner-kit.zip" download>Download the complete partner kit</a>. <a href="kit/contents.json">Contents list</a> and <a href="kit/usage.json">asset usage notes and provenance</a>.</p><p>The kit includes every symbol as light and dark SVG, DestinySymbols with its complete glyph map, the approved k75 lockups and marks, Clarity Cut variable and static TTF/WOFF2 fonts with OFL.txt and FONTLOG.md, brand colours, theme tokens, reference code, and credit rules.</p><p>Clarity Cut is the renamed Orbitron derivative under SIL OFL 1.1. Keep its licence and font log beside it. The Bungie-derived symbols and owner-provided brand artwork are included with source notes; redistribution terms have not been verified. The code's MIT licence does not grant rights to that artwork.</p><p>${bungieCredit}: <a href="${bungiePolicy}">Bungie's fan content policy</a>.</p>${creditHtml}<details><summary>Individual downloads (${kit.size} files)</summary>${assetDownloads(kit)}</details>`,
    ],
  ];
  const title = 'Clarity data reference';
  put(
    'reference/index.html',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Clarity format v1, live tooltip display examples, and partner assets."><title>${title}</title><link rel="alternate" type="text/markdown" href="reference.md"><link rel="stylesheet" href="clarity-tooltip.css"><link rel="stylesheet" href="page.css"></head><body><header><a href="https://d2clarity.com" aria-label="Clarity home"><picture><img class="clarity-art-dark" src="kit/brand/lockup-k75-dark.svg" alt="Clarity Control"><img class="clarity-art-light" src="kit/brand/lockup-k75-light.svg" alt="Clarity Control"></picture></a><h1>${title}</h1><label data-js>Theme<select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header><div class="layout"><nav aria-label="Reference sections">${sectionBodies.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav><main>${sectionBodies.map(([id, label, body]) => `<section id="${id}" aria-labelledby="heading-${id}"><h2 id="heading-${id}">${label}</h2>${body}</section>`).join('')}</main></div><dialog id="details-sheet" class="sheet" aria-labelledby="sheet-title"><div class="sheet-header"><h3 id="sheet-title">Tooltip details</h3><button>Close details</button></div><div data-body></div></dialog><script type="application/json" id="showcase-data">${embedded(liveShowcase)}</script><script type="application/json" id="proposal-list">${embedded(proposals)}</script><script type="module" src="page.js"></script></body></html>`,
  );
  const markdown =
    '# ' +
    title +
    '\n\n' +
    sectionBodies
      .map(
        ([id, label, body]) =>
          `## ${label} {#${id}}\n\n` +
          body
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
            .replace(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g, '\n```\n$1\n```\n')
            .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
            .replace(/<\/(?:p|div|h3|summary|tr|li)>/g, '\n\n')
            .replace(/<[^>]+>/g, '')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .replaceAll('&amp;', '&'),
      )
      .join('\n\n');
  put('reference/reference.md', markdown);
  put(
    'llms.txt',
    [
      '# Clarity data',
      '',
      'Destiny 2 perk research in self-describing format v1 JSON.',
      'Documentation: https://data.d2clarity.com/reference/',
      'Markdown: https://data.d2clarity.com/reference/reference.md',
      'Schema: https://data.d2clarity.com/reference/format-v1.schema.json',
      'Features: https://data.d2clarity.com/reference/features.json',
      'Showcase lines: https://data.d2clarity.com/reference/showcase/lines.json',
      'Showcase text: https://data.d2clarity.com/reference/showcase/text.json',
      'Project index: https://data.d2clarity.com/reference/index.json',
      'Real lines: https://data.d2clarity.com/reference/v1/lines/en.json',
      'Real text: https://data.d2clarity.com/reference/v1/text/en.json',
      'Renderer: https://data.d2clarity.com/reference/clarity-tooltip.js',
      'Styles: https://data.d2clarity.com/reference/clarity-tooltip.css',
      'Decoder: https://data.d2clarity.com/reference/decode-v1.mjs',
      'Host behaviors: https://data.d2clarity.com/reference/display-examples.js',
      'Partner kit: https://data.d2clarity.com/reference/partner-kit.zip',
      'Kit contents: https://data.d2clarity.com/reference/kit/contents.json',
      'Asset provenance: https://data.d2clarity.com/reference/kit/usage.json',
      '',
      'Header: format, shape, languages. Perks index shared descriptions.',
      'Shapes: lines (parts and spacers), text (one string per language).',
      'Unknown keys and styles are ignored; unknown icons retain their text.',
      'edited is optional; unknown .at/.by are omitted. In per-language files, English stand-ins carry edited.en (possibly {}) when edited or editedBy is selected; neither selected means no edited and no stand-in marker.',
      'Poll index.json by file id and language; fetch when sha256 changes.',
      'Statuses: current, stale, frozen. Kept URLs have updatesUntil.',
      'Code is MIT. Fonts and artwork have separate terms; see kit/usage.json.',
      credit,
      '',
      'Contact: https://d2clarity.com/discord',
    ].join('\n') + '\n',
  );
  return output;
}
