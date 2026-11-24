import { expect, it } from 'vitest';
import { canEditGlobal, type GlobalActor } from '../src/services/globals';

it('restricts editing by role and assigned language', () => {
  const actors: GlobalActor[] = [
    null,
    { role: 'trial', languages: [] },
    { role: 'translator', languages: ['fr'] },
    { role: 'editor', languages: [] },
    { role: 'maintainer', languages: [] },
  ];
  expect(actors.map((actor) => canEditGlobal(actor, 'en'))).toEqual([
    false,
    true,
    false,
    true,
    true,
  ]);
  expect(actors.map((actor) => canEditGlobal(actor, 'fr'))).toEqual([
    false,
    true,
    true,
    true,
    true,
  ]);
});
