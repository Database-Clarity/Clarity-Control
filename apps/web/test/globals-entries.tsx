import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { GlobalEntryWorkspace } from '../src/features/globals/GlobalEntryWorkspace';
import type { GlobalActor, GlobalSyncState } from '../src/services/globals';
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
const syncStatus = new URLSearchParams(location.search).get('sync');
if (syncStatus === 'sync-pending' || syncStatus === 'sync-failed') {
  const state: GlobalSyncState = {
    status: syncStatus,
    causeIds: ['fixture-cause'],
    lastFailure:
      syncStatus === 'sync-failed'
        ? 'Fixture sync failed: source changed during calculation.'
        : undefined,
  };
  seed.sync.g_damage0001 = state;
  seed.destinationSync.live = { ...state };
}
const fixture = createGlobalsFixture(
  actor,
  new URLSearchParams(location.search).has('empty')
    ? {
        head: '0000000000000000000000000000000000000000',
        entries: [],
        impacts: {},
        sync: {},
        destinationSync: {},
      }
    : seed,
  new URLSearchParams(location.search).has('largeProjection'),
);
if (new URLSearchParams(location.search).has('readFailure')) fixture.controls.next = 'retry';
Object.assign(window, { globalsFixture: fixture.controls });
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <GlobalEntryWorkspace
      service={fixture.service}
      actor={actor}
      projectionSource={fixture.projection}
    />
  </HashRouter>,
);
