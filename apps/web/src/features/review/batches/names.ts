import { useCallback } from 'react';
import { useDataStore, type EditorData } from '../../../stores/data';
import { itemFor } from '../../navigation/catalog';

/** "Name" for a hash: the catalogue item, a custom tooltip's name, else "Tooltip <hash>". */
export function nameFor(data: EditorData | null, hash: number): string {
  return (data && itemFor(hash, data)?.name) || `Tooltip ${hash}`;
}

export function useNames() {
  const data = useDataStore((state) => state.data);
  return useCallback((hash: number) => nameFor(data, hash), [data]);
}
