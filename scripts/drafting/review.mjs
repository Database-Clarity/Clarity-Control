// Update the owner's existing review document, keeping its controls and database
// paths intact. No feedback is written: the supplied answers are only initial UI
// state, followed by the document's existing live subscription.
import { JSDOM } from 'jsdom';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function reviseReview(html, revisions, feedback, previous = {}) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  for (const [hash, english] of Object.entries(revisions)) {
    if (hash === '_meta') continue;
    if (!/^\d+$/.test(hash) || feedback[hash]?.verdict !== 'change')
      throw new Error(`Revision lacks a change verdict: ${hash}`);
    const control = document.querySelector(`.fb[data-hash="${hash}"]`);
    const article = control?.closest('article');
    const columns = article?.querySelector('.cols');
    const oldDraft = columns?.children[1];
    if (!columns || !oldDraft) throw new Error(`Missing review row ${hash}`);
    oldDraft.querySelector('.lbl').textContent = 'Previous draft · v4.5';
    // Use the exact draft data, avoiding entity/highlighter damage in the older
    // page (for example an apostrophe painted as a #global reference).
    if (previous[hash] !== undefined) oldDraft.querySelector('pre').textContent = previous[hash];
    columns.querySelector('[data-redraft]')?.remove();
    const section = document.createElement('section');
    section.setAttribute('data-redraft', 'v4.6');
    const label = document.createElement('div');
    label.className = 'lbl';
    label.textContent = 'Revised draft · v4.6';
    const pre = document.createElement('pre');
    pre.textContent = english;
    section.append(label, pre);
    columns.append(section);
    columns.classList.add('revision-cols');
  }
  for (const [hash, answer] of Object.entries(feedback)) {
    if (!/^\d+$/.test(hash)) throw new Error(`Invalid feedback hash: ${hash}`);
    const control = document.querySelector(`.fb[data-hash="${hash}"]`);
    if (!control) throw new Error(`Missing feedback row ${hash}`);
    for (const button of control.querySelectorAll('button[data-v]'))
      button.setAttribute('aria-pressed', String(button.dataset.v === answer.verdict));
    control.querySelector('textarea').textContent = answer.note ?? '';
    control.querySelector('.st').textContent = 'Existing answer';
  }
  const tally = document.querySelector('#tally');
  if (tally) {
    const answers = Object.values(feedback);
    const count = (verdict) => answers.filter((answer) => answer.verdict === verdict).length;
    tally.textContent = `${count('ok')} good · ${count('change')} need change · ${count('drop')} drop · ${document.querySelectorAll('.fb').length - answers.filter((answer) => answer.verdict).length} not marked yet. Existing answers describe the previous drafts.`;
  }
  const seed = JSON.stringify(feedback).replace(/</g, '\\u003c');
  const script = [...document.scripts].find((script) => script.textContent.includes('const state='));
  if (!script || !script.textContent.includes('const state={};'))
    throw new Error('Unexpected review script; refuse to replace feedback handling');
  script.textContent = script.textContent.replace('const state={};', `const state=${seed};`);
  // Initial answers stay visible even when offline. Never save seeded answers.
  script.textContent = script.textContent.replace(/\ncount\(\);\s*\n\}\)\(\);/, '\nObject.keys(state).forEach(paint);count();\n})();');
  const style = document.createElement('style');
  style.textContent = '.revision-cols{grid-template-columns:1fr 1fr 1fr}@media(max-width:900px){.revision-cols{grid-template-columns:1fr}}';
  document.head.append(style);
  document.querySelector('.lede').textContent += ' Fourteen changed drafts now show Sol medium v4.6 revisions beside the original Sonnet v4.5 text. Existing answers and notes are retained; their verdicts still describe the earlier draft until you change them. The remaining drafts are unchanged.';
  return dom.serialize();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [page, revisionFile, feedbackFile, output, previousFile] = process.argv.slice(2);
  if (!output) throw new Error('Usage: review.mjs <old-page> <revisions.json> <feedback.json> <output-page>');
  const [html, revisionText, feedbackText] = await Promise.all([readFile(page, 'utf8'), readFile(revisionFile, 'utf8'), readFile(feedbackFile, 'utf8')]);
  const previous = previousFile ? JSON.parse(await readFile(previousFile, 'utf8')) : {};
  await writeFile(output, reviseReview(html, JSON.parse(revisionText), JSON.parse(feedbackText), previous));
}
