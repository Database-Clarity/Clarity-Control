import { maskConflicts, validateText, type Lang, type MarkupGlobals } from '@clarity/core';
import { Decoration, EditorView } from '@codemirror/view';

const validation = new WeakMap<MarkupGlobals, Map<string, ReturnType<typeof validateText>>>();
/** Status and decorations validate the same immutable globals snapshot during a render. */
export function validateEditorText(
  text: string,
  lang: Lang,
  globals: MarkupGlobals,
  requireEnglish = true,
  selfHash?: number,
) {
  let results = validation.get(globals);
  if (!results) validation.set(globals, (results = new Map()));
  const key = JSON.stringify([lang, requireEnglish, selfHash, text]);
  let result = results.get(key);
  if (!result) {
    result = validateText(maskConflicts(text), lang, globals, requireEnglish, selfHash);
    if (results.size >= 16) results.delete(results.keys().next().value!);
    results.set(key, result);
  }
  return result;
}

export function validationDiagnostics(
  lang: Lang,
  globals: MarkupGlobals,
  requireEnglish = true,
  selfHash: () => number | undefined = () => undefined,
) {
  return EditorView.decorations.compute(['doc'], (state) =>
    Decoration.set(
      validateEditorText(state.doc.toString(), lang, globals, requireEnglish, selfHash())
        .filter((issue) => issue.to > issue.from)
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map((issue) =>
          Decoration.mark({
            class: `clarity-validation-${issue.severity}`,
            attributes: { title: `${issue.severity}: ${issue.message}` },
          }).range(issue.from, issue.to),
        ),
    ),
  );
}
