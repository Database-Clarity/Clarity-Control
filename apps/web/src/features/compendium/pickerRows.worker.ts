import { compendiumIdentifiers, normaliseCompendiumName } from '@clarity/core';

type Detail = { name: string; identifiers: string[]; search: string };
self.onmessage = (
  event: MessageEvent<{ name: string; section?: string; cached?: Partial<Detail> }[]>,
) => {
  self.postMessage(
    event.data.map(({ name, section, cached }) => ({
      name: cached?.name ?? normaliseCompendiumName(name),
      identifiers: cached?.identifiers ?? compendiumIdentifiers(name).map(normaliseCompendiumName),
      search: cached?.search ?? normaliseCompendiumName(`${name} ${section ?? ''}`),
    })),
  );
};
