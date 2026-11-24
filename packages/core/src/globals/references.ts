import { markupCommentContext, removeMarkupComments } from '../markup/prepare.js';
import { variableReferences } from '../markup/braces.js';
import { extractVariables } from '../markup/syntax.js';
import { validGlobalName, type GlobalRecord } from './model.js';

export interface GlobalReferenceSpan {
  name: string;
  from: number;
  to: number;
  braced?: boolean;
}

/** Authored references only. Never interpret this list as effective resolver impact. */
export function globalReferenceSpans(
  text: string,
  kind: GlobalRecord['kind'],
): GlobalReferenceSpan[] {
  const { comments } = markupCommentContext(text);
  const tags = [...text.matchAll(/<(title|link) ([^\n]*?) \[([^\]\n]+)\] \/>/dg)];
  const labels = tags.map((tag) => ({ from: tag.indices![2][0], to: tag.indices![2][1] }));
  const bracketedLabel = (label: string) => label.includes('[') || label.includes(']');
  // A whole variable target is explicit (`[#url]` or `[#{url}]`). Literal URLs and their
  // fragments are not proven references, and display labels are never rewritten.
  const literalLinks = tags
    .filter(
      (tag) =>
        tag[1] === 'link' &&
        (bracketedLabel(tag[2]) || !/^#(?:[a-zA-Z0-9]+|\{[a-zA-Z0-9]+\})$/.test(tag[3])),
    )
    .map((tag) => ({ from: tag.indices![3][0], to: tag.indices![3][1] }));
  const urls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((url) => ({
    from: url.index,
    to: url.index + url[0].length,
  }));
  const refs =
    kind === 'exports'
      ? [...text.matchAll(/^import ([A-z0-9 ]+?) from (?:global|0*1) *\r?$/dgm)]
          .filter((match) => validGlobalName('exports', match[1].trim()))
          .map((match) => {
            const [start] = match.indices![1];
            const name = match[1].trim();
            const from = start + match[1].length - match[1].trimStart().length;
            return { name, from, to: from + name.length };
          })
      : kind === 'variables'
        ? variableReferences(text)
        : tags
            .filter(
              (tag) =>
                tag[1] === 'title' && !bracketedLabel(tag[2]) && validGlobalName('titles', tag[3]),
            )
            .map((tag) => {
              const [from, to] = tag.indices![3];
              return { name: tag[3], from, to };
            });
  return refs.filter(
    (ref) =>
      ![...comments, ...labels, ...literalLinks, ...urls].some(
        (span) => ref.from < span.to && ref.to > span.from,
      ),
  );
}

/** Rewrite exact authored tokens, retaining labels, comments, CRLF, and all other bytes. */
export function rewriteGlobalReferences(
  text: string,
  kind: GlobalRecord['kind'],
  beforeName: string,
  afterName: string,
  ignoreLocalVariables = false,
): { text: string; edits: GlobalReferenceSpan[] } {
  if (!validGlobalName(kind, beforeName) || !validGlobalName(kind, afterName))
    throw new Error('Invalid global reference name');
  if (kind === 'variables' && (beforeName === 'e' || afterName === 'e') && beforeName !== afterName)
    throw new Error('The legacy enhanced arrow identity is protected');
  if (
    kind === 'variables' &&
    ignoreLocalVariables &&
    Object.hasOwn(extractVariables(removeMarkupComments(text)), beforeName)
  )
    return { text, edits: [] };
  const edits = globalReferenceSpans(text, kind).filter((ref) => ref.name === beforeName);
  let next = text;
  for (const ref of [...edits].reverse()) {
    const value =
      kind !== 'variables' ? afterName : ref.braced ? `#{${afterName}}` : `#${afterName}`;
    next = next.slice(0, ref.from) + value + next.slice(ref.to);
  }
  return { text: next, edits };
}
