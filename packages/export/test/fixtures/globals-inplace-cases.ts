import type { PerkTypes } from '../../src/converter/types.js';

export interface InPlaceCase {
  name: string;
  a: string;
  b?: string;
  v?: string;
  t?: string;
  x?: string;
  type?: PerkTypes;
}

const H = 'title Help (\nHelp body\n)';
const R = '<title Read [Help] />';
const shared = H;
const ref = R;
const E = 'Weapon Trait Enhanced';
const c = (name: string, a: string, options: Partial<InPlaceCase> = {}): InPlaceCase => ({
  name,
  a,
  t: H,
  ...options,
});

/** Counterexamples from the two reader reviews, including the alternate-placement trial. */
export const inPlaceCases: InPlaceCase[] = [
  c('shared note and arrow on the enhanced perk', `Text ${R}\nenhanced (\nMore\n)`, {
    type: E,
    t: 'title Help (\n#e Boost\n)',
  }),
  c('icon in a title label inside a table', '< table c >\n|<title <solar/> x [Help] />\n<$>'),
  { name: 'legacy local then global adjacent', v: 'var N = 4.5', a: 'var d = 2\nDamage #d#{N} x' },
  { name: '#e#N adjacent', v: 'var N = 4.5', a: 'Damage #e#N x' },
  { name: '#e#{N} adjacent', v: 'var N = 4.5', a: 'Damage #e#{N} x' },
  { name: '##{H} local', v: 'var H = d', a: 'var d = 2\nX ##H y' },
  { name: '##{E} to #e', v: 'var E = e', a: 'X ##E y' },
  {
    name: 'note #e, caller enhanced block, base',
    t: 'title Help (\n#e Boost\n)',
    a: `Text ${R}\nenhanced (\nMore\n)`,
  },
  {
    name: 'note <enhanced/>, caller enhanced block, base',
    t: 'title Help (\n<enhanced/> Boost\n)',
    a: `Text ${R}\nenhanced (\nMore\n)`,
  },
  {
    name: 'note block comment + caller block comment',
    t: 'title Help (\nHelp body /* c */\n)',
    a: `/* note */\nText ${R}\nEnd`,
  },
  {
    name: 'two notes with block comments',
    t: 'title Help (\n/* c */Help body\n)\ntitle Other (\nOther body /* d */\n)',
    a: `Text ${R} <title R2 [Other] />`,
  },
  {
    name: 'import main mid, next line adjacent',
    t: H,
    b: `B ${R}`,
    a: 'Before\nimport main from 200\nAfter',
  },
  {
    name: 'import main, A also mentions',
    t: H,
    b: `B ${R}`,
    a: `A ${R}\nimport main from 200\nAfter`,
  },
  {
    name: 'import inside enhanced (base)',
    t: H,
    b: `B ${R}`,
    a: 'Before\nenhanced (\nimport main from 200\nEnhOnly\n)\nAfter',
  },
  {
    name: 'import inside enhanced (enhanced)',
    type: 'Weapon Trait Enhanced',
    t: H,
    b: `B ${R}`,
    a: 'Before\nenhanced (\nimport main from 200\nEnhOnly\n)\nAfter',
  },
  {
    name: 'import inside catalyst (base)',
    t: H,
    b: `B ${R}`,
    a: 'Before\ncatalyst (\nimport main from 200\nCatOnly\n)\nAfter',
  },
  {
    name: 'import inside local title',
    t: H,
    b: `B ${R}`,
    a: 'Before <title Loc [Local] />\ntitle Local (\nimport main from 200\nEnd of local\n)',
  },
  {
    name: 'import inside export',
    t: H,
    b: `B ${R}`,
    a: 'Before\nexport Part (\nimport main from 200\nEnd part\n)\nAfter',
  },
  {
    name: 'import inside hidden export',
    t: H,
    b: `B ${R}`,
    a: 'Before\nexport hidden Part (\nimport main from 200\nEnd part\n)\nAfter',
  },
  { name: 'mention via local var name', t: H, a: 'var x = Help\nText <title Read [#x] />' },
  {
    name: 'mention via braced local var name',
    t: H,
    a: 'var x = Help\nText <title Read [#{x}] />',
  },
  { name: 'title tag no space close', t: H, a: 'Text <title Read [Help]/> end' },
  { name: 'title tag double space', t: H, a: 'Text <title Read [Help]  /> end' },
  { name: 'title tag no label', t: H, a: 'Text <title [Help] /> end' },
  { name: 'tag via local var value', t: H, a: `var x = ${R}\nText #x` },
  { name: 'tag pieces via local var', t: H, a: 'var x = [Help] />\nText <title Read #x' },
  { name: 'prefix short first', v: 'var N = 4.5\nvar Name = Energy', a: '#N then #Name' },
  { name: 'prefix local', v: 'var N = 4.5', a: 'var Nlocal = 6\n#N then #Nlocal' },
  { name: 'merged unknown', v: 'var N = 4.5', a: '#N then #Nx' },
  {
    name: 'global starts with e + enhanced block',
    v: 'var energy = 4.5',
    a: '#energy\nenhanced (\nMore\n)',
  },
  {
    name: 'element wrap var containing tag',
    v: 'var N = <yellow Scorch />',
    a: '<solar #{N} /> x',
  },
  { name: 'element wrap var containing arrow', v: 'var N = <arrow/>', a: '<solar a #{N} /> x' },
  { name: 'element wrap var w/ bracket', v: 'var N = [x]', a: '<solar a #{N} /> x' },
  { name: 'elem tag name var', v: 'var N = solar', a: '<#{N} Scorch /> x <#{N}/>' },
  { name: 'var exotic keyword', v: 'var N = exotic', a: 'A <#{N} Foo />' },
  { name: 'var with dollar patterns', v: 'var N = $& $1 $$', a: 'A #N' },
  { name: 'var with comment start', v: 'var N = a // b', a: 'A #N tail' },
  { name: 'var completing comment', v: 'var N = / x', a: 'A /#N tail\nz' },
  { name: 'var makes condition', v: 'var N = enhanced', a: 'A\n#N (\nMore\n)' },
  { name: 'var makes import', v: 'var N = import main from 200', b: 'Bb', a: 'A\n#N\nEnd' },
  { name: 'var makes import number', v: 'var N = 200', b: 'Bb', a: 'A\nimport main from #N\nEnd' },
  {
    name: 'var makes title decl',
    v: 'var N = Local',
    a: 'A <title R [Local] />\ntitle #N (\nbody\n)',
  },
  {
    name: 'var ) line in title',
    v: 'var N = )',
    a: 'A <title R [Local] />\ntitle Local (\nbody\n#N\nleak\n)',
  },
  { name: 'var ) line', v: 'var N = )', a: 'A\n#N\nB' },
  { name: 'var decl name', v: 'var N = y', a: 'var #N = 3\nA #y' },
  { name: 'empty var in decl', v: 'var N = empty', a: 'var x = #N\nA #x end' },
  {
    name: 'empty var before import',
    v: 'var N = empty',
    b: 'Bb',
    a: 'A\n#{N}import main from 200\nB',
  },
  {
    name: 'empty var before title block',
    v: 'var N = empty',
    a: 'A <title r [L] />\n#{N}title L (\nbody\n)',
  },
  { name: 'empty var before comment', v: 'var N = empty', a: 'A\n#{N}// hidden\nB' },
  { name: 'empty between local and x', v: 'var N = empty', a: 'var d = 3\nA #d#{N}x' },
  { name: 'empty between e and x', v: 'var N = empty', a: 'A #e#{N}x' },
  { name: 'pair commented malformed', v: 'var N = 4', a: 'A #N // {{broken\nB' },
  {
    name: 'pair in note import mid',
    t: 'title Help (\n{{4}{6}} s\n)',
    b: `B ${R}`,
    a: 'A\nimport main from 200\nAfter',
  },
  { name: 'pair local adj global in arm', v: 'var N = 4', a: 'var d = 2\nA {{#d#N}{6}} b' },
  {
    name: 'pair note #e enhanced block',
    t: 'title Help (\n{{4}{6}} #e s\n)',
    a: `A ${R}\nenhanced (\nm\n)`,
  },
  {
    name: 'export global blank edges',
    x: 'export P (\n\nBody\n\n)',
    a: 'A\nimport P from global\nB',
  },
  {
    name: 'export reading local',
    x: 'export P (\nBody #d\n)',
    a: 'var d = 3\nA\nimport P from global',
  },
  {
    name: 'caller local named Help, B mentions',
    t: H,
    b: `B ${R}`,
    a: 'A\nimport main from 200\ntitle Help (\nlocal\n)',
  },
  {
    name: 'B has local Help unmentioned in A global',
    t: H,
    b: 'B\n\ntitle Help (\nlocal\n)',
    a: `A ${R}\nimport main from 200`,
  },
  { name: 'caller ends unclosed title', t: H, a: `A ${R}\ntitle Loc (\nbody` },
  { name: 'caller ends unclosed export', t: H, a: `A ${R}\nexport hidden P (\nbody` },
  { name: 'caller ends unclosed enhanced', t: H, a: `A ${R}\nenhanced (\nbody` },
  {
    name: 'note in note var value',
    v: `var N = <title Z [Other] />`,
    t: `title Help (\nx #N\n)\ntitle Other (\no\n)`,
    a: R,
  },
  c('inline block comment at end', `Text ${R} /* c */`),
  c('block comment at end of last line', `Text ${R}\nlast /* c */`),
  c('import B with trailing comment mid', 'A\nimport main from 200\nAfter', {
    b: `B ${R} /* c */`,
  }),
  c('import B with trailing comment end', 'A\nimport main from 200', { b: `B ${R} /* c */` }),
  c('enhanced close trailing space', `Text ${R}\nenhanced (\nMore\n) `),
  c('enhanced close trailing space then text', `Text ${R}\nenhanced (\nMore\n) \nTail`),
  c('catalyst close trailing space', `Text ${R}\ncatalyst (\nMore\n) `),
  c('title close trailing space', `Text ${R} <title L [Loc] />\ntitle Loc (\nMore\n) `),
  c(
    'title close trailing space, text after',
    `Text ${R} <title L [Loc] />\ntitle Loc (\nMore\n) \nTail`,
  ),
  c('hidden export close trailing space', `Text ${R}\nexport hidden P (\nMore\n) `),
  c('enhanced close // comment', `Text ${R}\nenhanced (\nMore\n) // end`),
  c('enhanced close /* comment', `Text ${R}\nenhanced (\nMore\n) /* end */`),
  c('prose enhanced (x2)', `Text ${R}\nenhanced (x2) damage`),
  c('prose catalyst (x)', `Text ${R}\ncatalyst (needs upgrade) damage`),
  c('prose title foo (x)', `Text ${R}\ntitle holders (those with a title) gain`),
  c('prose export hidden', `Text ${R}\nexport hidden thing (x) gain`),
  c('enhanced open trailing space unclosed', `Text ${R}\nenhanced ( \nMore`),
  c('commented unclosed enhanced block', `Text ${R}\n/*\nenhanced (\nold\n*/\nEnd`),
  c('commented close', `Text ${R}\nenhanced (\nMore\n/*\n)\n*/`),
  c('close only in comment line', `Text ${R}\nenhanced (\nMore\n// )`),
  c('note line enhanced (x2)', `Text ${R}`, {
    t: 'title Help (\nFirst\nenhanced (x2) more\nlast\n)',
  }),
  c('note line catalyst (x2)', `Text ${R}`, {
    t: 'title Help (\nFirst\ncatalyst (x2) more\nlast\n)',
  }),
  c('note line title a (x', `Text ${R}`, { t: 'title Help (\nFirst\ntitle a (x) more\nlast\n)' }),
  c('note line export hidden', `Text ${R}`, {
    t: 'title Help (\nFirst\nexport hidden a (x) more\nlast\n)',
  }),
  c('var <enhanced/> base w block', 'A #N\nenhanced (\nMore\n)', { v: 'var N = <enhanced/>' }),
  c('var <enhanced/> base w block and #e', 'A #N #e\nenhanced (\nMore\n)', {
    v: 'var N = <enhanced/>',
  }),
  c('var <enhanced/> no block', 'A #N', { v: 'var N = <enhanced/>' }),
  c('note var <enhanced/>', R, { v: 'var N = <enhanced/>', t: 'title Help (\n#N x\n)' }),
  c('math target', 'A <title R [Help${1+1}] />', { t: 'title Help2 (\nx\n)' }),
  c('local var tag name', 'var x = title\nA <#x Read [Help] />'),
  c('local var tag name split', 'var x = tle Read [Help] />\nA <ti#x'),
  c('value /> in element', '<solar a #{N} b />', { v: 'var N = x />' }),
  c('value / before >', '<solar a #{N}> z', { v: 'var N = x /' }),
  c('element unclosed closed by value', '<solar a #N', { v: 'var N = x />' }),
  c('element unbraced then letters', '<solar Foo #N />tail', { v: 'var N = a' }),
  c('element unbraced then digit', '<solar Foo #N />5', { v: 'var N = a' }),
  c('element unbraced then longer global', '<solar #N />x', { v: 'var N = a\nvar Nx = b' }),
  c('element local var then global', 'var d = 2\n<solar Foo #d />#N', { v: 'var N = a' }),
  c('element #e then global', '<solar Foo #e />#N', { v: 'var N = a' }),
  c('element note', R, { t: 'title Help (\n<solar Foo />bar <arc #N />x\n)', v: 'var N = a' }),
  c('empty cell after var', '#N', { v: 'var N = empty' }),
  c('import B block comment before', 'A /* x */\nimport main from 200\nAfter', { b: `B ${R}` }),
  c('global export trailing comment + note', `A ${R}\nimport S from global`, {
    x: 'export S (\nBody /* c */\n)',
  }),
  c('pair in caller trailing comment', `A {{1}{2}} ${R} /* c */`),
  c('lone */ in note', `A ${R} /* x`, { t: 'title Help (\na */ b\n)' }),
  c(
    'local-only title via var (over-refusal)',
    'var x = <title R [Loc] />\nA #x\ntitle Loc (\nb\n)',
  ),
  c('local-only target var (over-refusal)', 'var x = Loc\nA <title R [#x] />\ntitle Loc (\nb\n)'),
  c('commented {{ in caller', `A ${R} #N // {{x`, { v: 'var N = 4' }),

  { name: 'local tag keyword', t: shared, a: 'var Tag = title\n<#Tag Read [Help] />' },
  { name: 'math title target', t: 'title 2 (\nShared body\n)', a: '<title Read [${1+1}] />' },
  {
    name: 'local-only title',
    t: shared,
    a: 'var Key = Local\n<title Read [#Key] />\ntitle Local (\nLocal body\n)',
  },
  {
    name: 'local-only title without globals',
    a: 'var Key = Local\n<title Read [#Key] />\ntitle Local (\nLocal body\n)',
  },
  {
    name: 'global keyword or text assembled',
    t: shared,
    v: 'var Title = title',
    a: '<#Title Read [Help] />',
  },
  {
    name: 'title from ordinary named fragment',
    t: shared,
    a: 'import Part from 200',
    b: `export Part (\n${ref}\n)`,
  },
  {
    name: 'generated import self from global named self',
    x: 'export self (\nSnippet\n)',
    a: 'import self from global',
  },
  {
    name: 'top-level alongside a title and trailing comment',
    t: shared,
    a: 'Before\nimport main from 200\nAfter',
    b: `${ref}\n/* trailing */`,
  },
  {
    name: 'top-level alongside a title and trailing whitespace',
    t: shared,
    a: 'Before\nimport main from 200\nAfter',
    b: `${ref}\n\n\n`,
  },
  {
    name: 'top-level alongside a title and leading whitespace',
    t: shared,
    a: 'Before\nimport main from 200\nAfter',
    b: `\n\n${ref}`,
  },
  { name: 'split note keyword by comment', t: shared, a: '<ti/* c */tle Read [Help] />' },
  { name: 'split note target by comment', t: shared, a: '<title Read [He/* c */lp] />' },
  c('trailing import comment can swallow a note', 'A\nimport main from 200\n/* z */', {
    b: `B ${R}\n/* y */`,
  }),
  c(
    'global in a condition exposed between comments',
    `/* a */\nGains #{W} ${R}\nenhanced (\nMore /* b */\n)`,
    { v: 'var W = Scorch' },
  ),
  c('global in a named ordinary export inside a comment', 'A\nimport P from 200', {
    v: 'var W = Scorch',
    b: 'B\n/*\nexport P (\nGains #{W}\n)\n*/',
  }),
  c('import after a commented opener', 'A\n/*\nenhanced (\nold\n*/\nimport main from 200\nEnd', {
    b: R,
  }),
  c('import after an apparent condition', 'A\nenhanced (x2) damage\nimport main from 200\nEnd', {
    b: R,
  }),
  c('import after a trailing-space close', 'A\nenhanced (\nMore\n) \nimport main from 200\nEnd', {
    b: R,
  }),
  c('import after a commented close', 'A\nenhanced (\nMore\n) // c\nimport main from 200\nEnd', {
    b: R,
  }),
  c('ordinary import inside a named global export', 'A\nenhanced (\nimport S from global\n)\nEnd', {
    b: R,
    x: 'export S (\nimport main from 200\nMore\n)',
  }),
];
