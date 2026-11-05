import { useEffect, useMemo, useState } from 'react';
import type { CompendiumCell } from '@clarity/core';
import { hasPreparedDiff, prepareCompendiumDiff } from './compendiumDiffCache';
import type { CompendiumDiffMode } from './CompendiumDiff';

/** Late matcher/source replies must not start a synchronous diff in the pane. */
export function usePreparedPaneDiff(
  before: CompendiumCell | undefined,
  after: CompendiumCell | undefined,
  mode: CompendiumDiffMode,
) {
  const pair = useMemo(() => (before && after ? { before, after } : undefined), [before, after]);
  const [previous, setPrevious] = useState<typeof pair>();
  const [failure, setFailure] = useState<{ pair: typeof pair; error: unknown }>();
  const pending = !!pair && mode === 'changes' && !hasPreparedDiff(pair.before, pair.after);
  useEffect(() => {
    if (!pair) {
      setPrevious(undefined);
      return;
    }
    if (hasPreparedDiff(pair.before, pair.after)) {
      setPrevious((current) =>
        current?.before === pair.before && current.after === pair.after ? current : pair,
      );
      return;
    }
    const controller = new AbortController();
    const preparation = prepareCompendiumDiff(pair.before, pair.after, controller.signal);
    const ready = () => {
      if (!controller.signal.aborted) setPrevious({ ...pair });
    };
    if (preparation)
      void preparation.then(ready, (error) => {
        if (!controller.signal.aborted) setFailure({ pair, error });
      });
    else ready();
    return () => controller.abort();
  }, [pair, pending]);
  const retained =
    previous && hasPreparedDiff(previous.before, previous.after) ? previous : undefined;
  if (mode === 'changes' && failure && failure.pair === pair) throw failure.error;
  return { pending, pair: pending ? retained : pair };
}
