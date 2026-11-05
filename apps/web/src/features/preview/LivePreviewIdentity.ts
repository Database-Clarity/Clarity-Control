import { createContext } from 'react';

/** Route identity paints independently of the deferred editor and preview document. */
export interface PreviewIdentity {
  name: string;
  piece?: string;
  icon?: string;
  categoryLabel?: string;
  archiveIcon?: boolean;
}

export const LivePreviewIdentity = createContext<PreviewIdentity | undefined>(undefined);
