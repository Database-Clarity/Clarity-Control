// Offline inventory only. This does not evaluate readiness or execute a workflow.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const configBytes = (config) => JSON.stringify(config, null, 2) + '\n';

export function inventory(sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Use a full source commit SHA.');
  const projects = ['clarity', 'dim', 'foundry', 'lightGG', 'crayon', 'braytech', 'vaultZero'].map(
    (preset) => {
      const id = preset.toLowerCase();
      const config = {
        schema: 1,
        id,
        name: preset,
        files: [{ id: 'descriptions', formatVersion: 1, preset }],
      };
      return {
        configPath: `exports/projects/${id}.json`,
        config,
        proposedConfigSha256: sha256(configBytes(config)),
        installedConfigSha256: null,
        oldUrls: [
          `https://database-clarity.github.io/Live-Clarity-Database/descriptions/${preset}.json`,
          `https://raw.githubusercontent.com/Database-Clarity/Live-Clarity-Database/live/descriptions/${preset}.json`,
        ],
        newUrl: `https://data.d2clarity.com/${id}/v1/descriptions.json`,
      };
    },
  );
  return {
    schema: 1,
    status: 'PREPARATION_ONLY',
    sourceCommit,
    candidateCommit: null,
    identities: {
      converterCommit: null,
      editorDataCommit: null,
      liveCommit: null,
      exportPinsCommit: null,
      pinId: null,
      inputSha256: null,
      identicalSha256: null,
      catalogSha256: null,
      generatorCommit: null,
      manifestVersion: null,
      exportEnginePin: null,
      exportEngineSha256: null,
      publisherPin: null,
      workerVersion: null,
      webArtifactSha256: null,
    },
    projects,
    evidence: Object.fromEntries(
      [
        'G-PARITY',
        'G-REFS',
        'G-PREVIEW',
        'G-BUILD',
        'G-SIZE',
        'G-COST',
        'triggers',
        'environment-refusal',
        'free-limits',
        'analytics-waf',
        'moved-local',
        'moved-hosted',
      ].map((gate) => [
        gate,
        { status: 'PENDING', candidateCommit: null, path: null, sha256: null },
      ]),
    ),
    moved: {
      oldArtifactSha256: null,
      receiverArtifactSha256: null,
      defaultArtifactSha256: null,
      headersEvidence: null,
      signInEvidence: null,
      rollbackArtifactSha256: null,
    },
    announcementDate: null,
    graceEndDate: null,
    ownerApprovals: { G2: null, G3: null, G4: null, G5: null, G6: null, G7: null },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/cutover/rehearse.mjs');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  process.stdout.write(JSON.stringify(inventory(source), null, 2) + '\n');
}
