import { useState } from 'react';
import type { CustomSnippet } from '../../../../../packages/core/src/customSnippets';
import { SnippetConflictError } from '../../services/snippets';
import { SnippetManager } from '../snippets/SnippetManager';
import { SnippetFields, snippetErrors, type SnippetDraft } from '../snippets/SnippetFields';

/** Real snippets, one long German label at the limit, one multi-line declaration. */
const fixtures: CustomSnippet[] = [
  {
    id: 'me:refills',
    label: 'Refills (magazine)',
    template: '<title {{1:refills}} [G_refill] />',
  },
  {
    id: 'me:rank',
    label: 'Gegnerrang-Verknüpfung für Kampfeinheit',
    template: '<link {{1:Enemy Rank}} [#CombatantClassifications] />',
  },
  { id: 'me:ammo', label: 'Ammo variable', template: 'var ammo = {{1:3}}\n#{ammo} rounds' },
];

/** The list with local saves only; `conflict` makes every save report a conflict. */
export function SnippetListDemo({
  start = fixtures,
  loading = false,
  error = null,
  conflict = false,
}: {
  start?: CustomSnippet[] | null;
  loading?: boolean;
  error?: string | null;
  conflict?: boolean;
}) {
  const [list, setList] = useState(start);
  return (
    <SnippetManager
      name="Demo snippets"
      snippets={loading || error ? null : list}
      limit={50}
      status={{ loading, error }}
      onReload={() => setList(start)}
      newId={() => `me:${Date.now()}`}
      save={async (current, next) => {
        if (conflict) throw new SnippetConflictError(null);
        setList((now) => {
          const rest = (now ?? []).filter((s) => s.id !== (current ?? next)?.id);
          return next ? [...rest, next] : rest;
        });
      }}
    />
  );
}

/** The fields with the shared validator's messages showing (a clash and a bad template). */
export function SnippetErrorsDemo() {
  const [draft, setDraft] = useState<SnippetDraft>({
    label: 'Base with enhanced bonus',
    keywords: '',
    template: '<shiny {{1:text}} />',
  });
  return <SnippetFields draft={draft} errors={snippetErrors(draft)} onChange={setDraft} />;
}
