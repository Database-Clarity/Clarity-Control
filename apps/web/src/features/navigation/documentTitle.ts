export const appName = 'Clarity Control';

/** Browser title: "Clarity Control — <item or page>", or just the name before anything is known. */
export function documentTitle(page?: string | null): string {
  const name = page?.trim();
  return name ? `${appName} — ${name}` : appName;
}
