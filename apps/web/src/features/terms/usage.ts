import { create } from 'zustand';

const none: readonly string[] = [];
export const useTermUsage = create<{ documents: Record<string, readonly string[]> }>(() => ({
  documents: {},
}));
export const missingFor = (
  documents: Record<string, readonly string[]>,
  hash: number,
  lang: string,
) => documents[`${hash}:${lang}`] ?? none;
export function setTermUsage(hash: number, lang: string, missing: readonly string[]) {
  const key = `${hash}:${lang}`;
  useTermUsage.setState((state) => {
    if (JSON.stringify(state.documents[key] ?? []) === JSON.stringify(missing)) return state;
    const documents = { ...state.documents, [key]: missing };
    if (Object.keys(documents).length > 16) delete documents[Object.keys(documents)[0]!];
    return { documents };
  });
}
