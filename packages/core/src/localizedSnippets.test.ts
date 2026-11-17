import { expect, it } from 'vitest';
import { localizableBuiltIns, SnippetSkeletonError, validateSnippetTranslation, snippetEnglishHash } from './localizedSnippets.js';

it('accepts word-only translations, including non-Latin prose and changed word counts', () => {
  validateSnippetTranslation('<title {{1:refills}} [G_refill] />', '<title {{1:lädt nach}} [G_refill] />');
  validateSnippetTranslation('<bold {{1:Text}} /> words', '<bold {{1:文字}} /> andere Wörter');
  for (const source of localizableBuiltIns) validateSnippetTranslation(source.template, source.template);
});
it.each([
  ['<bold {{1:Text}} />', '<yellow {{1:Text}} />'],
  ['<bold A /><yellow B />', '<yellow A /><bold B />'],
  ['{{1:Text}}{{0}}', '{{2:Text}}{{0}}'],
  ['<title {{1:refills}} [G_refill] />', '<title {{1:Text}} [G_other] />'],
  ['<link {{1:rank}} [#CombatantClassifications] />', '<link {{1:Rang}} [#Other] />'],
  ['#{damage}', '#{schaden}'],
  ['var {{1:name}} = {{2:value}}', 'var {{1:Name}} = {{2:Wert}}'],
  ['import {{1:main}} from {{2:hash}}', 'import {{1:other}} from {{2:hash}}'],
  ['title Name (\nText\n)', 'title Other (\nText\n)'],
  ['export hidden Name (\nText\n)', 'export Name (\nText\n)'],
  ['enhanced (\nText\n)', 'Text (\nText\n)'],
  ['Text\nMore', 'Text More'],
  ['<{{1:solar}}/>{{2:Solar}}', '<{{1:void}}/>{{2:Leere}}'],
  ['<title {{1:Text}} [{{2:Name}}] />', '<title {{1:Text}} [{{2:Other}}] />'],
  ['${base+#{d}}', '${other+#{d}}'],
])('rejects skeleton changes from %s', (en, translation) => {
  expect(() => validateSnippetTranslation(en, translation)).toThrow(SnippetSkeletonError);
});
it('hashes the exact English source and applies cheap pathological bounds', async () => {
  expect(await snippetEnglishHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(await snippetEnglishHash('abc\n')).not.toBe(await snippetEnglishHash('abc'));
  for (const input of ['<'.repeat(2000), ' '.repeat(2000), '#{x}'.repeat(400), 'x'.repeat(2001)])
    expect(() => validateSnippetTranslation('words', input)).toThrow(SnippetSkeletonError);
});
