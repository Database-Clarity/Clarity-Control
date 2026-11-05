import {
  maskConflicts,
  validateText,
  type Lang,
  type MarkupGlobals,
  type ValidationIssue,
} from '@clarity/core';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { hasDiagnosticWorker, requestDiagnostics } from './diagnosticWorker';

const validation = new WeakMap<MarkupGlobals, Map<string, ReturnType<typeof validateText>>>();
const importFreeValidation = new Map<string, ReturnType<typeof validateText>>();

export function hasImportDependencies(text: string, globals: MarkupGlobals): boolean {
  return [text, globals.variables, globals.titles].some((source) => source.includes('import '));
}
/** Status and decorations validate the same immutable globals snapshot during a render. */
export function validateEditorText(
  text: string,
  lang: Lang,
  globals: MarkupGlobals,
  requireEnglish = true,
  selfHash?: number,
) {
  const importFree = !hasImportDependencies(text, globals);
  let results = importFree ? importFreeValidation : validation.get(globals);
  if (!results) validation.set(globals, (results = new Map()));
  const key = JSON.stringify([
    lang,
    requireEnglish,
    selfHash,
    text,
    importFree ? [globals.variables, globals.titles, globals.type] : undefined,
  ]);
  let result = results.get(key);
  if (!result) {
    result = validateText(maskConflicts(text), lang, globals, requireEnglish, selfHash);
    if (results.size >= 16) results.delete(results.keys().next().value!);
    results.set(key, result);
  }
  return result;
}

const setDiagnostics = StateEffect.define<readonly ValidationIssue[]>();
const decorationsFor = (issues: readonly ValidationIssue[]) =>
  Decoration.set(
    issues
      .filter((issue) => issue.to > issue.from)
      .sort((a, b) => a.from - b.from || a.to - b.to)
      .map((issue) =>
        Decoration.mark({
          class: `clarity-validation-${issue.severity}`,
          attributes: { title: `${issue.severity}: ${issue.message}` },
        }).range(issue.from, issue.to),
      ),
  );
const asyncDiagnostics = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    const mapped = value.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setDiagnostics)) return decorationsFor(effect.value);
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function validationDiagnostics(
  lang: Lang,
  globals: MarkupGlobals,
  requireEnglish = true,
  selfHash: () => number | undefined = () => undefined,
) {
  if (!hasDiagnosticWorker())
    return EditorView.decorations.compute(['doc'], (state) =>
      decorationsFor(
        validateEditorText(state.doc.toString(), lang, globals, requireEnglish, selfHash()),
      ),
    );
  return [
    asyncDiagnostics,
    ViewPlugin.fromClass(
      class {
        private alive = true;
        private revision = 0;
        private detachedResult = false;
        private timer: ReturnType<typeof setTimeout> | undefined;
        constructor(view: EditorView) {
          this.check(view, 0);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || (this.detachedResult && update.view.dom.isConnected))
            this.check(update.view);
        }
        check(view: EditorView, delay = 40) {
          clearTimeout(this.timer);
          const doc = view.state.doc;
          const revision = ++this.revision;
          const input = {
            text: doc.toString(),
            lang,
            globals,
            requireEnglish,
            selfHash: selfHash(),
          };
          const apply = (issues: readonly ValidationIssue[]) => {
            if (!this.alive || this.revision !== revision || view.state.doc !== doc) return;
            this.detachedResult = !view.dom.isConnected;
            if (!this.detachedResult) view.dispatch({ effects: setDiagnostics.of(issues) });
          };
          // Preparing the worker snapshot must not run inside CodeMirror's input
          // transaction. Cancel skipped edits before inspecting their imports.
          this.timer = setTimeout(() => {
            void requestDiagnostics(input).then(
              (result) => apply(result.issues),
              () => {
                if (this.alive && this.revision === revision && view.state.doc === doc)
                  apply(
                    validateEditorText(input.text, lang, globals, requireEnglish, input.selfHash),
                  );
              },
            );
          }, delay);
        }
        destroy() {
          this.alive = false;
          clearTimeout(this.timer);
        }
      },
    ),
  ];
}
