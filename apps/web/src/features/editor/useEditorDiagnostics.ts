import { startTransition, useEffect, useMemo, useState } from 'react';
import { glyphWarnings } from '@clarity/core';
import {
  computeDiagnostics,
  type DiagnosticInput,
  type DiagnosticResult,
} from './diagnosticRequest';
import { diagnosticGlobals, hasDiagnosticWorker, requestDiagnostics } from './diagnosticWorker';
import { validateEditorText } from './diagnostics';

const empty: DiagnosticResult = { issues: [], glyphs: [] };

export function useEditorDiagnostics(input: DiagnosticInput, active = true) {
  const { text, lang, globals, requireEnglish, selfHash } = input;
  const supported = hasDiagnosticWorker();
  const context = useMemo(
    () => (supported ? diagnosticGlobals(text, globals) : globals),
    [supported, text, globals],
  );
  const fallback = useMemo(
    () =>
      supported
        ? undefined
        : {
            issues: validateEditorText(text, lang, globals, requireEnglish, selfHash),
            glyphs: glyphWarnings(text),
          },
    [supported, text, lang, globals, requireEnglish, selfHash],
  );
  const [completed, setCompleted] = useState<{
    input: DiagnosticInput;
    result: DiagnosticResult;
  }>();
  useEffect(() => {
    if (!supported || !active) return;
    let current = true;
    const captured = { text, lang, globals: context, requireEnglish, selfHash };
    void requestDiagnostics(captured).then(
      (result) => current && startTransition(() => setCompleted({ input: captured, result })),
      () =>
        current &&
        startTransition(() =>
          setCompleted({ input: captured, result: computeDiagnostics(captured) }),
        ),
    );
    return () => {
      current = false;
    };
  }, [active, supported, text, lang, context, requireEnglish, selfHash]);
  const pending =
    active &&
    supported &&
    (!completed ||
      completed.input.text !== text ||
      completed.input.lang !== lang ||
      completed.input.globals !== context ||
      completed.input.requireEnglish !== requireEnglish ||
      completed.input.selfHash !== selfHash);
  const sameDocument = completed?.input.lang === lang && completed?.input.selfHash === selfHash;
  return { ...(fallback ?? (sameDocument ? completed?.result : undefined) ?? empty), pending };
}
