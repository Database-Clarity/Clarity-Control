import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import type { GlobalActor } from '../src/services/globals';
import { createGlobalsFixture, globalFixtureSnapshot } from './globals-entries-fixture';
import '../src/ui/global.scss';

const role = new URLSearchParams(location.search).get('role') ?? 'maintainer';
const actor: GlobalActor =
  role === 'signed-out'
    ? null
    : {
        role: role as NonNullable<GlobalActor>['role'],
        languages: ['fr'],
      };
const seed = structuredClone(globalFixtureSnapshot);
if (new URLSearchParams(location.search).has('unproven')) {
  const row = seed.impacts.g_damage0001[1];
  row.line = null;
  row.path = null;
  row.direct = null;
  row.reason = 'unproven';
}
const fixture = createGlobalsFixture(
  actor,
  new URLSearchParams(location.search).has('empty')
    ? { head: 'empty-head', entries: [], impacts: {} }
    : seed,
);
if (new URLSearchParams(location.search).has('readFailure')) fixture.controls.next = 'retry';
Object.assign(window, { globalsFixture: fixture.controls });
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <GlobalEntryWorkspace service={fixture.service} actor={actor} />
  </HashRouter>,
);
