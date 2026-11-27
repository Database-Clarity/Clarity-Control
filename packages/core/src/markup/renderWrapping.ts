interface WrapPart {
  text?: string;
  symbol?: 'icon' | 'arrow';
  atomic?: boolean;
}

interface Slice {
  index: number;
  from: number;
  to: number;
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
