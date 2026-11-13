import { SkeletonSuspense, type LoadingShape } from '../../ui/Skeleton';
import { Component, lazy, useState, type ComponentType, type ReactNode } from 'react';

type Loader = () => Promise<{ default: ComponentType }>;
const loadPage: Loader = () =>
  import('./CompendiumTab').then((module) => ({ default: module.CompendiumTab }));

// React.lazy suspends on the first render of every new lazy component, even when the module
// is already in memory. That one fallback frame started the skeleton's 200 ms minimum on every
// open. A page whose module has resolved renders directly, in the click's first commit.
const resolved = new WeakMap<Loader, ComponentType>();
function tracked(load: Loader): Loader {
  return () =>
    load().then((module) => {
      resolved.set(load, module.default);
      return module;
    });
}
/** Idle prefetch of the Compendium tab, so a later open never shows a loading fallback. */
export function preloadCompendiumTab() {
  return tracked(loadPage)().then(
    () => undefined,
    () => undefined,
  );
}

class LoadBoundary extends Component<{ children: ReactNode; retry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        Couldn't load the Compendium tab. Check your connection and{' '}
        <button type="button" onClick={this.props.retry}>
          Retry
        </button>
        .
      </p>
    ) : (
      this.props.children
    );
  }
}

export function LazyCompendiumTab({
  load = loadPage,
  shape = 'page',
}: {
  load?: Loader;
  shape?: LoadingShape;
}) {
  const [attempt, setAttempt] = useState(0);
  const [Page, setPage] = useState(() => lazy(tracked(load)));
  const Ready = resolved.get(load);
  return (
    <LoadBoundary
      key={attempt}
      retry={() => {
        setPage(() => lazy(tracked(load)));
        setAttempt((value) => value + 1);
      }}
    >
      <SkeletonSuspense label="Loading the Compendium tab…" shape={shape}>
        {Ready ? <Ready /> : <Page />}
      </SkeletonSuspense>
    </LoadBoundary>
  );
}
