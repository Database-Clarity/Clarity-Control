export interface WrapPart {
  text?: string;
  symbol?: 'icon' | 'arrow';
  atomic?: boolean;
}

interface Slice {
  index: number;
  from: number;
  to: number;
}

/** Keep the symbol and the touching characters together even inside an oversized run. */
export function symbolWrapEdges(parts: WrapPart[], slices: Slice[]) {
  const edges: { glued: boolean; slices: Slice[] }[] = [];
  const add = (slice: Slice, glued: boolean) => {
    const previous = edges.at(-1);
    if (previous?.glued === glued) previous.slices.push(slice);
    else edges.push({ glued, slices: [slice] });
  };
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  slices.forEach((slice, index) => {
    const { from, to } = slice;
    const part = parts[slice.index];
    if (part.symbol) {
      add(slice, true);
      return;
    }
    const left = Boolean(parts[slices[index - 1]?.index]?.symbol);
    const right = parts[slices[index + 1]?.index]?.symbol === 'arrow';
    if ((!left && !right) || part.atomic || from === to) {
      add(slice, left || right);
      return;
    }
    const text = part.text!.slice(from, to);
    const segments = graphemes.segment(text);
    const head = left ? from + segments.containing(0)!.segment.length : from;
    const tail = right ? from + segments.containing(text.length - 1)!.index : to;
    if (head >= tail) add(slice, true);
    else {
      if (left) add({ ...slice, to: head }, true);
      add({ ...slice, from: head, to: tail }, false);
      if (right) add({ ...slice, from: tail }, true);
    }
  });
  return edges;
}

/** Find display runs that must move together, without changing the source parts. */
export function symbolWrapRuns(parts: WrapPart[]) {
  const runs: { glued: boolean; slices: Slice[] }[] = [];
  let word: Slice[] = [];
  let glued = false;
  let afterSymbol = false;
  const append = (slices: Slice[], slice: Slice) => {
    const last = slices.at(-1);
    if (last?.index === slice.index && last.to === slice.from) last.to = slice.to;
    else slices.push(slice);
  };
  const plain = (slice: Slice) => {
    const previous = runs.at(-1);
    if (previous && !previous.glued) append(previous.slices, slice);
    else runs.push({ glued: false, slices: [slice] });
  };
  const flush = () => {
    if (glued) runs.push({ glued: true, slices: word });
    else word.forEach(plain);
    word = [];
    glued = false;
    afterSymbol = false;
  };
  parts.forEach(({ text = '', symbol, atomic }, index) => {
    if (symbol) {
      if (!afterSymbol && symbol !== 'arrow') flush();
      glued ||= word.length > 0;
      word.push({ index, from: 0, to: text.length });
      afterSymbol = true;
      return;
    }
    if (!text) {
      word.push({ index, from: 0, to: 0 });
      return;
    }
    // A link or note must remain a single interactive element.
    const chunks = atomic ? [text] : (text.match(/\s+|\S+/g) ?? []);
    let from = 0;
    for (const chunk of chunks) {
      const slice = { index, from, to: from + chunk.length };
      from = slice.to;
      if (/^\s/.test(chunk)) {
        flush();
        plain(slice);
      } else {
        glued ||= afterSymbol;
        append(word, slice);
        afterSymbol = false;
        if (/\s$/.test(chunk)) flush();
      }
    }
  });
  flush();
  return runs;
}
