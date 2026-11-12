import { SkeletonSuspense } from '../../ui/Skeleton';
import { Component, lazy, useState, type ComponentType, type ReactNode } from 'react';

const loadPage = () =>
  import('./LostTextPage').then((module) => ({ default: module.LostTextPage }));

class LoadBoundary extends Component<{ children: ReactNode; retry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        Couldn't load Lost Text. Check your connection and{' '}
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

export function LazyLostTextPage({
  load = loadPage,
}: {
  load?: () => Promise<{ default: ComponentType }>;
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
      <SkeletonSuspense label="Loading Lost Text…">
        <Page />
      </SkeletonSuspense>
    </LoadBoundary>
  );
}
