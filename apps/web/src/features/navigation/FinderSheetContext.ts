import { createContext } from 'react';

/** Whether the phone finder sheet is open; the finder's sheet form opens its list with it. */
export const FinderSheetContext = createContext<boolean>(false);
