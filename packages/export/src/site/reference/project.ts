import type { ExportConfig } from '../../v2/config.js';
import { newStyleFile } from '../../v2/styles.js';
import { exportLanguages, itemKeys } from '../../v2/vocabulary.js';

// Owned by build-site, never accepted by the partner config schema. Categories are filled from
// the pinned catalog at build time so this project always includes the complete catalog.
export const referenceProject: ExportConfig = {
  schema: 1,
  id: 'reference',
  name: 'Clarity reference',
  files: (['lines', 'text'] as const).map((shape) =>
    newStyleFile(
      shape,
      shape === 'lines' ? 'structured' : 'markdown',
      {
        categories: [],
        sandboxPerks: [],
        frameAliases: true,
        languages: [...exportLanguages],
        languageFiles: 'perLanguage',
        keys: [...itemKeys],
        bungieIdentical: true,
        includeShowcase: true,
      },
      shape,
    ),
  ),
};
