import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';
import { loadedReviewPage } from './reviewPageComponent';

const loadPage = () =>
  import('./MatchReviewPage').then((module) => ({ default: module.MatchReviewPage }));

class LoadBoundary extends Component<{ children: ReactNode; retry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        Couldn't load Compendium review. Check your connection and{' '}
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

export function LazyMatchReviewPage({
  load = loadPage,
}: {
  load?: () => Promise<{ default: ComponentType }>;
}) {
  const [attempt, setAttempt] = useState(0);
  const page = () => (load === loadPage && loadedReviewPage()) || lazy(load);
  // Idle prefetch already evaluated the page. Reuse it without introducing a
  // fresh pending lazy boundary on every navigation into this workspace.
  const [Page, setPage] = useState(page);
  return (
    <LoadBoundary
      key={attempt}
      retry={() => {
        setPage(page);
        setAttempt((value) => value + 1);
      }}
    >
      <Suspense fallback={<p role="status">Loading Compendium review…</p>}>
        <Page />
      </Suspense>
    </LoadBoundary>
  );
}
