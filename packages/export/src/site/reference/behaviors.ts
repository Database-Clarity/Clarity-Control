// These are host examples, not reference-renderer options. The page executes the same examples
// it offers for copying. Return a cleanup function before replacing a tooltip's content.
export const behaviorSource = String.raw`// SPDX-License-Identifier: MIT
export function holdDetails(host, panel) {
  const abort = new AbortController(), options = { signal: abort.signal };
  panel.hidden = true;
  document.addEventListener('keydown', event => {
    if (event.key.toLowerCase() === 'd' && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !event.target.closest('input,select,textarea,[contenteditable]') && host.matches(':hover,:focus-within')) panel.hidden = false;
  }, options);
  const hide = () => { panel.hidden = true; };
  document.addEventListener('keyup', event => { if (event.key.toLowerCase() === 'd') hide(); }, options);
  window.addEventListener('blur', hide, options);
  host.addEventListener('focusout', hide, options);
  host.addEventListener('pointerleave', hide, options);
  return () => abort.abort();
}
export function sheetDetails(host, panel, dialog) {
  const abort = new AbortController(); let opener;
  host.addEventListener('click', event => {
    const term = event.target.closest('.clarity-note,.clarity-link');
    if (!term) return;
    event.preventDefault(); event.stopPropagation(); opener = term;
    const detail = panel.querySelector('[data-clarity-detail="' + term.dataset.clarityDetail + '"]');
    if (!detail) return;
    const content = detail.cloneNode(true);
    content.querySelector('strong')?.remove();
    dialog.querySelector('h3').textContent = term.textContent;
    const body = dialog.querySelector('[data-body]');
    body.replaceChildren(...content.childNodes);
    if (term.matches('a')) {
      const address = body.querySelector('a');
      address.textContent = term.href;
      const open = document.createElement('a');
      open.className = 'sheet-open-link'; open.textContent = 'Open link';
      open.href = term.href; open.target = '_blank'; open.rel = 'noreferrer';
      body.append(document.createElement('br'), open);
    }
    dialog.showModal();
  }, { capture: true, signal: abort.signal });
  dialog.addEventListener('close', () => opener?.focus(), { signal: abort.signal });
  return () => abort.abort();
}
export function tapAgain(trigger, panel) {
  // The app has already selected the perk and opened its tooltip. The next tap toggles details.
  panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
  const toggle = () => { panel.hidden = !panel.hidden; trigger.setAttribute('aria-expanded', String(!panel.hidden)); };
  trigger.addEventListener('click', toggle);
  return () => trigger.removeEventListener('click', toggle);
}
export function longPress(trigger, panel) {
  const abort = new AbortController(), options = { signal: abort.signal };
  let timer, start;
  panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
  const cancel = () => clearTimeout(timer);
  const open = () => { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); };
  trigger.addEventListener('pointerdown', event => {
    cancel(); start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(open, 500);
  }, options);
  trigger.addEventListener('pointermove', event => {
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancel();
  }, options);
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) trigger.addEventListener(type, cancel, options);
  trigger.addEventListener('contextmenu', event => { if (!panel.hidden) event.preventDefault(); }, options);
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    if (event.key === 'Escape') { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
  }, options);
  return () => { cancel(); abort.abort(); };
}
`;

export const pageSource = String.raw`
import { decode, renderDom, renderDetails } from './clarity-tooltip.js';
import { holdDetails, sheetDetails, tapAgain, longPress } from './display-examples.js';
const $ = id => document.getElementById(id);
document.documentElement.classList.add('js');
const showcase = JSON.parse($('showcase-data').textContent);
let perks = decode(showcase), selected = '-1', cleanups = [], request;
const concepts = [
  ['DI-P1','popover',true], ['DI-P3','expand',true],
  ['DN-P1','numbered',false], ['DN-P2','numbered',false],
  ['TI-P1','expand',true], ['TI-P2','expand',true],
  ['TN-P1','numbered',false], ['TN-P2','numbered',false], ['TN-P3','numbered',false],
];
function draw() {
  cleanups.forEach(cleanup => cleanup()); cleanups = [];
  const perk = perks[selected] || perks['-1'];
  const language = Object.hasOwn(perk.descriptions, $('language').value) ? $('language').value : 'en';
  const lines = perk.descriptions[language] || '';
  $('selected-name').textContent = perk.name || selected;
  $('live-summary').replaceChildren(renderDom(lines, { notes: 'popover' }));
  $('live-json').textContent = JSON.stringify({ ...perk, descriptions: { [language]: lines } }, null, 2);
  for (const [id, notes, interactive] of concepts) {
    const host = $(id), output = host.querySelector('[data-render]');
    const tip = document.createElement('div'); tip.className = 'tip';
    const name = document.createElement('strong'); name.className = 'tip-name'; name.textContent = perk.name || selected;
    tip.append(name, renderDom(lines, { notes, interactive }));
    const panel = renderDetails(lines, { interactive });
    panel.id = id + '-details';
    tip.append(panel); output.replaceChildren(tip);
    const trigger = host.querySelector('.perk-trigger');
    if (trigger) trigger.setAttribute('aria-controls', panel.id);
    if (id === 'DI-P1' || id === 'DI-P3' || id === 'TI-P2') panel.hidden = true;
    if (id === 'DN-P1') cleanups.push(holdDetails(host, panel));
    if (id === 'TI-P1') { panel.hidden = true; cleanups.push(sheetDetails(tip, panel, $('details-sheet'))); }
    if (id === 'TN-P1') cleanups.push(tapAgain(trigger, panel));
    if (id === 'TN-P3') cleanups.push(longPress(trigger, panel));
  }
}
function choices() {
  const query = $('query').value.trim().toLowerCase();
  const matches = Object.entries(perks).filter(([hash, perk]) => hash === '-1' || (hash + ' ' + (perk.name || '')).toLowerCase().includes(query));
  const real = matches.filter(([hash]) => hash !== '-1');
  const count = real.length + (real.length === 1 ? ' perk' : ' perks');
  $('match-count').textContent = query ? real.length + (real.length === 1 ? ' matching perk' : ' matching perks') + '; showcase always available.' : count + ' and the feature showcase.';
  $('picker').replaceChildren(...matches.sort(([a], [b]) => a === '-1' ? -1 : b === '-1' ? 1 : 0).map(([hash, perk]) => {
    const option = document.createElement('option'); option.value = hash; option.textContent = hash === '-1' ? 'Feature showcase' : (perk.name || 'Perk') + ' (' + hash + ')'; return option;
  }));
  if (!matches.some(([hash]) => hash === selected)) selected = '-1';
  $('picker').value = selected; draw();
}
async function load() {
  request?.abort(); request = new AbortController(); const signal = request.signal;
  $('load-state').textContent = 'Loading the published file…'; $('retry').hidden = true;
  try {
    const response = await fetch('./v1/lines/' + $('language').value + '.json', { signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const file = await response.json();
    if (signal.aborted) return;
    perks = decode(file);
    // Showcase is available even when a carried file predates its introduction.
    if (!perks['-1']) perks['-1'] = decode(showcase)['-1'];
    $('file-json').textContent = JSON.stringify({ ...file, descriptions: file.descriptions.slice(0, 1), perks: Object.fromEntries(Object.entries(file.perks).slice(0, 2)) }, null, 2);
    const textResponse = await fetch('./v1/text/' + $('language').value + '.json', { signal });
    if (textResponse.ok) {
      const textPerks = decode(await textResponse.json());
      if (!signal.aborted) $('text-example').textContent = textPerks['-1']?.descriptions[$('language').value] || '';
    }
    if (signal.aborted) return;
    $('load-state').textContent = 'Published file loaded.'; choices();
  } catch (error) {
    if (signal.aborted) return;
    perks = decode(showcase); selected = '-1';
    $('load-state').textContent = 'Could not load the published file. Showing the English feature showcase. Retry to load this language.';
    $('retry').hidden = false; choices();
  }
}
$('query').addEventListener('input', choices);
$('picker').addEventListener('change', () => { selected = $('picker').value; draw(); });
$('language').addEventListener('change', load); $('retry').addEventListener('click', load);
$('theme').addEventListener('change', () => {
  if ($('theme').value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = $('theme').value;
});
$('details-sheet').querySelector('button').onclick = () => $('details-sheet').close();
$('details-sheet').addEventListener('click', event => { if (event.target === $('details-sheet')) {
  const r = event.target.getBoundingClientRect();
  if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close();
} });
for (const feature of document.querySelectorAll('[data-feature]')) {
  const example = JSON.parse(document.querySelector('[data-example="' + feature.dataset.feature + '"]').textContent);
  feature.replaceChildren(renderDom(Array.isArray(example) ? example : [example.parts || example.spacer ? example : { parts: [example] }], { notes: 'inline' }));
}
for (const button of document.querySelectorAll('[data-copy]')) button.onclick = async () => {
  try { await navigator.clipboard.writeText($(button.dataset.copy).textContent); button.textContent = 'Copied'; }
  catch { button.textContent = 'Select the code to copy'; }
};
choices(); load();
`;
