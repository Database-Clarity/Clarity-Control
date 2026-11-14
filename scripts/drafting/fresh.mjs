import { createHash } from 'node:crypto';
import { styleLint } from './style.mjs';
import { escapeHtml } from './pipeline.mjs';

export const draftDigest = (drafts) => createHash('sha256').update(JSON.stringify({
  english: Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== '_meta').sort(([a], [b]) => Number(a) - Number(b))),
  sourceWarnings: drafts._meta?.sourceWarnings ?? {},
})).digest('hex');
export const sampleInputDigest = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// This is the only fresh-sample renderer: stale, unchecked, or uncritiqued rows
// cannot enter the owner-facing page, including rows previously marked ok.
export function freshPage(input, drafts, validation, critique) {
  const hashes = input.items.map((item) => String(item.hash));
  if (new Set(hashes).size !== hashes.length) throw new Error('Duplicate sample hash');
  if (input.styleGuide !== 'v4.7' || critique.guideKitSha256 !== input.guideKitSha256)
    throw new Error('Guide version/checksum mismatch');
  if (drafts._meta?.guideKitSha256 !== input.guideKitSha256)
    throw new Error('Drafts lack the current guide checksum');
  if (critique.verdict !== 'APPROVE' || critique.draftDigest !== draftDigest(drafts) || critique.inputDigest !== sampleInputDigest(input))
    throw new Error('Independent critique approval does not cover these exact drafts');
  if (Object.keys(validation.errors).length || Object.keys(validation.accepted).length !== hashes.length)
    throw new Error('Sample validation is incomplete');
  for (const item of input.items) {
    const english = drafts[item.hash];
    if (input.excludedHashes.includes(item.hash) || input.excludedNames.includes(item.name))
      throw new Error(`Previously shown tooltip: ${item.hash}`);
    if (typeof english !== 'string' || validation.accepted[item.hash] !== english || styleLint(english).length)
      throw new Error(`Ungated draft: ${item.hash}`);
    if (!item.ownerPrecedents?.length) throw new Error(`Missing owner precedent: ${item.hash}`);
    if (!drafts._meta?.precedentUse?.[item.hash]) throw new Error(`Missing precedent application: ${item.hash}`);
  }
  const e = escapeHtml;
  const rows = input.items.map((item) => {
    // Input warnings are questions for the drafter/critic, not page copy. Only
    // the exact warning text approved with this draft is shown to the owner.
    const warnings = [...new Set(drafts._meta?.sourceWarnings?.[item.hash] ?? [])];
    return `<article data-hash="${item.hash}"><header><h2>${e(item.name)}</h2><span>${e(item.group)}</span></header><pre>${e(drafts[item.hash])}</pre>${warnings.length ? `<aside aria-label="Source uncertainty"><strong>Source check</strong><ul>${warnings.map((warning) => `<li>${e(warning)}</li>`).join('')}</ul></aside>` : ''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fresh tooltip sample · v4.7</title><style>
:root{color-scheme:light dark;font-family:var(--font-sans,system-ui);color:var(--foreground,CanvasText);--line:var(--border,GrayText)}body{margin:0}main{max-width:960px;margin:auto}h1{font-size:18px;margin:12px 0 6px}p{font-size:13px;color:var(--muted-foreground,#9099a7)}article{border-top:1px solid var(--line);padding:14px 0}header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}h2{font-size:15px;margin:0}header span{font-size:12px;color:var(--muted-foreground,#9099a7)}pre{font:13px/1.65 var(--font-mono,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0 0}aside{font-size:12px;border-left:2px solid var(--warning,#b48b47);padding:6px 10px;margin-top:10px}aside ul{margin:4px 0;padding-left:18px}</style></head><body><main><h1>Fresh tooltip sample · v4.7</h1><p>${hashes.length} new tooltips. Raw Clarity markup. Source checks identify unresolved source mechanics. The full drafting run remains on hold.</p>${rows}</main></body></html>`;
}
