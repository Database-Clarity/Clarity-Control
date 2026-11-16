import { expect, it } from 'vitest';
import { missingNumberVariables } from './diagnostics';

it('requires local declarations in the English block, including transitive dependencies', () => {
  const english = 'Damage ${5+#d}.\nenhanced (\nvar d = #x\nvar x = 2\n)';
  expect(
    missingNumberVariables('#{=1}', english, undefined, 'de').map((issue) => issue.name),
  ).toEqual(['d', 'x']);
  expect(
    missingNumberVariables('#{=1}\nvar d = #x\nvar x = #{=2}', english, undefined, 'de'),
  ).toHaveLength(2);
  expect(
    missingNumberVariables(
      '#{=1}\nenhanced (\nvar d = #x\nvar x = #{=2}\n)',
      english,
      undefined,
      'de',
    ),
  ).toEqual([]);
});
