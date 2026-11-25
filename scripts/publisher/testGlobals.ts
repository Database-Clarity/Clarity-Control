import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inventoryGlobals, projectGlobals } from '../../packages/core/src/globals/projection.js';
import {
  globalsInPlaceCapability,
  globalsInPlacePath,
} from '../../packages/core/src/globals/inPlaceReview.js';
import type { LegacyInput } from '../../packages/export/src/legacy.js';
import { migrateInPlace } from './globalsInPlace.js';
import { type Publisher } from './publisher.js';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Seed the real active-mode fence and its compatibility readers in publisher fixtures. */
export function activateGlobalsFixture(pub: Publisher) {
  const { dataBranch, liveBranch, repo, publisherSha, publisherDigest } = pub.options;
  const dataRef = 'refs/heads/' + dataBranch;
  const liveRef = 'refs/heads/' + liveBranch;
  const legacyData = pub.head(dataBranch);
  const legacyLive = pub.head(liveBranch);
  const data = pub.git.tree(legacyData);
  const live = pub.git.tree(legacyLive);
  const input = pub.read<LegacyInput>(live, 'liveDescriptions.json')!;
  const migratedLive = pub.git.commit(
    legacyLive,
    { ...live, 'liveDescriptions.json': pub.git.writeBlob(json(migrateInPlace(input))) },
    'Migrate fixture LIVE',
  );
  const pin = pub.read<{ capabilities: string[]; sourceSha: string; sha256: string }>(
    data,
    '.publisher/PIN',
  );
  const store = inventoryGlobals(
    [2, 3].map((hash) => ({ hash, associated: [], text: {} })),
    {
      repository: repo,
      revision: legacyData,
      locate: () => {
        throw new Error('Unexpected fixture definition');
      },
    },
    () => {
      throw new Error('Unexpected fixture global ID');
    },
  );
  const files: Record<string, unknown> = {
    [globalsInPlacePath]: {
      state: 'active',
      destination: liveBranch,
      legacyData,
      legacyLive,
      migratedLive,
    },
    '.publisher/PIN': {
      sourceSha: publisherSha,
      sha256: publisherDigest,
      capabilities: [
        ...new Set([...(pin?.capabilities ?? []), 'globalsRelease', globalsInPlaceCapability]),
      ],
    },
  };
  if (!data['globals/layout.json']) {
    for (const [hash, tooltip] of Object.entries(projectGlobals(store))) {
      files['tooltips/' + hash + '.json'] = tooltip;
    }
    files['globals/layout.json'] = { version: 1, aggregates: store.aggregates };
    files['globals/live/' + liveBranch + '.json'] = { version: 1, destination: liveBranch, store };
    files['globals/sync.json'] = {
      version: 1,
      status: 'current',
      causeIds: [],
      causeEntries: {},
      lastFailure: null,
    };
  }
  for (const [path, value] of Object.entries(files)) data[path] = pub.git.writeBlob(json(value));
  const active = pub.git.commit(legacyData, data, 'Activate fixture globals');
  pub.git.cas(liveRef, legacyLive, migratedLive);
  pub.git.cas(dataRef, legacyData, active);
}

/** The plain-node CLI verifies the installed fixture PIN against its executable bytes. */
export function pinGlobalsFixture(pub: Publisher, directory: string) {
  const ref = 'refs/heads/' + pub.options.dataBranch;
  const head = pub.head(pub.options.dataBranch);
  const tree = pub.git.tree(head);
  const bytes = readFileSync(join(directory, 'PIN'), 'utf8');
  const pin = JSON.parse(bytes) as { sourceSha: string; sha256: string };
  tree['.publisher/PIN'] = pub.git.writeBlob(bytes);
  pub.git.cas(ref, head, pub.git.commit(head, tree, 'Install fixture runtime PIN'));
  pub.options.publisherSha = pin.sourceSha;
  pub.options.publisherDigest = pin.sha256;
}
