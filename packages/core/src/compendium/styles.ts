import { attr, type HtmlElement } from './html.js';
import type { CompendiumStyle } from './types.js';

type Declarations = Record<string, string>;
interface Rule {
  selector: string;
  declarations: Declarations;
  weight: number;
}
export function declarations(css: string): Declarations {
  return Object.fromEntries(
    css.split(';').flatMap((declaration) => {
      const separator = declaration.indexOf(':');
      return separator < 0
        ? []
        : [
            [
              declaration.slice(0, separator).trim().toLowerCase(),
              declaration
                .slice(separator + 1)
                .trim()
                .toLowerCase(),
            ],
          ];
    }),
  );
}
export function cssRules(css: string): Rule[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .flatMap(([, selectors, body]) =>
      selectors.split(',').map((selector) => ({
        selector: selector.trim(),
        declarations: declarations(body),
        weight:
          (selector.match(/#/g)?.length ?? 0) * 100 +
          (selector.match(/\./g)?.length ?? 0) * 10 +
          (selector.match(/(?:^|\s)[a-z]+/gi)?.length ?? 0),
      })),
    )
    .sort((a, b) => a.weight - b.weight);
}
function simpleMatch(node: HtmlElement, selector: string): boolean {
  if (!/^(?:[a-z][\w-]*|\*)?(?:[.#][\w-]+)*$/i.test(selector)) return false;
  const tag = /^[a-z][\w-]*/i.exec(selector)?.[0];
  if (tag && node.tagName !== tag.toLowerCase()) return false;
  return [...selector.matchAll(/([.#])([\w-]+)/g)].every(([, kind, value]) =>
    kind === '#' ? attr(node, 'id') === value : attr(node, 'class').split(/\s+/).includes(value),
  );
}
function matches(node: HtmlElement, selector: string): boolean {
  const parts = selector.split(/\s+/);
  if (!simpleMatch(node, parts.pop() ?? '')) return false;
  let parent = node.parentNode;
  while (parts.length && parent) {
    if ('tagName' in parent && simpleMatch(parent, parts.at(-1)!)) parts.pop();
    parent = 'parentNode' in parent ? parent.parentNode : null;
  }
  return !parts.length;
}
export function colour(value: string): string | undefined {
  const variable = /^var\(--[^,]+,\s*(.+)\)$/.exec(value);
  if (variable) return colour(variable[1].trim());
  const short = /^#([\da-f])([\da-f])([\da-f])([\da-f])?$/i.exec(value);
  if (short)
    return `#${short
      .slice(1)
      .filter(Boolean)
      .map((part) => part + part)
      .join('')}`.toLowerCase();
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value))
    return value.toLowerCase().replace(/^(.{7})ff$/, '$1');
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value);
  if (rgb && rgb.slice(1).every((part) => Number(part) <= 255)) {
    return (
      '#' +
      rgb
        .slice(1)
        .map((part) => Number(part).toString(16).padStart(2, '0'))
        .join('')
    );
  }
  return (
    {
      black: '#000000',
      white: '#ffffff',
      red: '#ff0000',
      blue: '#0000ff',
      green: '#008000',
      yellow: '#ffff00',
      gray: '#808080',
    } as Record<string, string>
  )[value];
}
function apply(style: CompendiumStyle, css: Declarations): CompendiumStyle {
  const next = { ...style };
  if (css.color && css.color !== 'inherit') {
    const color = colour(css.color);
    if (!color) throw new Error(`Unsupported Compendium text colour: ${css.color}`);
    next.color = color;
  }
  for (const [property, field, enabled] of [
    ['font-weight', 'bold', /^(bold|bolder|[6-9]00)$/],
    ['font-style', 'italic', /^(italic|oblique)$/],
  ] as const) {
    const value = css[property];
    if (value && value !== 'inherit') {
      if (enabled.test(value)) next[field] = true;
      else delete next[field];
    }
  }
  const decoration = css['text-decoration'] ?? css['text-decoration-line'];
  if (decoration && decoration !== 'inherit') {
    if (decoration.includes('underline')) next.underline = true;
    else delete next.underline;
    if (decoration.includes('line-through')) next.strike = true;
    else delete next.strike;
  }
  const size = /^([\d.]+)(pt|px|em|%)$/.exec(css['font-size'] ?? '');
  if (size) {
    const value = Number(size[1]);
    next.sizePt =
      Math.round(
        (size[2] === 'px'
          ? value * 0.75
          : size[2] === 'em'
            ? value * (style.sizePt ?? 10)
            : size[2] === '%'
              ? (value / 100) * (style.sizePt ?? 10)
              : value) * 1000,
      ) / 1000;
  }
  return next;
}
export function resolveStyle(
  node: HtmlElement,
  parent: CompendiumStyle,
  rules: Rule[],
): CompendiumStyle {
  let style = { ...parent };
  if (['b', 'strong'].includes(node.tagName)) style.bold = true;
  if (['i', 'em'].includes(node.tagName)) style.italic = true;
  if (node.tagName === 'u') style.underline = true;
  if (['s', 'strike', 'del'].includes(node.tagName)) style.strike = true;
  for (const rule of rules)
    if (matches(node, rule.selector)) style = apply(style, rule.declarations);
  return apply(style, declarations(attr(node, 'style')));
}

export function safeHref(value: string): string | undefined {
  if (!value) return undefined;
  try {
    let url = new URL(value, 'https://docs.google.com/');
    if (url.hostname === 'www.google.com' && url.pathname === '/url' && url.searchParams.has('q')) {
      url = new URL(url.searchParams.get('q')!);
    }
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
