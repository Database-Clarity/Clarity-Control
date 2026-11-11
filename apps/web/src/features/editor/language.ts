import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { baseEnhancedPairs, markupColors, markupEmpty, markupIcons } from '@clarity/core';

const emptyTag = new RegExp(`<(${[...markupIcons, ...markupEmpty].join('|')})/>`);
const textTag = new RegExp(`<(${markupColors.join('|')})\\b`);
// Prose runs stop at every possible markup boundary; inside a table also at its cell pipes.
const prose = /^[^<#$[/{]+/;
const tableProse = /^[^<#$[/|{]+/;

export const clarityLanguage = StreamLanguage.define({
  tokenTable: { baseArm: tags.special(tags.number), enhancedArm: tags.special(tags.variableName) },
  startState: () => ({ comment: false, declaration: false, formula: false, table: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.declaration = false;
      state.formula = false;
    }
    if (state.formula) {
      // After the base number of ${base+#d}, the rest is the enhanced part: coloured like #d and #e.
      state.formula = false;
      if (stream.match(/[^}]*\}?/)) return 'variableName';
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
        stream.pos = pair.from + 2 + pair.base.length + 1;
        return 'baseArm';
      }
    }
    if (stream.peek() === '{' && stream.pos > 0 && stream.string[stream.pos - 1] === '}') {
      const pair = baseEnhancedPairs(stream.string).find(
        (pair) => pair.from + pair.base.length + 3 === stream.pos,
      );
      if (pair) {
        stream.pos = pair.to;
        return 'enhancedArm';
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
    if (stream.match(/#[a-zA-Z0-9]+/)) return 'variableName';
    if (stream.match(/\$\{-?[^}+*/-]*\}?/)) {
      // The base number (and the braces around a lone one) keeps the number colour; an operator
      // after it starts the enhanced part, coloured on the next token.
      if (!stream.eol() && !stream.current().endsWith('}')) state.formula = true;
      return 'number';
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
    { tag: tags.comment, color: 'var(--syn-comment)' },
    { tag: tags.keyword, color: 'var(--syn-keyword)' },
    { tag: tags.variableName, color: 'var(--var)' },
    { tag: tags.typeName, color: 'var(--syn-type)' },
    { tag: tags.tagName, color: 'var(--var)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.string, color: 'var(--syn-string)' },
  ]),
);
