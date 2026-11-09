import { create } from 'zustand';
import type { ChangedFields } from './changedFields';

/**
 * What the detail learned about each saved change from its live version, so the list can mark rows
 * (Text, Assoc) once a row has been looked at. Rows never fetch live versions themselves.
 */
interface ReviewMarks {
  fields: Record<number, ChangedFields>;
  record(hash: number, fields: ChangedFields): void;
}
export const useReviewMarks = create<ReviewMarks>((set) => ({
  fields: {},
  record: (hash, fields) =>
    set((state) =>
      JSON.stringify(state.fields[hash]) === JSON.stringify(fields)
        ? state
        : { fields: { ...state.fields, [hash]: fields } },
    ),
}));
