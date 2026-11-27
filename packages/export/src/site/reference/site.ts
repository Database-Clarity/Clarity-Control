import type { FormatV2File } from '../../v2/compile.js';
import {
  configurableFormatVersion,
  exportLanguages,
  styles,
  symbolIds,
} from '../../v2/vocabulary.js';
import { styleFormats } from '../../v2/styles.js';
import { decodeV2 } from '../../../decoder/decode-v2.mjs';
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
const bungiePolicy = 'https://www.bungie.net/7/en/Legal/IntellectualPropertyTrademarks';
const bungieCredit =
  "Destiny symbols (the symbol SVGs and DestinySymbols font) are (c) Bungie, Inc. and used under Bungie's fan content policy";
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
      'Each symbol has a light and dark SVG. The font includes a complete glyph map. The SVGs use the MIT licence.',
    ],
    [
      'Clarity Cut fonts',
      'brand/ClarityCut/',
      'The TTF and WOFF2 files include a variable font with a wght axis and static weights. Keep OFL.txt and FONTLOG.md beside the fonts.',
    ],
    [
      'Brand assets',
      'brand/',
      'Clarity icon, light and dark text logos, brand colours, and theme tokens.',
    ],
    [
      'Reference code and metadata',
      '',
      'The kit includes the renderer, decoder, display examples, schema, feature table, licences, and asset notes. The code uses the MIT licence. Artwork and fonts have separate terms.',
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
    hint: 'Hover over a note or focus it to show details. Press Escape to close them. Links open as usual.',
    mode: 'popover',
  },
  {
    id: 'DI-P3',
    group: 'Desktop, interactive',
    title: 'Expand in place',
    hint: 'Activate a note to show its text below the line. Activate it again to hide the text.',
    mode: 'expand',
  },
  {
    id: 'DN-P1',
    group: 'Desktop, non-interactive',
    title: 'Hold a key',
    hint: 'Hover over this example or focus it, then hold D to show details. Release D to hide them. Use footnotes if your app cannot read key presses.',
    mode: 'hold',
  },
  {
    id: 'DN-P2',
    group: 'Desktop, non-interactive',
    title: 'Footnotes',
    hint: 'Details stay below the text. Nothing inside the tooltip takes focus.',
    mode: 'footnotes',
  },
  {
    id: 'TI-P1',
    group: 'Touch, interactive',
    title: 'Bottom sheet',
    hint: 'Tap an underlined word to open its details in a sheet. Close the sheet or press Escape to return focus to the word.',
    mode: 'sheet',
  },
  {
    id: 'TI-P2',
    group: 'Touch, interactive',
    title: 'Expand in place',
    hint: 'Tap a note to show its text below the line. Tap it again to hide the text.',
    mode: 'expand',
  },
  {
    id: 'TN-P1',
    group: 'Touch, non-interactive',
    title: 'Tap the perk again',
    hint: 'With the tooltip open, tap its perk button again to show or hide details. The button stays outside the tooltip content.',
    mode: 'tap',
  },
  {
    id: 'TN-P2',
    group: 'Touch, non-interactive',
    title: 'Footnotes',
    hint: 'Details stay below the tooltip. Links show their full addresses.',
    mode: 'footnotes',
  },
  {
    id: 'TN-P3',
    group: 'Touch, non-interactive',
    title: 'Long-press',
    hint: 'Hold the perk button for half a second to show details. Moving your pointer cancels the hold. Press Enter to show details or Escape to hide them.',
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
    'decode-v2.mjs',
    bytes(`// SPDX-License-Identifier: MIT\nexport const decodeV2 = ${decodeV2.toString()};\n`),
  );
  kit.set('display-examples.js', bytes(behaviorSource));
  kit.set('LICENSE', bytes(mit));
  kit.set('features.json', bytes(json(featureTable())));
  kit.set('format-v2.schema.json', bytes(json(formatSchema())));
  kit.set(
    'brand/colours.json',
    bytes(json({ green: '#24EC54', cyan: '#1CDCFC', themes: themeTokens })),
  );
  kit.set('symbols/LICENSE', bytes(mit));
  kit.set('CREDITS.txt', bytes(bungieCreditNote + '\n'));
  const usage = Object.fromEntries(
    [...kit.keys()].map((path) => [
      path,
      path.startsWith('symbols/')
        ? path.endsWith('.svg')
          ? assets.provenance[
              path.split('/').pop()!.replace('.svg', '') as keyof typeof assets.provenance
            ] + ' MIT licence. Choose the variant for your tooltip background.'
          : path.endsWith('.woff2')
            ? 'DestinySymbols is the symbol font used by the editor. Find code points in glyph-map.json.'
            : path === 'symbols/LICENSE'
              ? 'MIT licence for the symbol SVGs.'
              : 'Look up DestinySymbols glyph names by Unicode code point. The map includes control glyphs as well as tooltip icons.'
        : path.includes('ClarityCut/')
          ? path.endsWith('OFL.txt') || path.endsWith('FONTLOG.md')
            ? 'Keep this file beside every Clarity Cut font you redistribute.'
            : 'Clarity Cut derives from Orbitron and has been renamed under SIL OFL 1.1. The variable font has a wght axis. Static files have named weights. Keep OFL.txt and FONTLOG.md.'
          : path.endsWith('.svg')
            ? 'Original Clarity artwork from the Project Images folder.'
            : path === 'brand/colours.json'
              ? 'Use Clarity green and cyan with the theme tokens. Use the link and focus colours for your theme.'
              : path === 'CREDITS.txt'
                ? 'Bungie attribution for Destiny symbols.'
                : 'The reference code and documentation use the MIT licence. Keep LICENSE with any code you copy.',
    ]),
  );
  usage['usage.json'] = 'Asset sources and licence notes.';
  usage['contents.json'] = 'Lists every file in partner-kit.zip.';
  kit.set('usage.json', bytes(json(usage)));
  kit.set('contents.json', bytes(json([...kit.keys(), 'contents.json'].sort())));
  for (const [name, value] of kit) output.set('reference/kit/' + name, value);
  output.set('reference/partner-kit.zip', kitZip(kit));
  put('reference/kit/contents.json', [...kit.keys()].sort());
  put('reference/clarity-tooltip.js', rendererSource);
  put('reference/clarity-tooltip.css', tooltipCss);
  put(
    'reference/decode-v2.mjs',
    `// SPDX-License-Identifier: MIT\nexport const decodeV2 = ${decodeV2.toString()};\n`,
  );
  put('reference/display-examples.js', behaviorSource);
  put('reference/page.js', pageSource);
  put('reference/page.css', pageCss);
  put('reference/LICENSE', mit);
  put('reference/features.json', featureTable());
  put('reference/format-v2.schema.json', formatSchema());
  const getFile = (shape: string) => {
    const value = read(`reference/v2/${shape}/en.json`);
    return value ? (JSON.parse(Buffer.from(value).toString('utf8')) as FormatV2File) : undefined;
  };
  const linesFile = getFile('lines'),
    textFile = getFile('text');
  const showcase = (file: FormatV2File | undefined) => {
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
    format: configurableFormatVersion,
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
const url = 'https://data.d2clarity.com/reference/v2/lines/en.json';
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
      `<p>Clarity publishes Destiny 2 perk research as format v2 JSON. Decode the file to look up a perk by hash, then render its description.</p>${code(startCode)}<p>Load <a href="clarity-tooltip.css">clarity-tooltip.css</a> to use the optional tooltip styles. Your app must create and position the tooltip window.</p>`,
    ],
    [
      'live',
      'Live renderer',
      `<div class="controls" data-js><label class="search">Search name or hash<input id="query" type="search" placeholder="Perk name or hash"></label><label class="picker">Tooltip<select id="picker"><option value="-1">Example tooltip</option></select></label><label>Language<select id="language">${exportLanguages.map((lang) => `<option>${lang}</option>`).join('')}</select></label></div><div class="load-status"><p id="load-state" role="status">Choose a tooltip from the published reference file. The example tooltip uses the same build.</p><button id="retry" hidden data-js>Retry</button></div><p id="match-count" role="status"></p><div class="live-grid"><div><h3 id="selected-name">Example tooltip</h3><p>Each display example below uses the selected tooltip. <a href="#display">View display examples</a>.</p><div id="live-summary" class="tip" data-js></div></div><div><h3>Selected tooltip JSON</h3><pre id="live-json" class="json">${html(json(decodeV2(liveShowcase)['-1']))}</pre></div></div>`,
    ],
    [
      'file',
      'The file',
      `<p><code>format: 2</code> identifies the file format. <code>shape</code> is lines or text. <code>languages</code> lists the file's language ids. <code>descriptions</code> stores each distinct description once. Each hash in <code>perks</code> points to it by a zero-based <code>description</code> index.</p><p>The project's file settings choose which optional perk keys to include: <code>name</code>, <code>itemHash</code>, <code>itemName</code>, <code>category</code>, <code>edited</code>, and <code>references</code>. <code>edited.&lt;lang&gt;.at</code> is an ISO timestamp, and <code>.by</code> is the editor's name. You can include the timestamp, the editor's name, or both. <code>.at</code> and <code>.by</code> are omitted when unknown, and <code>edited</code> may be absent. In a per-language file, an English stand-in carries <code>edited.en</code> whenever the file selects <code>edited</code> or <code>editedBy</code>; it may be <code>{}</code> when both values are unknown. With neither selected, there is no <code>edited</code> and no stand-in marker. <code>references</code> contains target perk hashes in the same file.</p><p>The sample below shows part of the published file. Its indexes refer to the complete download. <a href="v2/lines/en.json">Download the complete lines file</a>.</p>${code(linesFile ? json({ ...linesFile, descriptions: linesFile.descriptions.slice(0, 1), perks: Object.fromEntries(Object.entries(linesFile.perks).slice(0, 2)) }) : 'The first reference build is not available yet.', 'file-json')}`,
    ],
    [
      'lines',
      'Lines shape',
      `<p>A description contains an array of lines. Each line is either <code>{"spacer":true}</code> or <code>{"parts":[...]}</code>, with optional <code>style</code>. A spacer creates a gap. Text keeps its own whitespace and bullets.</p>${code(json([{ parts: [{ text: 'Above the gap.' }] }, { spacer: true }, { style: ['bold'], parts: [{ text: 'A bold line.' }] }]))}`,
    ],
    [
      'parts',
      'Parts',
      `<p>The renderer ignores unknown keys, styles, and element values. An unknown icon falls back to its <code>text</code>, if present. The renderer writes nested notes inline. It numbers notes and links in reading order. Repeated notes or addresses keep the same number.</p>${features.map((f) => `<article id="part-${f.id}" class="feature"><h3>${html(f.id)}</h3><div><p>${html(f.description)}</p>${code(compactExample(f.example))}${example('part-' + f.id, f.example)}</div><div class="tip" data-feature="part-${f.id}">${html(f.fallback)}</div></article>`).join('')}`,
    ],
    [
      'text',
      'Text shape and starting styles',
      `<p>A text description has one string per language. It contains no parts or note bodies. Your app cannot recover interactive behavior from it. You can change every rule in these starting styles. Element words keep their text, but text files contain no element metadata.</p><div class="table-wrap"><table><thead><tr><th>Style</th><th>Shape</th><th>Symbols and bold</th><th>Notes and links</th></tr></thead><tbody><tr><td>Structured</td><td>lines</td><td>All symbols and styles kept</td><td>Kept as structured parts</td></tr><tr><td>Markdown</td><td>text</td><td>Icons become names; arrow →; enhanced [enh]; bold **text**; other styles dropped</td><td>Notes dropped; links [label](address)</td></tr><tr><td>Discord</td><td>text</td><td>Icons dropped; arrow →; enhanced [enh]; bold **text**; other styles dropped</td><td>Notes dropped; links [label](address)</td></tr><tr><td>Plain</td><td>text</td><td>All symbols and styles dropped except arrow →</td><td>Labels kept; note bodies and link addresses dropped</td></tr></tbody></table></div><details><summary>View every symbol rule for the four starting styles</summary>${symbolRulesTable()}</details><p>The reference text file uses the Markdown starting style. <a href="v2/text/en.json">Download the complete text file</a>.</p>${code(textShowcase ? String(textShowcase.descriptions[0]?.en ?? '') : 'The first reference build is not available yet.', 'text-example')}`,
    ],
    [
      'languages',
      'Languages',
      `<p>The 13 ids are <code>${exportLanguages.join(', ')}</code>. A project can use one combined file (<code>&lt;project&gt;/v2/&lt;file&gt;.json</code>) or one complete file per language (<code>&lt;project&gt;/v2/&lt;file&gt;/&lt;lang&gt;.json</code>).</p><p>Missing translations and translations at least 90 days behind English use English text in per-language files. When the file selects <code>edited</code> or <code>editedBy</code>, an English stand-in carries <code>edited.en</code>. Its <code>.at</code> and <code>.by</code> fields are omitted when unknown, so the marker can be <code>{"edited":{"en":{}}}</code>. With neither selected, the file exports no <code>edited</code> and no stand-in marker.</p>`,
    ],
    [
      'updates',
      'Updates',
      `<p>Fetch <code>/&lt;project&gt;/index.json</code> and find the entry for your file id and language. Download its <code>path</code> when <code>sha256</code> changes. <code>current</code> means the file uses the current pinned data. <code>stale</code> means a build failed, so the previous file is still available. <code>frozen</code> means the URL has stopped updating.</p><p>Kept old URLs continue updating for three months, then are deleted. Their index entry includes <code>updatesUntil</code>. Check <code>status</code> and <code>updatesUntil</code> before using a kept URL.</p><p><a href="index.json">Reference project index</a></p>`,
    ],
    [
      'versions',
      'Versions and compatibility',
      `<p>The header's <code>format</code> and the URL's <code>v2</code> identify the file format. Adding or removing a key, type, or symbol present in a file is a breaking vocabulary change. Your reader must ignore unknown keys. New engine symbols stay out of an existing partner file until its owner chooses them. Kept URLs freeze when their vocabulary would break.</p>`,
    ],
    [
      'display',
      'Display options',
      `<p>All nine display examples render the selected tooltip. You can activate interactive examples with the keyboard. Non-interactive tooltip content contains no focusable elements. Your app's perk buttons stay outside that content.</p><div class="concepts">${proposals.map((p) => `<article id="${p.id}" data-case="${p.group.toLowerCase().replaceAll(', ', '-')}" data-proposal="${p.id}" tabindex="${p.mode === 'hold' ? '0' : '-1'}"><h3>${p.group}: ${p.title}</h3><p class="muted">${p.hint}</p>${p.mode === 'tap' || p.mode === 'long' ? `<button class="perk-trigger" data-js>${p.mode === 'tap' ? 'Tap perk again' : 'Hold perk for details'}</button>` : ''}<div data-render></div></article>`).join('')}</div><h3>Use these behaviors in your app</h3><p>Call the function after placing the rendered tooltip. Pass its host element and details panel. The sheet also needs a modal dialog with a <code>[data-body]</code> element. Call the returned cleanup function before replacing the tooltip.</p><div class="copy-row"><button data-js data-copy="behavior-code">Copy behavior examples</button></div>${code(behaviorSource, 'behavior-code')}<p>Expand in place uses <code>renderDom(lines, { notes: 'expand' })</code>. Footnotes use <code>renderDom(lines, { notes: 'numbered', interactive: false })</code> followed by <code>renderDetails(lines, { interactive: false })</code>.</p>`,
    ],
    [
      'renderer',
      'Reference renderer and decoder',
      `<p>The renderer is an ES module with no dependencies. It exports <code>decode</code>, <code>details</code>, <code>renderDom</code>, <code>renderDetails</code>, and <code>renderText</code>. It bundles light and dark SVG symbols. Supply <code>icon(id)</code> to override the artwork. Set the root's <code>data-theme</code> to light or dark, or omit it to follow the system.</p><p>Keep each symbol with the word that touches its right side. Keep the regular arrow with touching words on both sides. For example, put the group in an inline-block wrapper with a maximum width of 100%, and allow long words to break inside it.</p>${code(`details(lines); // [{ n, kind, label, note? , link? }]
renderDom(lines, { notes: 'popover', interactive: true, icon: id => null });
// notes: 'popover' | 'numbered' | 'expand' | 'inline'
renderDetails(lines, { interactive: false }); // numbered <ol>
renderText(lines, { notes: 'footnotes', links: 'address', icons: 'names', bold: 'drop' });
// notes: 'inline' | 'footnotes' | 'drop'; links: 'address' | 'markdown' | 'drop'
// icons: 'names' | 'drop'; bold: 'markdown' | 'drop'
// A text-shape string passes through unchanged.`)}<p><a href="clarity-tooltip.js" download>Download renderer</a>, <a href="clarity-tooltip.css" download>optional stylesheet</a>, <a href="decode-v2.mjs" download>standalone decoder</a>, and <a href="LICENSE">MIT licence for the code</a>. Read the kit's source and licence notes.</p><details><summary>Renderer source</summary><div class="copy-row"><button data-js data-copy="renderer-code">Copy renderer</button></div>${code(rendererSource, 'renderer-code')}</details>`,
    ],
    [
      'agents',
      'Machine-readable reference',
      `<p><a href="/llms.txt">llms.txt</a> lists the files and formats. <a href="format-v2.schema.json">JSON Schema 2020-12</a> covers both shapes and the project index. <a href="features.json">features.json</a> lists the vocabulary, examples, anchors, and plain-text fallbacks.</p><p>Download the example tooltip at these fixed URLs: <a href="showcase/lines.json">lines</a> and <a href="showcase/text.json">text</a>. <a href="reference.md">Markdown version of this page</a>. JSON examples also appear in <code>script[type="application/json"][data-example]</code> elements. Your app can fetch public files across origins.</p>`,
    ],
    [
      'kit',
      'Partner kit',
      `<p><a href="partner-kit.zip" download>Download the partner kit</a>. <a href="kit/contents.json">Contents list</a> and <a href="kit/usage.json">asset sources, usage, and licence notes</a>.</p><p>The kit includes light and dark symbol SVGs under the MIT licence, the DestinySymbols font and glyph map, Clarity logos, brand colours, theme tokens, and reference code.</p><p>The variable and static Clarity Cut fonts derive from Orbitron and use the SIL Open Font License 1.1. The kit includes OFL.txt and FONTLOG.md.</p><p>${bungieCredit}: <a href="${bungiePolicy}">Bungie's fan content policy</a>.</p><details><summary>Individual downloads (${kit.size} files)</summary>${assetDownloads(kit)}</details>`,
    ],
  ];
  const title = 'Clarity data reference';
  put(
    'reference/index.html',
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Clarity format v2, live tooltip display examples, and partner assets."><title>${title}</title><link rel="icon" type="image/svg+xml" href="kit/brand/clarity-icon.svg"><link rel="alternate" type="text/markdown" href="reference.md"><link rel="stylesheet" href="clarity-tooltip.css"><link rel="stylesheet" href="page.css"></head><body><header><a href="https://d2clarity.com" aria-label="Clarity home"><picture><img class="clarity-art-dark" src="kit/brand/clarity-text-dark.svg" alt="Clarity"><img class="clarity-art-light" src="kit/brand/clarity-text-light.svg" alt="Clarity"></picture></a><h1>${title}</h1><label data-js>Theme<select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header><div class="layout"><nav aria-label="Reference sections">${sectionBodies.map(([id, label]) => `<a href="#${id}">${label}</a>`).join('')}</nav><main><noscript><p>Enable JavaScript to try the renderer and display examples, or download the <a href="showcase/lines.json">example JSON</a>.</p></noscript>${sectionBodies.map(([id, label, body]) => `<section id="${id}" aria-labelledby="heading-${id}"><h2 id="heading-${id}">${label}</h2>${body}</section>`).join('')}</main></div><dialog id="details-sheet" class="sheet" aria-labelledby="sheet-title"><div class="sheet-header"><h3 id="sheet-title">Tooltip details</h3><button>Close details</button></div><div data-body></div></dialog><script type="application/json" id="showcase-data">${embedded(liveShowcase)}</script><script type="application/json" id="proposal-list">${embedded(proposals)}</script><script type="module" src="page.js"></script></body></html>`,
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
      'Clarity publishes Destiny 2 perk research as format v2 JSON.',
      'Documentation: https://data.d2clarity.com/reference/',
      'Markdown: https://data.d2clarity.com/reference/reference.md',
      'Schema: https://data.d2clarity.com/reference/format-v2.schema.json',
      'Features: https://data.d2clarity.com/reference/features.json',
      'Showcase lines: https://data.d2clarity.com/reference/showcase/lines.json',
      'Showcase text: https://data.d2clarity.com/reference/showcase/text.json',
      'Project index: https://data.d2clarity.com/reference/index.json',
      'Real lines: https://data.d2clarity.com/reference/v2/lines/en.json',
      'Real text: https://data.d2clarity.com/reference/v2/text/en.json',
      'Renderer: https://data.d2clarity.com/reference/clarity-tooltip.js',
      'Styles: https://data.d2clarity.com/reference/clarity-tooltip.css',
      'Decoder: https://data.d2clarity.com/reference/decode-v2.mjs',
      'Host behaviors: https://data.d2clarity.com/reference/display-examples.js',
      'Partner kit: https://data.d2clarity.com/reference/partner-kit.zip',
      'Kit contents: https://data.d2clarity.com/reference/kit/contents.json',
      'Asset provenance: https://data.d2clarity.com/reference/kit/usage.json',
      '',
      'The header contains format, shape, and languages. Each perk points to an entry in the shared descriptions table.',
      'The lines shape contains parts and spacers. The text shape contains one string per language.',
      'Ignore unknown keys and styles. For unknown icons, keep their text.',
      'The edited key is optional. Omit unknown .at and .by fields. In per-language files, English stand-ins carry edited.en when edited or editedBy is selected. The marker can be {} if both fields are unknown. With neither selected, there is no edited key or stand-in marker.',
      'Poll index.json for your file id and language. Fetch the file when sha256 changes.',
      'File status is current, stale, or frozen. Kept URLs include updatesUntil.',
      'The code and symbol SVGs use the MIT licence. Read kit/usage.json for asset sources and licence notes.',
      '',
      'Contact: https://d2clarity.com/discord',
    ].join('\n') + '\n',
  );
  return output;
}
