import type { Completion, CompletionContext } from '@codemirror/autocomplete';
import {
  extractBlocks,
  extractVariables,
  markupColors,
  markupEmpty,
  markupIcons,
  type MarkupGlobals,
} from '@clarity/core';

export function clarityCompletions(globals: MarkupGlobals) {
  return (context: CompletionContext) => {
    const text = context.state.doc.toString();
    const before = context.state.doc.sliceString(
      context.state.doc.lineAt(context.pos).from,
      context.pos,
    );
    const variables = { ...extractVariables(text), ...extractVariables(globals.variables) };
    const titles = { ...extractBlocks(text, 'title'), ...extractBlocks(globals.titles, 'title') };
    let options: Completion[] = [];
    let match: RegExpMatchArray | null;
    if ((match = before.match(/#[a-zA-Z0-9]*$/))) {
      options = Object.entries(variables).map(([name, value]) => ({
        label: `#${name}`,
        type: 'variable',
        detail: value,
      }));
    } else if ((match = before.match(/(?<=<title .*\[)[A-z0-9 ]*$/))) {
      options = Object.entries(titles).map(([label, detail]) => ({ label, type: 'text', detail }));
    } else if ((match = before.match(/(?<=^import .+ from )[a-zA-Z0-9]*$/))) {
      options = Object.keys(globals.imports ?? {}).map((label) => ({ label, type: 'module' }));
      if (globals.imports?.['1'] && !options.some((option) => option.label === 'global')) {
        options.push({ label: 'global', type: 'module' });
      }
    } else if ((match = before.match(/(?<=^import )[A-z0-9 ]*$/))) {
      const names = new Set([
        'main',
        ...Object.values(globals.imports ?? {}).flatMap((source) =>
          Object.keys(extractBlocks(source, 'export')),
        ),
      ]);
      options = [...names].map((label) => ({ label, type: 'module' }));
    } else if ((match = before.match(/<[a-zA-Z]*$/))) {
      options = [...new Set([...markupColors, ...markupIcons, ...markupEmpty])].map((name) => ({
        label: `<${name}/>`,
        type: 'keyword',
      }));
      options.push(
        { label: '<title', apply: '<title Text [Name] />', type: 'keyword' },
        { label: '<link', apply: '<link Text [https://example.com] />', type: 'keyword' },
      );
    } else if (context.explicit) {
      match = before.match(/\w*$/);
      options = [
        'var',
        'title',
        'export',
        'export hidden',
        'import',
        'enhanced',
        'catalyst',
        'exotic perk',
      ].map((label) => ({
        label,
        type: 'keyword',
      }));
    } else return null;
    return {
      from: context.pos - (match?.[0].length ?? 0),
      options,
      validFor: /^[#<A-z0-9 ]*$/,
    };
  };
}
