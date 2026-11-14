import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Tag, tags } from '@lezer/highlight';
import {
  baseEnhancedPairs,
  elementTagNames,
  elementTextTinted,
  findElementTags,
  markupColors,
  markupEmpty,
  markupIcons,
} from '@clarity/core';

// The arrow symbol `<enhanced/>` reads like the icons.
const emptyTag = new RegExp(`<(${[...markupIcons, ...markupEmpty, 'enhanced'].join('|')})/>`);
const textTag = new RegExp(`<(${markupColors.join('|')})\\b`);
// Prose runs stop at every possible markup boundary; inside a table also at its cell pipes.
const prose = /^[^<#$[/{]+/;
const tableProse = /^[^<#$[/|{]+/;

/** Element-tagged text (`<solar Scorch />`): its text in the element tint, one tag per element. */
const elementTint = Object.fromEntries(elementTagNames.map((name) => [name, Tag.define()]));
/** The tagged spans of the line being read (the stream reads one line at a time, in order). */
let taggedLine: { text: string; tags: ReturnType<typeof findElementTags> } = { text: '', tags: [] };
function taggedAt(line: string, position: number) {
  if (!line.includes(' />')) return undefined;
  if (taggedLine.text !== line) taggedLine = { text: line, tags: findElementTags(line) };
  // Text the preview draws untinted (a variable, formula, or comment in it) keeps its own colours.
  return taggedLine.tags.find((tag) => tag.from === position && elementTextTinted(tag.text));
}

export const clarityLanguage = StreamLanguage.define({
  tokenTable: {
    baseArm: tags.special(tags.number),
    enhancedArm: tags.special(tags.variableName),
    pairMark: tags.special(tags.tagName),
    ...Object.fromEntries(elementTagNames.map((name) => [`el-${name}`, elementTint[name]!])),
  },
  startState: (): {
    comment: boolean;
    declaration: boolean;
    /** Inside ${…}: the base number next, the enhanced rest of a formula, or the closing brace. */
    math: 'base' | 'rest' | 'close' | null;
    table: boolean;
    /** Inside a {{base}{enhanced}} pair: where the base arm and the enhanced arm end. */
    pair: { baseEnd: number; enhancedEnd: number } | null;
    /** Inside element-tagged text: its element, where its text ends, and where the tag ends. */
    tagged: { name: string; textEnd: number; end: number } | null;
  } => ({
    comment: false,
    declaration: false,
    math: null,
    table: false,
    pair: null,
    tagged: null,
  }),
  token(stream, state) {
    if (stream.sol()) {
      state.declaration = false;
      state.math = null;
      state.pair = null;
      state.tagged = null;
    }
    if (state.tagged) {
      // `<solar ` was read: the text in the element's tint, then ` />` as markup.
      const { name, textEnd, end } = state.tagged;
      if (stream.pos < textEnd) {
        stream.pos = textEnd;
        return `el-${name}`;
      }
      stream.pos = end;
      state.tagged = null;
      return 'tagName';
    }
    if (state.pair) {
      // A pair is {{ base }{ enhanced }}: the arms carry the base and enhanced colours, and the
      // braces between them are markup punctuation like `<` and `/>`.
      const { baseEnd, enhancedEnd } = state.pair;
      if (stream.pos < baseEnd) {
        stream.pos = baseEnd;
        return 'baseArm';
      }
      if (stream.pos === baseEnd) {
        stream.pos += 2;
        return 'pairMark';
      }
      if (stream.pos < enhancedEnd) {
        stream.pos = enhancedEnd;
        return 'enhancedArm';
      }
      stream.pos = enhancedEnd + 2;
      state.pair = null;
      return 'pairMark';
    }
    if (state.math) {
      // ${…} is coloured like a {{base}{enhanced}} pair: its braces are pair marks; a lone number
      // keeps the number colour; an operator after the first number makes that number the base
      // arm and the rest, up to the closing brace, the enhanced arm.
      if (state.math === 'base') {
        state.math = 'close';
        if (stream.match(/-?(?:#\{[a-zA-Z0-9]+\}|[^}+*/-])+|-/)) {
          if (stream.eol() || stream.peek() === '}') return 'number';
          state.math = 'rest';
          return 'baseArm';
        }
        if (!stream.eol() && stream.peek() !== '}') state.math = 'rest';
      }
      if (state.math === 'rest') {
        state.math = 'close';
        if (stream.match(/(?:#\{[a-zA-Z0-9]+\}|[^}])+/)) return 'enhancedArm';
      }
      state.math = null;
      if (stream.eat('}')) return 'pairMark';
    }
    if (state.comment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.comment = false;
      } else stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.comment = true;
      return 'comment';
    }
    if (stream.peek() === '{') {
      const pair = baseEnhancedPairs(stream.string).find((pair) => pair.from === stream.pos);
      if (pair) {
        const baseEnd = pair.from + 2 + pair.base.length;
        state.pair = { baseEnd, enhancedEnd: baseEnd + 2 + pair.enhanced.length };
        stream.pos = pair.from + 2;
        return 'pairMark';
      }
    }
    if ((stream.sol() || /\s/.test(stream.string.charAt(stream.pos - 1))) && stream.match(/\/\/.*/))
      return 'comment';
    if (
      stream.sol() &&
      stream.match(/(?:import|export|title|enhanced|catalyst|exotic perk|var)\b/)
    ) {
      state.declaration = true;
      return 'keyword';
    }
    if (state.declaration) {
      if (stream.match(/ +from +| +hidden +| = |\($/)) return 'keyword';
      if (stream.match(/[A-z0-9]+/)) return 'string';
    }
    if (stream.sol() && stream.match(/^\)/)) return 'keyword';
    if (stream.match(/#\{[a-zA-Z0-9]+\}|#[a-zA-Z0-9]+/)) return 'variableName';
    if (stream.match('${')) {
      state.math = 'base';
      return 'pairMark';
    }
    if (stream.match(/< table .*?>/)) {
      state.table = true;
      return 'typeName';
    }
    if (stream.match('<$>')) {
      state.table = false;
      return 'typeName';
    }
    // Stack pipes (1|2|3, 5% | 10%) are plain prose; only the cell pipes of a table are markup.
    if (state.table && stream.match(/\|[bchr\d-]*/)) return 'typeName';
    if (stream.peek() === '<' && !state.declaration) {
      // The same tokens the converter reads (`<.+?/>` per line): only a whole tagged token counts.
      const tag = taggedAt(stream.string, stream.pos);
      if (tag) {
        const open = `<${tag.element} `.length;
        state.tagged = { name: tag.element, textEnd: tag.to - 3, end: tag.to };
        stream.pos += open;
        return 'tagName';
      }
    }
    if (stream.match(textTag)) return 'typeName';
    if (stream.match(emptyTag) || stream.match(/<(?:title|link) |<\/?|\/>|\[[^\]{}]*\]/))
      return 'tagName';
    // Plain prose is one unstyled run. Retain every possible markup/comment
    // boundary, while avoiding all of the token expressions for each letter.
    if (!state.declaration && stream.match(state.table ? tableProse : prose)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export const clarityHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.special(tags.number), class: 'cm-base-arm' },
    { tag: tags.special(tags.variableName), class: 'cm-enhanced-arm' },
    { tag: tags.special(tags.tagName), class: 'cm-pair-mark' },
    ...elementTagNames.map((name) => ({ tag: elementTint[name]!, class: `cm-el-${name}` })),
    { tag: tags.comment, color: 'var(--syn-comment)' },
    { tag: tags.keyword, color: 'var(--syn-keyword)' },
    { tag: tags.variableName, color: 'var(--var)' },
    { tag: tags.typeName, color: 'var(--syn-type)' },
    { tag: tags.tagName, color: 'var(--var)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.string, color: 'var(--syn-string)' },
  ]),
);
