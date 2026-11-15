import { markupCommentContext } from '../markup/prepare.js';
import { variableReferences } from '../markup/braces.js';
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
  const titleTags = [...text.matchAll(/<title ([^>\n]*?) \[([^\]\n]+)\] \/>/g)];
  const labels = titleTags.map((tag) => ({
    from: tag.index + 7,
    to: tag.index + tag[0].lastIndexOf('['),
  }));
  const refs =
    kind === 'variables'
      ? variableReferences(text)
      : titleTags.map((tag) => {
          const from = tag.index + tag[0].lastIndexOf('[') + 1;
          return { name: tag[2], from, to: from + tag[2].length };
        });
  return refs.filter(
    (ref) => ![...comments, ...labels].some((span) => ref.from < span.to && ref.to > span.from),
  );
}

/** Rewrite exact authored tokens, retaining labels, comments, CRLF, and all other bytes. */
export function rewriteGlobalReferences(
  text: string,
  kind: GlobalRecord['kind'],
  beforeName: string,
  afterName: string,
): { text: string; edits: GlobalReferenceSpan[] } {
  if (!validGlobalName(kind, beforeName) || !validGlobalName(kind, afterName))
    throw new Error('Invalid global reference name');
  if (kind === 'variables' && (beforeName === 'e' || afterName === 'e') && beforeName !== afterName)
    throw new Error('The legacy enhanced arrow identity is protected');
  const edits = globalReferenceSpans(text, kind).filter((ref) => ref.name === beforeName);
  let next = text;
  for (const ref of [...edits].reverse()) {
    const value = kind === 'titles' ? afterName : ref.braced ? `#{${afterName}}` : `#${afterName}`;
    next = next.slice(0, ref.from) + value + next.slice(ref.to);
  }
  return { text: next, edits };
}
