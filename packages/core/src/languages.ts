import { z } from 'zod';
import { languages } from './languageCodes.js';

export { languages };
export const langSchema = z.enum(languages);
export type Lang = z.infer<typeof langSchema>;
