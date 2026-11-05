import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markupColors, markupEmpty, markupIcons } from '@clarity/core';

const emptyTag = new RegExp(`<(${[...markupIcons, ...markupEmpty].join('|')})/>`);
const textTag = new RegExp(`<(${markupColors.join('|')})\\b`);

export const clarityLanguage = StreamLanguage.define({
  startState: () => ({ comment: false, declaration: false }),
  token(stream, state) {
    if (stream.sol()) state.declaration = false;
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
    if (stream.match(/\$\{[^}]*\}?/)) return 'number';
    if (stream.match(textTag) || stream.match(/< table .*?>|<\$>|\|[bchr\d-]*/)) return 'typeName';
    if (stream.match(emptyTag) || stream.match(/<(?:title|link) |<\/?|\/>|\[[^\]]*\]/))
      return 'tagName';
    // Plain prose is one unstyled run. Retain every possible markup/comment
    // boundary, while avoiding all of the token expressions for each letter.
    if (!state.declaration && stream.match(/^[^<#$[/|]+/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export const clarityHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: 'var(--syn-comment)' },
    { tag: tags.keyword, color: 'var(--syn-keyword)' },
    { tag: tags.variableName, color: 'var(--var)' },
    { tag: tags.typeName, color: 'var(--syn-type)' },
    { tag: tags.tagName, color: 'var(--var)' },
    { tag: tags.number, color: 'var(--syn-number)' },
    { tag: tags.string, color: 'var(--syn-string)' },
  ]),
);
