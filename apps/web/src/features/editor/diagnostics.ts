import { maskConflicts, validateText, type Lang, type MarkupGlobals } from '@clarity/core';
import { Decoration, EditorView } from '@codemirror/view';

export function validationDiagnostics(
  lang: Lang,
  globals: MarkupGlobals,
  requireEnglish = true,
  selfHash: () => number | undefined = () => undefined,
) {
  return EditorView.decorations.compute(['doc'], (state) =>
    Decoration.set(
      validateText(maskConflicts(state.doc.toString()), lang, globals, requireEnglish, selfHash())
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
