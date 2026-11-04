import { useState, type ReactNode } from 'react';

/** Keep closed review content out of the DOM, and retain it after first use. */
export function ReviewDetails({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode | (() => ReactNode);
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  return (
    <details
      className={className}
      onClick={(event) => {
        // Nested summaries belong to their own disclosure.
        if (
          event.target instanceof Element &&
          event.target.closest('summary')?.parentElement === event.currentTarget
        )
          setMounted(true);
      }}
      onToggle={(event) => {
        if (event.currentTarget.open) setMounted(true);
      }}
    >
      <summary>{summary}</summary>
      {mounted && (typeof children === 'function' ? children() : children)}
    </details>
  );
}
