import { act } from 'react';

/** Test helpers for the finder's custom dropdowns (FinderPicker). */
export const picker = (host: ParentNode, label: string) =>
  host.querySelector<HTMLButtonElement>(`button[role="combobox"][aria-label="${label}"]`);
export const pickerValue = (trigger: HTMLElement) => trigger.dataset.value;
/** The listed option labels: opens the list, reads it, and closes it again. */
export async function pickerLabels(trigger: HTMLButtonElement): Promise<string[]> {
  await act(async () => trigger.click());
  const listbox = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  const labels = [...(listbox?.querySelectorAll('[role="option"]') ?? [])].map(
    (option) => option.textContent ?? '',
  );
  await act(async () => trigger.click());
  return labels;
}
/** Opens the list and clicks the option with this value. */
export async function pickOption(trigger: HTMLButtonElement, value: string) {
  await act(async () => trigger.click());
  const listbox = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  const option = listbox?.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`);
  if (!option) throw new Error(`No option ${value}`);
  await act(async () => option.click());
}
