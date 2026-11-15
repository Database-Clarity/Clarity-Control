// Assemble loader payloads only from exact independently reviewed candidates.
// No filesystem or git writes: callers choose an isolated output directory.
import { createHash } from 'node:crypto';
import { draftDigest, sampleInputDigest } from './fresh.mjs';
import { revisionDigest } from './revision.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceIdentity = (item) =>
  JSON.stringify([
    item.sourceCommit,
    item.source.tab,
    item.source.gid,
    item.source.range,
    item.source.text,
  ]);
const sameKeys = (a, b) =>
  a.length === b.length && [...a].sort().every((x, n) => x === [...b].sort()[n]);

export function assembleDrafts({
  census,
  batches,
  reuse,
  guideKitSha256,
  styleGuide,
  createdAt,
  model,
  knownHashes,
  parseDraft,
  parseIndex,
  validate,
}) {
  const items = new Map(census.map((item) => [String(item.hash), item]));
  if (items.size !== census.length) throw Error('Duplicate census hash');
  const accepted = new Map(),
    excluded = new Map(),
    warnings = {},
    evidence = {};
  const claim = (hash, item) => {
    const original = items.get(hash);
    if (
      !original ||
      sourceIdentity(original) !== sourceIdentity(item) ||
      JSON.stringify(original.fragmentImprovements ?? []) !==
        JSON.stringify(item.fragmentImprovements ?? []) ||
      JSON.stringify(original.baseExotic ?? null) !== JSON.stringify(item.baseExotic ?? null) ||
      original.category !== item.category ||
      original.name !== item.name
    )
      throw Error(`Source identity mismatch: ${hash}`);
    if (accepted.has(hash) || excluded.has(hash)) throw Error(`Duplicate disposition: ${hash}`);
    if (!knownHashes.has(Number(hash))) throw Error(`Unknown canonical hash: ${hash}`);
  };
  for (const {
    input,
    bytes,
    critique,
    validation,
    postReviewExclusions = { rows: [], repairAttempts: 0 },
  } of batches) {
    const drafts = JSON.parse(bytes.toString());
    const hashes = input.items.map((item) => String(item.hash));
    const sourceWarnings = drafts._meta?.sourceWarnings ?? {};
    if (
      Array.isArray(sourceWarnings) ||
      typeof sourceWarnings !== 'object' ||
      !sourceWarnings ||
      Object.entries(sourceWarnings).some(
        ([hash, values]) =>
          !hashes.includes(hash) ||
          !Array.isArray(values) ||
          values.some((value) => typeof value !== 'string'),
      )
    )
      throw Error('Invalid source warning metadata');
    if (
      new Set(hashes).size !== hashes.length ||
      input.styleGuide !== styleGuide ||
      input.guideKitSha256 !== guideKitSha256 ||
      drafts._meta?.guideKitSha256 !== guideKitSha256
    )
      throw Error('Duplicate hash or guide mismatch');
    const postExcluded = new Map(
      postReviewExclusions.rows.map((row) => [String(row.hash), row.reason]),
    );
    if (
      postExcluded.size !== postReviewExclusions.rows.length ||
      (postExcluded.size && postReviewExclusions.repairAttempts !== 1) ||
      [...postExcluded].some(
        ([hash, reason]) =>
          !hashes.includes(hash) || !reason?.trim() || critique.checksByHash?.[hash] !== 'FAIL',
      )
    )
      throw Error('Invalid post-review exclusion evidence');
    const approvedVerdict = ['APPROVE', 'PASS', 'EXCLUDE_UNRESOLVED'].includes(critique.verdict);
    // A final rejection still explicitly approves its PASS rows. After the
    // single repair, drop every failed row without changing the reviewed bytes.
    if (
      (!approvedVerdict &&
        !(
          postExcluded.size &&
          ['REJECT', 'FAIL', 'REVISE', 'REPAIR', 'REQUEST_CHANGES'].includes(critique.verdict)
        )) ||
      critique.digestsReproduced !== true ||
      critique.guideKitSha256 !== guideKitSha256 ||
      critique.draftDigest !== draftDigest(drafts) ||
      critique.revisionDigest !== revisionDigest(drafts) ||
      critique.inputDigest !== sampleInputDigest(input) ||
      critique.candidateSha256 !== sha256(bytes)
    )
      throw Error('Exact independent approval required');
    const authoredOmissions = new Map(
      (drafts._meta?.excluded ?? []).map((row) => [String(row.hash), row.reason]),
    );
    const omitted = new Map([...authoredOmissions, ...postExcluded]);
    if (
      omitted.size !== (drafts._meta?.excluded ?? []).length + postExcluded.size ||
      [...omitted].some(([hash, reason]) => !hashes.includes(hash) || !reason?.trim())
    )
      throw Error('Invalid exclusion evidence');
    const outputHashes = Object.keys(drafts).filter((key) => key !== '_meta');
    if (
      outputHashes.some((hash) => !hashes.includes(hash)) ||
      hashes.some((hash) => !outputHashes.includes(hash) && !omitted.has(hash))
    )
      throw Error('Candidate membership mismatch');
    if (
      Object.keys(validation.errors).some((hash) => !omitted.has(hash)) ||
      !sameKeys(
        [...Object.keys(validation.accepted), ...Object.keys(validation.errors)],
        hashes.filter((hash) => !authoredOmissions.has(hash)),
      ) ||
      !sameKeys(
        (validation.excluded ?? []).map((row) => String(row.hash)),
        [...authoredOmissions.keys()],
      )
    )
      throw Error('Incomplete mechanical validation');
    for (const item of input.items) {
      const hash = String(item.hash);
      claim(hash, item);
      if (omitted.has(hash)) {
        excluded.set(hash, omitted.get(hash));
        continue;
      }
      const english = drafts[hash];
      if (
        critique.checksByHash?.[hash] !== 'PASS' ||
        typeof english !== 'string' ||
        validation.accepted[hash] !== english ||
        validate(item, english).length
      )
        throw Error(`Ungated draft: ${hash}`);
      accepted.set(hash, english);
      warnings[hash] = drafts._meta?.sourceWarnings?.[hash] ?? [];
      evidence[hash] = {
        candidateSha256: critique.candidateSha256,
        inputDigest: critique.inputDigest,
      };
    }
  }
  // Duplicate cells inherit the exact approved prose only after proving their
  // item identity and complete source text match. Their own link is retained.
  for (const row of reuse) {
    const hash = String(row.hash),
      from = String(row.from),
      item = items.get(hash),
      parent = items.get(from);
    if (
      !item ||
      !parent ||
      item.category !== parent.category ||
      item.name !== parent.name ||
      item.source.text !== parent.source.text ||
      item.sourceCommit !== parent.sourceCommit
    )
      throw Error(`Unproven duplicate reuse: ${hash}`);
    claim(hash, item);
    if (excluded.has(from)) {
      excluded.set(hash, `Identical source excluded: ${from}: ${excluded.get(from)}`);
      continue;
    }
    const english = accepted.get(from);
    if (typeof english !== 'string' || validate(item, english).length)
      throw Error(`Ungated reuse: ${hash}`);
    accepted.set(hash, english);
    warnings[hash] = warnings[from];
    evidence[hash] = { ...evidence[from], identicalSourceFrom: Number(from) };
  }
  if (
    accepted.size + excluded.size !== items.size ||
    [...items.keys()].some((hash) => !accepted.has(hash) && !excluded.has(hash))
  )
    throw Error('Incomplete census coverage');
  const hashes = [...accepted.keys()].map(Number).sort((a, b) => a - b);
  const index = parseIndex({ schemaVersion: 1, hashes });
  const drafts = hashes.map((hash) => {
    const item = items.get(String(hash));
    return parseDraft({
      schemaVersion: 1,
      hash,
      english: accepted.get(String(hash)),
      sourceCommit: item.sourceCommit,
      source: item.source,
      styleGuide,
      createdAt,
      model,
    });
  });
  return {
    index,
    drafts,
    warnings,
    evidence,
    excluded: [...excluded].map(([hash, reason]) => ({ hash: Number(hash), reason })),
  };
}
