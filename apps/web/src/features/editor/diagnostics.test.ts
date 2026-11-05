import { expect, it } from 'vitest';
import { maskConflicts, validateText, type Lang } from '@clarity/core';
import { validateEditorText } from './diagnostics';

it('keeps cached status/decoration validation equal across globals, imports, languages and self hashes', () => {
  const contexts = [
    { variables: 'var damage = 5', titles: '', imports: { 42: '#missing' } },
    { variables: 'var damage = 5', titles: '', imports: { 42: 'resolved' } },
    { variables: '', titles: '', imports: { 42: 'resolved' } },
    {
      variables: '',
      titles: 'title Detail (\nimport main from 42\n)',
      imports: { 42: '#missing' },
    },
    {
      variables: '',
      titles: 'title Detail (\nimport main from 42\n)',
      imports: { 42: 'resolved' },
    },
    { variables: '', titles: '', type: 'Weapon Trait' },
    { variables: '', titles: '', type: 'Weapon Trait Enhanced' },
  ];
  const texts = [
    '',
    '#damage',
    'var damage = 6\n#damage',
    'import main from 42',
    '<title Label [Detail] />',
    'enhanced (\n#missing\n)',
    '<<<<<<< mine\n#damage\n=======\n#missing\n>>>>>>> theirs',
  ];
  for (const text of texts)
    for (const globals of contexts)
      for (const lang of ['en', 'de'] as Lang[])
        for (const selfHash of [2, 10])
          for (const requireEnglish of [true, false]) {
            expect(validateEditorText(text, lang, globals, requireEnglish, selfHash)).toEqual(
              validateText(maskConflicts(text), lang, globals, requireEnglish, selfHash),
            );
          }
});
