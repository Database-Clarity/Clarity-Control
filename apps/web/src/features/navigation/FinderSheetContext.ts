import { createContext } from 'react';

/** Whether the phone finder sheet is open; the finder's sheet form opens its list with it. */
export const FinderSheetContext = createContext<boolean>(false);

/**
 * Closes the phone finder sheet. The finder calls it once a chosen row has navigated, so the sheet
 * does not stay over the item that was just opened. Absent outside the sheet.
 */
export const FinderSheetCloseContext = createContext<(() => void) | undefined>(undefined);
