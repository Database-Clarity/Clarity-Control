/** Production comment semantics, shared by preparation and source-preserving keyword lowering. */
const markupCommentPatterns = [/\/\*[^]*\*\/\n?/g, /^ *?\/\/.*$\n?| +\/\/.*$/gm];

export function markupCommentContext(text: string): {
  text: string;
  offsets: number[];
  comments: { from: number; to: number }[];
} {
  let offsets = Array.from({ length: text.length }, (_, index) => index);
  const comments: { from: number; to: number }[] = [];
  for (const [index, pattern] of [/\r/g, ...markupCommentPatterns].entries()) {
    const matches = text.matchAll(pattern);
    let next = matches.next();
    if (next.done) continue;
    let remaining = '';
    let remainingOffsets: number[] = [];
    let last = 0;
    for (; !next.done; next = matches.next()) {
      const match = next.value;
      remaining += text.slice(last, match.index);
      remainingOffsets = remainingOffsets.concat(offsets.slice(last, match.index));
      if (index > 0) {
        comments.push({
          from: offsets[match.index],
          to: offsets[match.index + match[0].length - 1] + 1,
        });
      }
      last = match.index + match[0].length;
    }
    remaining += text.slice(last);
    remainingOffsets = remainingOffsets.concat(offsets.slice(last));
    text = remaining;
    offsets = remainingOffsets;
  }
  return { text, offsets, comments };
}

/** The production comment semantics, shared by preparation and lossless conversion checks. */
export function removeMarkupComments(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(markupCommentPatterns[0], '')
    .replace(markupCommentPatterns[1], '');
}
