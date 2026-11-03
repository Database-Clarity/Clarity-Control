/**
 * The thin "enhanced" arrow (DIM-style): a light upward arrow in the enhanced gold (--enhanced:
 * pale gold on dark, deep gold on light). One drawing for every place that marks an enhanced
 * version, so it is the same weight and colour in the finder, the markup row and the compare view.
 */
export function EnhancedArrow({ title, size = 12 }: { title?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="square"
      style={{ color: 'var(--enhanced)', flex: 'none', verticalAlign: '-1px' }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d="M6 11V1.5M2.25 5.25 6 1.5l3.75 3.75" />
    </svg>
  );
}
