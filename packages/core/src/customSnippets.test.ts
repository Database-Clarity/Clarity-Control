import { expect, it } from 'vitest';
import {
  customSnippetSchema,
  customSnippetScope,
  teamSnippetSeeds,
  snippetTemplateIssue,
} from './customSnippets';

it('validates seeds and context-dependent references using the real validator', () => {
  for (const seed of teamSnippetSeeds)
    expect(customSnippetSchema.safeParse(seed).success).toBe(true);
  for (const template of [
    '#{missing}',
    '<title {{1:text}} [Unknown] />',
    'import main from {{1:123}}',
    '{{base}{enhanced}}',
    '<enhanced/> Bonus',
  ])
    expect(snippetTemplateIssue(template), template).toBeUndefined();
});
it('names invalid templates and label clashes', () => {
  for (const template of [
    '<unknown/>',
    '<bold broken',
    '#name',
    'text [ #foo',
    'Damage [#plainvar bonus',
    '#{name',
    '{{1:broken',
    '{{1}}',
    '{{0:default}}',
    '{{bad}}',
    'title Name (\nmissing close',
    'enhanced (\nmissing close',
    'import wrong',
    '${#{name}',
  ])
    expect(snippetTemplateIssue(template), template).toBeTruthy();
  for (const value of [
    { label: 'LINK', template: 'ok' },
    { label: 'x'.repeat(41), template: 'ok' },
    { label: 'Good', template: 'x'.repeat(2001) },
  ])
    expect(customSnippetSchema.safeParse({ id: 'me:1', ...value }).success).toBe(false);
});
it('rejects pathological inputs with named cheap bounds before markup validation', () => {
  expect(snippetTemplateIssue('<'.repeat(101))).toContain('100 <');
  expect(snippetTemplateIssue('#{a} '.repeat(101))).toContain('100 variable');
  expect(snippetTemplateIssue('#{{1:{a}}} '.repeat(101))).toContain('100 variable');
  expect(snippetTemplateIssue(' '.repeat(41))).toContain('40 characters');
  expect(snippetTemplateIssue('X' + (' '.repeat(40) + '{{0}}').repeat(20) + 'x')).toContain(
    '40 characters',
  );
  expect(snippetTemplateIssue('<link Text [#Anchor] />')).toBeUndefined();
  expect(snippetTemplateIssue('<title Text [#Anchor] />')).toBeUndefined();
});
it('derives scope from expanded content', () => {
  expect(customSnippetScope('var {{1:name}} = {{2:1}}')).toMatchObject({
    lineStart: true,
    enhanced: false,
  });
  expect(customSnippetScope('{{1:<enhanced/>}} hi')).toMatchObject({ enhanced: true });
  expect(customSnippetScope('{{base}{enhanced}}')).toMatchObject({ enhanced: true });
  expect(customSnippetScope('<link {{1:Enemy Rank}} [#CombatantClassifications] />')).toMatchObject(
    { link: true },
  );
});
