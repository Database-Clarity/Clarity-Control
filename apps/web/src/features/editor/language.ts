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
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export const clarityHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: '#6a9955' },
    { tag: tags.keyword, color: '#c586c0' },
    { tag: tags.variableName, color: '#4ec9b0' },
    { tag: tags.typeName, color: '#4fc1ff' },
    { tag: tags.tagName, color: '#4ec9b0' },
    { tag: tags.number, color: '#dcdcaa' },
    { tag: tags.string, color: '#9cdcfe' },
  ]),
);
