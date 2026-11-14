import { escapeHtml } from './pipeline.mjs';
import { draftDigest, sampleInputDigest } from './fresh.mjs';
import { styleLint } from './style.mjs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

export const revisionDigest = drafts => createHash('sha256').update(JSON.stringify({
  draftDigest: draftDigest(drafts), whatChanged: drafts._meta?.whatChanged,
})).digest('hex');

// Preserve the owner's published template and CSS; replace reading surfaces only.
export function revisionFromTemplate(html, input, drafts, validation, critique) {
  const expectedCount = { 'v4.9': 5, 'v4.10': 2 }[input.styleGuide];
  if (!expectedCount || input.items.length !== expectedCount || critique.verdict !== 'APPROVE' ||
      critique.digestsReproduced !== true || critique.draftDigest !== draftDigest(drafts) ||
      critique.revisionDigest !== revisionDigest(drafts) || critique.inputDigest !== sampleInputDigest(input) ||
      critique.guideKitSha256 !== input.guideKitSha256 || drafts._meta.guideKitSha256 !== input.guideKitSha256)
    throw Error('Exact v4.9 approval required');
  if (Object.keys(validation.errors).length || Object.keys(validation.accepted).length !== expectedCount)
    throw Error('All five validations required');
  const document = new JSDOM(html).window.document;
  const wanted = new Map(input.items.map(i => [String(i.hash), i]));
  for (const row of document.querySelectorAll('article[data-hash]')) {
    const hash = row.dataset.hash, item = wanted.get(hash);
    if (!item) { row.remove(); continue; }
    if (item.ownerFeedback.verdict !== 'change' || critique.checksByHash[hash] !== 'PASS' ||
        validation.accepted[hash] !== drafts[hash] || styleLint(drafts[hash]).length || !drafts._meta.whatChanged[hash])
      throw Error(`Ungated revision ${hash}`);
    row.querySelector('.note').textContent = item.ownerFeedback.note;
    row.querySelector('pre').textContent = drafts[hash];
    row.querySelector('.changed').textContent = 'What changed: ' + drafts._meta.whatChanged[hash];
    row.querySelectorAll('aside,.inherited').forEach(el => el.remove());
    row.querySelectorAll('button').forEach(el => el.setAttribute('aria-pressed', 'false'));
    row.querySelector('textarea').value = '';
    row.querySelector('textarea').textContent = '';
    row.querySelector('.st').textContent = '';
  }
  if (document.querySelectorAll('article[data-hash]').length !== expectedCount) throw Error('Template lacks a revised row');
  document.title = `Tooltip revisions · ${input.styleGuide}`;
  document.querySelector('h1').textContent = document.title;
  document.querySelector('.top-in > p').textContent = `${expectedCount} revised tooltips. Your note, new text, and what changed. Approved texts are retained; unused mods are excluded.`;
  const script = [...document.scripts].find(s => /db.collection\('feedback(?:48|49)'\)/.test(s.textContent));
  if (!script) throw Error('Unexpected feedback template');
  script.textContent = script.textContent.replace(/feedback(?:48|49)/g, `feedback${input.styleGuide.replace(/\D/g, '')}`);
  return document.documentElement.outerHTML;
}

export function revisionPage(input, drafts, validation, critique) {
  const hashes = input.items.map(i => String(i.hash));
  if (input.styleGuide !== 'v4.8' || new Set(hashes).size !== 23 || hashes.length !== 23)
    throw Error('Expected the 23 v4.8 change items');
  if (drafts._meta?.guideKitSha256 !== input.guideKitSha256 || critique.guideKitSha256 !== input.guideKitSha256 ||
      critique.verdict !== 'APPROVE' || critique.digestsReproduced !== true || critique.draftDigest !== draftDigest(drafts) || critique.revisionDigest !== revisionDigest(drafts) || critique.inputDigest !== sampleInputDigest(input))
    throw Error('Exact independent approval required');
  if (Object.keys(validation.errors).length || Object.keys(validation.accepted).length !== 23)
    throw Error('Complete validation required');
  const e = escapeHtml;
  const rows = input.items.map(item => {
    const hash = String(item.hash), english = drafts[hash], changed = drafts._meta.whatChanged?.[hash];
    if (item.ownerFeedback?.verdict !== 'change' || typeof english !== 'string' || validation.accepted[hash] !== english ||
        styleLint(english).length || critique.checksByHash?.[hash] !== 'PASS' || !changed || /\n/.test(changed))
      throw Error(`Ungated revision: ${hash}`);
    const warnings = drafts._meta.sourceWarnings?.[hash] ?? [];
    const inherited = ['2077016094', '2733010662', '2734970071', '3458160468'].includes(hash)
      ? `<p class="inherited">${e("Inherited from Arc Siphon: its text says 'Mods equipped' (capital M); edit Arc Siphon in the editor if you want it lowercase.")}</p>` : '';
    return `<article data-hash="${hash}"><h2>${e(item.name)}</h2><div class="label">Your note</div><p class="note">${e(item.ownerFeedback.note)}</p><div class="label">New text</div><pre>${e(english)}</pre>${warnings.length ? `<aside>${warnings.map(e).join('<br>')}</aside>` : ''}${inherited}<p class="changed">What changed: ${e(changed)}</p><div class="fb" data-hash="${hash}"><div role="group" aria-label="Verdict for ${e(item.name)}"><button data-v="ok" aria-pressed="false">Good</button><button data-v="change" aria-pressed="false">Needs change</button><button data-v="drop" aria-pressed="false">Drop</button></div><textarea aria-label="Optional new note for ${e(item.name)}" placeholder="New note (optional)"></textarea><span class="st" role="status"></span></div></article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tooltip revisions · v4.8</title><style>
:root{color-scheme:light dark;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground,CanvasText)}body{margin:0}main{max-width:900px;margin:auto}h1{font-size:19px}h2{font-size:16px;margin:0 0 10px}article{padding:18px 0;border-top:1px solid var(--border,GrayText)}.label{font-size:12px;font-weight:600}.note{white-space:pre-wrap;margin:4px 0 14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 var(--font-mono,ui-monospace,monospace);margin:4px 0 12px}.changed{font-size:13px}aside{border-left:2px solid var(--warning,#bd8430);padding-left:10px;font-size:13px}button{font:inherit;min-height:40px;padding:6px 12px;border:1px solid GrayText;border-radius:4px;color:CanvasText;background:Canvas;margin:0 5px 5px 0}button[aria-pressed=true]{background:Highlight;color:HighlightText}textarea{display:block;box-sizing:border-box;width:100%;min-height:54px;font:inherit;color:CanvasText;background:Canvas;border:1px solid GrayText;border-radius:4px;padding:7px}.st,#tally,#offline{font-size:12px}</style></head><body><main><h1>Tooltip revisions · v4.8</h1><p>23 revised tooltips. Your note, new text, and what changed. The six approved tooltips are unchanged.</p><p id="tally">Connecting saved answers…</p><p id="offline" hidden>Saving is unavailable in this view. Open the published review page to mark verdicts.</p>${rows}</main><script>${feedbackScript}</script></body></html>`;
}

// New collection only. No seeded old verdicts, and no writes until an action.
export const feedbackScript = `
(async()=>{
const controls=[...document.querySelectorAll('.fb')],state={},busy={};
let db;try{db=await window.claude?.use?.('db')}catch{}
if(!db){document.querySelector('#offline').hidden=false;document.querySelector('#tally').textContent='';controls.forEach(el=>el.querySelectorAll('button,textarea').forEach(x=>x.disabled=true));return}
function paint(h){const el=controls.find(x=>x.dataset.hash===h),s=state[h]||{};if(!el)return;el.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.v===s.verdict)));if(document.activeElement!==el.querySelector('textarea'))el.querySelector('textarea').value=s.note||''}
function count(){const vals=Object.values(state);document.querySelector('#tally').textContent=vals.filter(s=>s.verdict==='ok').length+' good · '+vals.filter(s=>s.verdict==='change').length+' need change · '+vals.filter(s=>s.verdict==='drop').length+' drop · '+(controls.length-vals.filter(s=>s.verdict).length)+' unmarked'}
async function save(h,patch,el){state[h]={...(state[h]||{}),...patch};paint(h);count();if(busy[h]){busy[h].again=true;return}busy[h]={};const status=el.querySelector('.st');status.textContent='Saving…';try{do{busy[h].again=false;const s=state[h];await db.doc('feedback48/'+h).set({verdict:s.verdict||null,note:s.note||'',at:new Date().toISOString()})}while(busy[h].again);status.textContent='Saved'}catch{status.textContent='Not saved — try again'}finally{delete busy[h]}}
controls.forEach(el=>{const h=el.dataset.hash,ta=el.querySelector('textarea');let timer;el.querySelectorAll('button').forEach(b=>b.onclick=()=>{clearTimeout(timer);save(h,{verdict:state[h]?.verdict===b.dataset.v?null:b.dataset.v,note:ta.value},el)});ta.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>save(h,{note:ta.value},el),700)};ta.onblur=()=>{clearTimeout(timer);if((state[h]?.note||'')!==ta.value)save(h,{note:ta.value},el)}});
db.collection('feedback48').onSnapshot(snap=>{snap.docs.forEach(d=>{if(busy[d.id])return;state[d.id]=d.data()||{};paint(d.id)});count()},()=>{document.querySelector('#tally').textContent='Saved answers unavailable; new answers can still save.'});count();
})();`;
