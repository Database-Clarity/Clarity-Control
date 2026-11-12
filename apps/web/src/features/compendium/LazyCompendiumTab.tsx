import { SkeletonSuspense, type LoadingShape } from '../../ui/Skeleton';
import { Component, lazy, useState, type ComponentType, type ReactNode } from 'react';

const loadPage = () =>
  import('./CompendiumTab').then((module) => ({ default: module.CompendiumTab }));

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
  load?: () => Promise<{ default: ComponentType }>;
  shape?: LoadingShape;
}) {
  const [attempt, setAttempt] = useState(0);
  const [Page, setPage] = useState(() => lazy(load));
  return (
    <LoadBoundary
      key={attempt}
      retry={() => {
        setPage(() => lazy(load));
        setAttempt((value) => value + 1);
      }}
    >
      <SkeletonSuspense label="Loading the Compendium tab…" shape={shape}>
        <Page />
      </SkeletonSuspense>
    </LoadBoundary>
  );
}
