import { useEffect, useState, type RefObject } from 'react';

const widths = new WeakMap<HTMLElement, number>();

/** The element's content width in CSS pixels, kept current; undefined where it cannot be measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(() =>
    ref.current ? widths.get(ref.current) : undefined,
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let active = true;
    setWidth(widths.get(element));
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === element);
      if (!active || !entry) return;
      const next = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      widths.set(element, next);
      setWidth(next);
    });
    observer.observe(element, { box: 'border-box' });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [ref]);
  return width;
}
