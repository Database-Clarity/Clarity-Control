import { decodeV2 } from '../../../decoder/decode-v2.mjs';
import assets from './assets.json';
import { iconSymbols } from '../../v2/vocabulary.js';
import { symbolWrapEdges, symbolWrapRuns } from '../../../../core/src/markup/renderWrapping.js';

const symbols = Object.fromEntries(
  [...iconSymbols, 'arrow', 'enhancedArrow'].map((id) => [
    id,
    Object.fromEntries(
      ['light', 'dark'].map((theme) => [
        theme,
        Buffer.from(
          assets.files[`symbols/${theme}/${id}.svg` as keyof typeof assets.files],
          'base64',
        ).toString('utf8'),
      ]),
    ),
  ]),
);

// Shipped as one readable, dependency-free ES module. No HTML from the data is interpreted.
export const rendererSource =
  `// SPDX-License-Identifier: MIT\n// Clarity format v2 reference renderer. Artwork provenance: kit/usage.json.\nexport const decode = ${decodeV2.toString()};\nconst wrapRuns = ${symbolWrapRuns.toString()};\nconst wrapEdges = ${symbolWrapEdges.toString()};\nconst artwork = ${JSON.stringify(symbols)};\n` +
  String.raw`
const styles = new Set(['bold', 'exotic', 'pve', 'pvp']);
const elements = new Set(['kinetic', 'arc', 'solar', 'void', 'stasis', 'strand', 'prismatic']);
const hasIcon = id => Object.hasOwn(artwork, id);
const safeUrl = value => typeof value === 'string' && /^(https?:\/\/|mailto:)/i.test(value.trim()) ? value.trim() : null;
const key = part => part.note ? 'note:' + JSON.stringify(part.note) : 'link:' + part.link;
let serial = 0;
const node = (tag, text, classes) => {
  const result = document.createElement(tag);
  if (text != null) result.textContent = text;
  if (classes) result.className = classes;
  return result;
};
function decorate(target, value) {
  for (const style of value.style || []) if (styles.has(style)) target.classList.add('clarity-' + style);
  if (elements.has(value.element)) target.classList.add('clarity-element-' + value.element);
}
/** Notes and links share reading-order numbers; repeated bodies/addresses reuse a number. */
export function details(lines) {
  const result = [], seen = new Set();
  if (typeof lines === 'string') return result;
  for (const line of lines || []) for (const part of line.parts || []) {
    if ((!part.note && !part.link) || seen.has(key(part))) continue;
    seen.add(key(part));
    result.push({ n: result.length + 1, kind: part.note ? 'note' : 'link', label: part.text || '',
      ...(part.note ? { note: part.note } : { link: part.link }) });
  }
  return result;
}
/** Text shape strings pass through. Unknown styles/keys are ignored; unknown icons keep text. */
export function renderText(lines, options = {}) {
  if (typeof lines === 'string') return lines;
  const opts = { notes: 'inline', links: 'address', icons: 'names', bold: 'drop', ...options };
  const entries = details(lines);
  const draw = part => {
    let text = part.text || '';
    if (part.icon && hasIcon(part.icon)) text = opts.icons === 'drop' ? '' : '[' + part.icon + ']';
    if (part.note) {
      if (opts.notes === 'inline') text += ' (' + renderText(part.note, { ...opts, notes: 'inline' }) + ')';
      else if (opts.notes === 'footnotes') text += '[' + entries.find(d => key(d) === key(part)).n + ']';
    } else if (part.link && opts.links !== 'drop') {
      if (opts.notes === 'footnotes') text += '[' + entries.find(d => key(d) === key(part)).n + ']';
      else text = opts.links === 'markdown' && safeUrl(part.link) ? '[' + text + '](' + part.link + ')' : text + ' (' + (safeUrl(part.link) || 'Unsafe link omitted') + ')';
    }
    return opts.bold === 'markdown' && part.style?.includes('bold') ? '**' + text + '**' : text;
  };
  let text = (lines || []).map(line => {
    const body = line.spacer ? '' : (line.parts || []).map(draw).join('');
    return body && opts.bold === 'markdown' && line.style?.includes('bold') ? '**' + body + '**' : body;
  }).join('\n');
  if (opts.notes === 'footnotes') text += entries.filter(d => d.note || opts.links !== 'drop').map(d => '\n[' + d.n + '] ' + d.label + ': ' + (d.note ? renderText(d.note, { ...opts, notes: 'inline' }) : safeUrl(d.link) || 'Unsafe link omitted')).join('');
  return text;
}
/** Return content, not a tooltip window. icon(id) may replace bundled artwork. */
export function renderDom(lines, options = {}) {
  const opts = { notes: 'popover', interactive: true, ...options };
  const root = node(opts.nested ? 'span' : 'div', null, 'clarity-tooltip');
  if (typeof lines === 'string') { root.textContent = lines; return root; }
  const entries = details(lines);
  let expansions = [];
  const draw = part => {
    const entry = entries.find(d => key(d) === key(part));
    let result = node('span', part.text || '');
    if (part.icon && hasIcon(part.icon)) {
      result = node('span', null, 'clarity-icon clarity-icon-' + part.icon);
      result.setAttribute('role', 'img'); result.setAttribute('aria-label', part.icon);
      const override = opts.icon?.(part.icon);
      if (override) result.append(override);
      else {
        const picture = node('picture');
        for (const theme of ['light', 'dark']) {
          const image = node('img', null, 'clarity-art-' + theme);
          image.alt = ''; image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(artwork[part.icon][theme]);
          picture.append(image);
        }
        result.append(picture);
      }
    } else if (part.note) {
      if (opts.notes === 'inline' || opts.nested) {
        result.append(document.createTextNode(' ('), renderDom(part.note, { ...opts, notes: 'inline', nested: true, interactive: false }), document.createTextNode(')'));
      } else if (opts.interactive && opts.notes !== 'numbered') {
        const wrapper = node('span', null, 'clarity-term');
        result = node('button', part.text || '', 'clarity-note'); result.type = 'button';
        const body = node(opts.notes === 'expand' ? 'div' : 'span', null, 'clarity-note-body');
        body.id = 'clarity-note-' + (++serial); body.hidden = true;
        body.append(renderDom(part.note, { ...opts, notes: 'inline', nested: true, interactive: false }));
        result.setAttribute('aria-controls', body.id);
        result.dataset.clarityDetail = String(entry.n);
        if (opts.notes === 'expand') {
          body.classList.add('clarity-expansion');
          expansions.push(body);
          result.setAttribute('aria-expanded', 'false');
          result.onclick = () => { body.hidden = !body.hidden; result.setAttribute('aria-expanded', String(!body.hidden)); };
        } else {
          body.classList.add('clarity-popover'); body.setAttribute('role', 'tooltip');
          result.setAttribute('aria-describedby', body.id);
          const hide = () => { body.hidden = true; };
          const show = () => {
            body.hidden = false;
            const rect = result.getBoundingClientRect();
            const width = Math.min(320, document.documentElement.clientWidth - 16);
            body.style.width = width + 'px';
            body.style.left = Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - width - 8)) + 'px';
            body.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - body.offsetHeight - 8)) + 'px';
          };
          wrapper.onpointerenter = event => { if (event.pointerType !== 'touch') show(); };
          wrapper.onpointerleave = hide; result.onfocus = show; result.onblur = hide;
          result.onclick = () => { if (body.hidden) show(); else hide(); };
          result.onkeydown = event => { if (event.key === 'Escape') { event.stopPropagation(); hide(); } };
        }
        wrapper.append(result);
        if (opts.notes !== 'expand') wrapper.append(body);
        decorate(wrapper, part); return wrapper;
      }
    } else if (part.link) {
      const url = safeUrl(part.link);
      result = node(opts.interactive && url ? 'a' : 'span', part.text || '', opts.interactive && url ? 'clarity-link' : '');
      if (opts.interactive && url) { result.href = url; result.rel = 'noreferrer'; }
    }
    if (entry) result.dataset.clarityDetail = String(entry.n);
    if (entry && opts.notes === 'numbered') result.append(node('sup', '[' + entry.n + ']'));
    decorate(result, part); return result;
  };
  for (const line of lines || []) {
    expansions = [];
    if (opts.nested && root.childNodes.length) root.append(document.createTextNode(' '));
    const row = node(opts.nested ? 'span' : 'div', null, line.spacer ? 'clarity-line clarity-spacer' : 'clarity-line');
    decorate(row, line);
    const parts = line.parts || [];
    if (parts.some(part => hasIcon(part.icon))) {
      const layout = parts.map(part => ({
        text: part.text,
        symbol: part.icon === 'arrow' ? 'arrow' : hasIcon(part.icon) ? 'icon' : undefined,
        atomic: Boolean(part.note || part.link),
      }));
      const drawSlice = ({ index, from, to }) => {
        const part = parts[index];
        return draw(from === 0 && to === (part.text || '').length
          ? part : { ...part, text: part.text.slice(from, to) });
      };
      const runs = wrapRuns(layout);
      for (const { glued, slices } of runs) {
        if (!glued) {
          row.append(...slices.map(drawSlice));
          continue;
        }
        const group = node('span', null, 'clarity-glue');
        for (const edge of wrapEdges(layout, slices)) {
          const target = edge.glued ? node('span', null, 'clarity-join') : group;
          target.append(...edge.slices.map(drawSlice));
          if (edge.glued) group.append(target);
        }
        row.append(group);
      }
    } else row.append(...parts.map(draw));
    root.append(row);
    root.append(...expansions);
  }
  return root;
}
export function renderDetails(lines, options = {}) {
  const list = node('ol', null, 'clarity-details');
  for (const entry of details(lines)) {
    const item = node('li'); item.value = entry.n; item.dataset.clarityDetail = String(entry.n);
    item.append(node('strong', entry.label + ': '));
    if (entry.note) item.append(renderDom(entry.note, { ...options, notes: 'inline', nested: true }));
    else {
      const url = safeUrl(entry.link);
      const address = node(options.interactive === false || !url ? 'span' : 'a', url || 'Unsafe link omitted');
      if (address.tagName === 'A') { address.href = url; address.rel = 'noreferrer'; }
      item.append(address);
    }
    list.append(item);
  }
  return list;
}
`;
