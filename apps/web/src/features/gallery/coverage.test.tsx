// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { entries, excluded } from './entries';

const uiRoot = join(__dirname, '../../ui');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const pascal = (name: string) => /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
const wrappers = new Set(['memo', 'forwardRef', 'lazy']);

/** A function, class, or memo/forwardRef/lazy call: what a component's value looks like. */
function componentValue(node: ts.Expression | undefined): boolean {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)))
    node = node.expression;
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node))
    return true;
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  return wrappers.has(name);
}

const exported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const isDefault = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/**
 * The React components a module exports, however they are spelled: function and class
 * declarations, function/arrow/memo/forwardRef constants, export lists (with aliases), and default
 * exports (named by their local name, or `default`). PascalCase names only; hooks, helpers,
 * constants, and contexts are not components.
 */
function componentExports(source: string, fileName = 'module.tsx'): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const local = new Set<string>();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      local.add(statement.name.text);
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && componentValue(declaration.initializer))
          local.add(declaration.name.text);
  }
  const names: string[] = [];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (!exported(statement)) continue;
      const name = statement.name?.text;
      if (name ? pascal(name) : isDefault(statement)) names.push(name ?? 'default');
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && local.has(declaration.name.text))
          if (pascal(declaration.name.text)) names.push(declaration.name.text);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const value = statement.expression;
      if (ts.isIdentifier(value) ? local.has(value.text) : componentValue(value))
        names.push(ts.isIdentifier(value) ? value.text : 'default');
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (local.has(name) && (pascal(element.name.text) || element.name.text === 'default'))
          names.push(element.name.text);
      }
    }
  }
  return names;
}

/** Exported React components under ui/** (re-exports are counted where they are declared). */
function exportedComponents(): string[] {
  return files(uiRoot)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap((file) =>
      componentExports(readFileSync(file, 'utf8'), file).map((name) =>
        name === 'default' ? `default (${relative(uiRoot, file).replaceAll('\\', '/')})` : name,
      ),
    )
    .sort();
}

describe('UI gallery coverage', () => {
  it('finds components in every export form, and only components', () => {
    const source = `
      import { createContext, forwardRef, memo } from 'react';
      export function Declared() { return null; }
      export const Arrow = () => null;
      export const Expression = function () { return null; };
      export const Memoised = memo(() => null);
      export const Forwarded = forwardRef(() => null);
      export class Classy {}
      const Listed = () => null;
      const Hidden = () => null;
      export { Listed, Hidden as Renamed };
      export const Context = createContext(null);
      export const ARROW_PATH = 'M0 0';
      export function useThing() {}
      export const helper = () => 1;
      function NotExported() { return null; }
    `;
    expect(componentExports(source)).toEqual([
      'Declared',
      'Arrow',
      'Expression',
      'Memoised',
      'Forwarded',
      'Classy',
      'Listed',
      'Renamed',
    ]);
    expect(componentExports('export default function Page() { return null; }')).toEqual(['Page']);
    expect(componentExports('export default () => null;')).toEqual(['default']);
    expect(componentExports('const Card = () => null;\nexport default Card;')).toEqual(['Card']);
  });

  it('has an entry for every exported component under ui/', () => {
    const covered = new Set(entries.flatMap((entry) => entry.covers ?? []));
    const missing = exportedComponents().filter(
      (name) => !covered.has(name) && !(name in excluded),
    );
    // Add the component to an entry in features/gallery/entries.tsx (or, deliberately, to
    // `excluded` with the reason).
    expect(missing, `no gallery entry in ${relative(process.cwd(), uiRoot)}`).toEqual([]);
  });

  it('lists only real exports, and every exclusion has a reason', () => {
    const exported = new Set(exportedComponents());
    const named = [...entries.flatMap((entry) => entry.covers ?? []), ...Object.keys(excluded)];
    expect(named.filter((name) => !exported.has(name))).toEqual([]);
    for (const reason of Object.values(excluded)) expect(reason.trim()).not.toBe('');
  });

  it('renders every state without throwing', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    for (const entry of entries)
      for (const { label, View } of entry.states) {
        await act(async () => {
          root.render(
            <MemoryRouter>
              <View />
            </MemoryRouter>,
          );
        });
        expect(host.childNodes.length, `${entry.title}: ${label}`).toBeGreaterThan(0);
      }
    await act(async () => root.unmount());
    host.remove();
  });
});
