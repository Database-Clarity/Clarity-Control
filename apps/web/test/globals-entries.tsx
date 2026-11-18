import { createRoot } from 'react-dom/client';
import { HashRouter, useLocation } from 'react-router-dom';
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
if (new URLSearchParams(location.search).has('largeList')) {
  const row = seed.impacts.g_damage0001[0];
  for (let index = 1; index <= 80; index++) {
    const copy = structuredClone(row);
    copy.id = `review_${100 + index}_en_live`;
    copy.name = `Focused Fury consumer ${index}`;
    copy.consumer.hash = 100 + index;
    copy.review.consumer.hash = 100 + index;
    seed.impacts.g_damage0001.push(copy);
  }
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
/** `#/globals/<id>` picks the entry, as the app route does; any other path opens the first. */
function Fixture() {
  const id = /^\/globals\/([^/]+)/.exec(useLocation().pathname)?.[1] ?? '';
  return (
    <GlobalEntryWorkspace
      service={fixture.service}
      actor={actor}
      projectionSource={fixture.projection}
      entryId={id}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <HashRouter>
    <Fixture />
  </HashRouter>,
);
