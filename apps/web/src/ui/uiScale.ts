export function appliedUiScale(scale: number, width: number): number {
  if (scale <= 100) return scale;
  const floor = width > 700 ? 710 : 260;
  return Math.max(100, Math.min(scale, Math.floor((width / floor) * 100)));
}
