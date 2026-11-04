export const compendiumInputEvent = 'clarity-compendium-inputs';
export function notifyCompendiumInputs(key: string) {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(compendiumInputEvent, { detail: key }));
}
