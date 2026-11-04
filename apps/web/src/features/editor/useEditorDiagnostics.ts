import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { glyphWarnings } from '@clarity/core';
import {
  computeDiagnostics,
  type DiagnosticInput,
  type DiagnosticResult,
} from './diagnosticRequest';
import { hasDiagnosticWorker, requestDiagnostics } from './diagnosticWorker';
import { validateEditorText } from './diagnostics';

const empty: DiagnosticResult = { issues: [], glyphs: [] };

export function useEditorDiagnostics(input: DiagnosticInput, active = true) {
  const { text, lang, globals, requireEnglish, selfHash } = input;
  const supported = hasDiagnosticWorker();
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
  const requestedDocument = useRef<{ lang: typeof lang; selfHash: typeof selfHash }>(undefined);
  useEffect(() => {
    if (!supported || !active) return;
    let current = true;
    const captured = { text, lang, globals, requireEnglish, selfHash };
    const sameDocument =
      requestedDocument.current?.lang === lang &&
      requestedDocument.current.selfHash === selfHash;
    // Snapshotting reachable imports parses markup too. Keep it out of render and
    // skip intermediate typing snapshots, while new documents start immediately.
    const timer = setTimeout(() => {
      requestedDocument.current = { lang, selfHash };
      void requestDiagnostics(captured).then(
        (result) => current && startTransition(() => setCompleted({ input: captured, result })),
        () =>
          current &&
          startTransition(() =>
            setCompleted({ input: captured, result: computeDiagnostics(captured) }),
          ),
      );
    }, sameDocument ? 40 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [active, supported, text, lang, globals, requireEnglish, selfHash]);
  const pending =
    active &&
    supported &&
    (!completed ||
      completed.input.text !== text ||
      completed.input.lang !== lang ||
      completed.input.globals !== globals ||
      completed.input.requireEnglish !== requireEnglish ||
      completed.input.selfHash !== selfHash);
  const sameDocument = completed?.input.lang === lang && completed?.input.selfHash === selfHash;
  return { ...(fallback ?? (sameDocument ? completed?.result : undefined) ?? empty), pending };
}
