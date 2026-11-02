import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const normalize = (text) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
export function classify(text, evidence, manifest, historicalManifest) {
  const content = text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/^\s*import\b[^\n]*/gm, '')
    .trim();
  if (!content)
    return { classification: 'placeholder', reason: 'Only comments or import directives.' };
  const authored =
    evidence.lastUpdate > 0 ||
    Boolean(
      evidence.updatedBy?.trim() &&
      evidence.v2 &&
      !/^(bot|automation|import|migration|system)(\b|\[)/i.test(evidence.updatedBy),
    );
  if (historicalManifest !== undefined && normalize(text) === normalize(historicalManifest))
    return {
      classification: 'manifest-copy',
      reason: 'Matches the normalized manifest snapshot at that revision.',
    };
  if (manifest && normalize(text) === normalize(manifest))
    return authored
      ? {
          classification: 'unclear',
          reason:
            'Authorship stamp exists, but text matches today’s manifest; historical manifest unavailable.',
        }
      : {
          classification: 'manifest-copy',
          reason: 'Matches the normalized current manifest; no human authorship evidence.',
        };
  if (authored)
    return {
      classification: 'human',
      reason: 'Nonzero legacy update or named v2 user; differs from available manifest copy.',
    };
  return {
    classification: 'unclear',
    reason: 'No reliable human authorship evidence; tracker zero does not establish authorship.',
  };
}

export function generate(
  repo,
  generatorRepo,
  dataRef = 'origin/editor-data',
  intermediateRef = 'origin/intermediate',
  manifestRef = 'HEAD',
) {
  const git = (args, cwd = repo) =>
    execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' });
  const sourceCommit = git(['rev-parse', dataRef]).trim();
  const intermediateCommit = git(['rev-parse', intermediateRef]).trim();
  const manifestCommit = git(['rev-parse', manifestRef], generatorRepo).trim();
  const items = JSON.parse(
    git(['show', `${manifestCommit}:templates/v2/items.json`], generatorRepo),
  );
  const files = git(['ls-tree', '-r', '--name-only', sourceCommit, 'tooltips'])
    .trim()
    .split('\n')
    .filter((p) => p.endsWith('.json'));
  // One batch process avoids thousands of git invocations for the current tree.
  const batch = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: files.map((p) => `${sourceCommit}:${p}\n`).join(''),
    maxBuffer: 128 * 1024 * 1024,
  });
  const current = new Map();
  let offset = 0;
  for (const path of files) {
    const end = batch.indexOf(10, offset);
    const size = Number(batch.subarray(offset, end).toString().split(' ')[2]);
    const tooltip = JSON.parse(batch.subarray(end + 1, end + 1 + size).toString());
    current.set(String(tooltip.hash), { tooltip, path });
    offset = end + size + 2;
  }
  const pending = new Map();
  const records = new Map();
  const languages = [
    'en',
    'de',
    'es',
    'es-mx',
    'fr',
    'it',
    'ja',
    'ko',
    'pl',
    'pt-br',
    'ru',
    'zh-chs',
    'zh-cht',
  ];
  for (const [hash] of current)
    for (const lang of languages) pending.set(`${hash}:${lang}`, { hash, lang });
  function inspect(commit, path, hash, lang, text, evidence, name, snapshot) {
    const key = `${hash}:${lang}`;
    if (!pending.has(key) || current.get(hash)?.tooltip.text[lang]?.text?.trim()) return;
    if (!text?.trim()) return;
    const clearing = pending.get(key).clearing;
    if (!clearing) return;
    records.set(key, {
      hash: Number(hash),
      lang,
      name: name || items[hash]?.name || hash,
      text,
      lastNonemptyCommit: commit,
      path,
      clearingCommit: clearing.commit,
      clearingAuthor: clearing.author,
      clearingDate: clearing.date,
      ...classify(
        text,
        evidence,
        lang === 'en' ? items[hash]?.inGameDescription : undefined,
        snapshot,
      ),
    });
    pending.delete(key);
  }
  function commits(ref, path) {
    return git(['log', '--first-parent', '--format=%H%x09%an%x09%aI', ref, '--', path])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, author, date] = line.split('\t');
        return { commit, author, date };
      });
  }
  // Batch each v2 revision's changed files instead of launching git per tooltip.
  const v2Log = git([
    'log',
    '--first-parent',
    '--format=COMMIT%H%x09%an%x09%aI',
    '--name-only',
    sourceCommit,
    '--',
    'tooltips',
  ]);
  let info;
  const revisions = [];
  for (const line of v2Log.split('\n')) {
    if (line.startsWith('COMMIT')) {
      const [commit, author, date] = line.slice(6).split('\t');
      info = { commit, author, date, paths: [] };
      revisions.push(info);
    } else if (line.startsWith('tooltips/') && current.has(line.slice(9, -5)))
      info.paths.push(line);
  }
  for (const revision of revisions) {
    if (!revision.paths.length) continue;
    const versions = execFileSync('git', ['-C', repo, 'cat-file', '--batch'], {
      input: revision.paths.map((p) => `${revision.commit}:${p}\n`).join(''),
      maxBuffer: 128 * 1024 * 1024,
    });
    let position = 0;
    for (const path of revision.paths) {
      const end = versions.indexOf(10, position);
      const header = versions.subarray(position, end).toString();
      const size = Number(header.split(' ')[2]);
      if (header.endsWith(' missing')) {
        position = end + 1;
        continue;
      }
      const value = JSON.parse(versions.subarray(end + 1, end + 1 + size).toString());
      position = end + size + 2;
      const hash = String(value.hash);
      for (const lang of languages) {
        const state = pending.get(`${hash}:${lang}`);
        if (!state || current.get(hash)?.tooltip.text[lang]?.text?.trim()) continue;
        const entry = value.text[lang];
        if (!entry?.text?.trim()) state.clearing = revision;
        else
          inspect(
            revision.commit,
            path,
            hash,
            lang,
            entry.text,
            { ...entry, v2: true },
            '',
            lang === 'en' ? value.bungieSnapshot?.description : undefined,
          );
      }
    }
  }
  // Initial v2 import is not evidence of a legacy clearing commit.
  for (const state of pending.values()) delete state.clearing;
  for (const info of commits(intermediateCommit, 'intermediateDescriptions.json')) {
    const raw = git(['show', `${info.commit}:intermediateDescriptions.json`]);
    if (!raw.trim()) continue; // Known zero-byte merge anomaly must not count as individual clears.
    const groups = JSON.parse(raw);
    const values = Object.assign(
      {},
      ...Object.values(groups).filter((v) => v && typeof v === 'object'),
    );
    for (const state of pending.values()) {
      const { hash, lang } = state;
      if (current.get(hash)?.tooltip.text[lang]?.text?.trim()) continue;
      const value = values[hash];
      const text = value?.editor?.[lang]?.main;
      if (!text?.trim()) state.clearing = info;
      else
        inspect(
          info.commit,
          'intermediateDescriptions.json',
          hash,
          lang,
          text,
          value.updateTracker?.descriptions?.[lang] ?? {},
          value.name,
        );
    }
  }
  return {
    version: 1,
    sourceCommit,
    intermediateCommit,
    manifestCommit,
    records: [...records.values()].sort((a, b) => a.hash - b.hash || a.lang.localeCompare(b.lang)),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, generatorRepo, output, dataRef, intermediateRef, manifestRef] =
    process.argv.slice(2);
  if (!repo || !generatorRepo || !output)
    throw new Error(
      'Usage: node scripts/lost-text/generate.mjs DATA_REPO GENERATOR_REPO OUTPUT [DATA_REV INTERMEDIATE_REV MANIFEST_REV]',
    );
  const artifact = generate(repo, generatorRepo, dataRef, intermediateRef, manifestRef);
  writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n');
  process.stdout.write(
    `Generated ${artifact.records.length} records against ${artifact.sourceCommit}\n`,
  );
}
