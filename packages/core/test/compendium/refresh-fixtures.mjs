import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse, serialize } from 'parse5';

const directory = new URL('./fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
function all(node, tag) {
  return (node.childNodes ?? []).flatMap((child) =>
    [...(child.tagName === tag ? [child] : []), ...all(child, tag)]);
}
function text(node) { return node.value ?? (node.childNodes ?? []).map(text).join(''); }
for (const [name, gid, count] of [
  ['weapon', '1662574278', 9], ['arc', '618967225', 9], ['armor', '1287885342', 7],
]) {
  const source = `https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview/sheet?headers=true&gid=${gid}`;
  const html = process.argv[2] ? await readFile(`${process.argv[2]}\\compendium-1027-${name}.html`, 'utf8')
    : await (await fetch(source)).text();
  const doc = parse(html);
  const table = all(doc, 'table').find((node) =>
    node.attrs.some((attr) => attr.name === 'class' && attr.value.includes('waffle')));
  const rows = all(table, 'tr').slice(0, count);
  const kept = rows.map((row) => serialize({ nodeName: '#document-fragment', childNodes: [row] })).join('\n');
  const classes = new Set([...kept.matchAll(/class="([^"]+)"/g)].flatMap(([, value]) => value.split(/\s+/)));
  const css = all(doc, 'style').map(text).join('\n');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => [...selectors.matchAll(/\.([\w-]+)/g)]
      .some(([, name]) => classes.has(name)))
    .map(([rule]) => rule).join('\n');
  const fixture = `<!doctype html>\n<!-- Source: ${source}\nFetched: ${new Date().toISOString()}\nSHA256 of full source: ${createHash('sha256').update(html).digest('hex')}\nTrim: first ${count} rows; matching stylesheet rules; no images/scripts. -->\n<style>${rules}</style>\n<div class="ritz"><table class="waffle"><tbody>\n${kept.replace(/<img\b[^>]*>/g, '')}\n</tbody></table></div>\n`;
  await writeFile(new URL(`${name}.html`, directory), fixture);
}
const landingSource = process.argv[2]
  ? await readFile(`${process.argv[2]}\\compendium-1027-landing.html`, 'utf8')
  : await (await fetch('https://docs.google.com/spreadsheets/d/1WaxvbLx7UoSZaBqdFr1u32F2uWVLo-CJunJB4nlGUE4/htmlview')).text();
const entries = [...landingSource.matchAll(/items\.push\(\{name:[\s\S]*?\}\);/g)].map(([entry]) => entry);
await writeFile(new URL('landing.html', directory),
  `<!doctype html><!-- Landing htmlview tab-switcher data only; fetched ${new Date().toISOString()} -->\n<script>\n${entries.join('\n')}\n</script>\n`);
