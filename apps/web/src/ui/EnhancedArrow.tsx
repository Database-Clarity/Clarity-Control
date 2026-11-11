/**
 * The "enhanced" arrow (DIM-style): a FILLED, narrow upward arrow in the enhanced gold (--enhanced:
 * pale gold on dark, deep gold on light). One drawing for every place that marks an enhanced
 * version, so it is the same shape and colour in the finder, the markup row and the compare view
 * (the preview's mask in TooltipPreview.module.scss uses the same path).
 */
export const ENHANCED_ARROW_PATH = 'M6 .75 9.5 5.25H7v6H5v-6H2.5Z';

export function EnhancedArrow({ title, size = 12 }: { title?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      style={{ color: 'var(--enhanced)', flex: 'none', verticalAlign: '-1px' }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={ENHANCED_ARROW_PATH} />
    </svg>
  );
}

/** The stored arrow character (the global `e`): text that holds it shows the arrow drawing instead. */
export const ENHANCED_ARROW_CHAR = '🡅';

/**
 * Plain text in which every stored arrow character is drawn as the enhanced arrow symbol (a value
 * column, a raw definition line), never as the font's glyph in the surrounding text colour.
 */
export function WithArrows({ text }: { text: string }) {
  if (!text.includes(ENHANCED_ARROW_CHAR)) return <>{text}</>;
  return (
    <>
      {text.split(ENHANCED_ARROW_CHAR).map((part, index) => (
        <span key={index}>
          {index > 0 && <EnhancedArrow title="Enhanced arrow" />}
          {part}
        </span>
      ))}
    </>
  );
}
