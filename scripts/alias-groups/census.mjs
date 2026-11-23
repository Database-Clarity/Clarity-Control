// node scripts/alias-groups/census.mjs DATA INPUTS ARMOUR_CENSUS OUT
// INPUTS contains the pinned generator v2 files and every names/<locale>.json.
// Produces complete A/B review rows, explicit canonical choices, and sealed S2 intent.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validator, snapshot, git, frozen, digest } from './cli.mjs';
import {
  membershipKey,
  removedMembers,
  sameDocumentMetadata,
  uniqueProposals,
} from './selection.mjs';

const [data, inputs, armourPath, out, actorId, actorLogin, generatorHead] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(generatorHead))
  throw new Error('Expected DATA INPUTS ARMOUR_CENSUS OUT ACTOR_ID ACTOR_LOGIN GENERATOR_HEAD');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + '\n');
const engine = await validator();
const head = git(data, ['rev-parse', 'HEAD']).trim();
frozen(data, head);
const facts = Object.fromEntries(
  ['items', 'aliases', 'sandboxConflicts', 'categories'].map((name) => [
    name,
    read(join(inputs, `${name}.json`)),
  ]),
);
const before = snapshot(data, head);
const config = before['config/alias-groups.json']
  ? JSON.parse(before['config/alias-groups.json'])
  : engine.emptyAliasGroups();
const tooltips = Object.fromEntries(
  Object.entries(before)
    .filter(([path]) => path.startsWith('tooltips/'))
    .map(([, raw]) => {
      const t = JSON.parse(raw);
      return [t.hash, t];
    }),
);
const localized = Object.fromEntries(
  readdirSync(join(inputs, 'names'))
    .filter((n) => n.endsWith('.json'))
    .map((name) => {
      const doc = read(join(inputs, 'names', name));
      return [doc.lang, doc];
    }),
);
for (const lang of engine.languages.filter((l) => l !== 'en')) {
  if (!localized[lang]) throw new Error(`Missing present language census ${lang}`);
}
const armour = read(armourPath).filter(
  (g) =>
    g.members.length === 2 &&
    g.members.every((m) => m.category === 'armor-mod-general' && Number.isFinite(m.cost)),
);
if (armour.length !== 102)
  throw new Error(`Expected exactly 102 approved armour pairs, got ${armour.length}`);
const pairKey = membershipKey;
const approved = new Map(armour.map((g) => [pairKey(g.members.map((m) => m.hash)), g]));
const seenArmour = new Set();
const proposalInput = read(join(inputs, 'aliasProposals.json'));
const proposals = uniqueProposals(engine.readAliasProposals(proposalInput, tooltips));
const reviews = [],
  groups = [];
for (const proposal of proposals) {
  const reasons = [];
  const approvedPair = approved.get(pairKey(proposal.members));
  let canonical = proposal.canonical;
  if (approvedPair) {
    const costs = approvedPair.members;
    if (
      costs.some(
        (m) =>
          facts.items[m.hash]?.name !== approvedPair.name ||
          facts.items[m.hash]?.categoryId !== m.category,
      )
    )
      throw new Error('Armour census facts drifted');
    const max = Math.max(...costs.map((m) => m.cost));
    const ties = costs.filter((m) => m.cost === max);
    if (
      ties.length > 1 &&
      (approvedPair.name !== 'Empowered Finish' || !ties.some((m) => m.hash === 84503918))
    )
      throw new Error('Unapproved armour energy tie');
    canonical = ties.length > 1 ? 84503918 : ties[0].hash;
    seenArmour.add(pairKey(proposal.members));
  }
  if (proposal.kind !== 'S') reasons.push('Cross-category groups are disabled by S1');
  for (const h of removedMembers(proposal.members, config))
    reasons.push(`${h} was removed from its group by a maintainer`);
  if (!approvedPair) {
    // Empty inventory descriptions alone cannot prove identical in-game text.
    for (const [lang, doc] of Object.entries(localized)) {
      const present = proposal.members.filter((h) => Object.hasOwn(doc.names, h));
      if (present.length && present.length !== proposal.members.length)
        reasons.push(`${lang}: incomplete localized membership`);
      const texts = proposal.members.map((h) =>
        JSON.stringify({
          description: doc.descriptions?.[h] ?? '',
          sandbox: (facts.items[h]?.sandboxPerkHashes ?? []).map(
            (p) => doc.sandboxPerks?.[p] ?? null,
          ),
        }),
      );
      if (new Set(texts).size > 1) reasons.push(`${lang}: different in-game text`);
    }
    if (new Set(proposal.members.map((h) => facts.items[h]?.inGameDescription)).size > 1)
      reasons.push('en: different in-game text');
    // English sandbox wording is not carried in items.json. A nonempty shared
    // sandbox-perk identity proves equality without substituting translated names.
    if (
      new Set(proposal.members.map((h) => JSON.stringify(facts.items[h]?.sandboxPerkHashes ?? [])))
        .size > 1
    )
      reasons.push('en: different sandbox-perk identities; wording requires review');
    if (proposal.textState === 'conflict') reasons.push('Clarity text conflict');
    const selected = tooltips[canonical];
    for (const h of proposal.members) {
      const t = tooltips[h];
      for (const lang of Object.keys(t?.text ?? {})) {
        if (!selected?.text[lang]) reasons.push(`Canonical lacks ${lang} from ${h}`);
        const text = t.text[lang].text;
        if (text !== selected?.text[lang]?.text && text.trim() !== `import main from ${canonical}`)
          reasons.push(`${lang}: Clarity equivalence requires review`);
      }
      if (t && !sameDocumentMetadata(t, selected, true))
        reasons.push('Clarity document metadata conflict');
    }
  }
  const selection = {
    canonical,
    members: proposal.members,
    // Acknowledgement is explicit for approved armour, and for equivalent import
    // wrappers that S2 intentionally treats as a stored-document conflict.
    ...(approvedPair ||
    proposal.members.some(
      (h) =>
        tooltips[h] &&
        (!sameDocumentMetadata(tooltips[h], tooltips[canonical]) ||
          Object.entries(tooltips[h].text).some(
            ([lang, entry]) => entry.text !== tooltips[canonical]?.text[lang]?.text,
          )),
    )
      ? { acknowledgeConflicts: true }
      : {}),
  };
  const row = {
    ...selection,
    name: proposal.basis.name,
    set: reasons.length ? 'B' : 'A',
    reasons: [...new Set(reasons)],
    armour: Boolean(approvedPair),
    readerProposedCanonical: proposal.canonical,
    generatorProposedCanonicals: [
      ...new Set(
        proposalInput.proposals
          .filter(
            (p) => p.kind === proposal.kind && pairKey(p.members) === pairKey(proposal.members),
          )
          .map((p) => p.canonical),
      ),
    ],
    ...(approvedPair
      ? { costs: approvedPair.members.map(({ hash, cost }) => ({ hash, cost })) }
      : {}),
  };
  reviews.push(row);
  if (!reasons.length) groups.push(selection);
}
if (seenArmour.size !== 102)
  throw new Error('Some approved armour pairs are absent from the current proposals');
const permissions = JSON.parse(before['config/permissions.json']);
const maintainer = permissions.users[actorId];
if (maintainer?.role !== 'maintainer' || maintainer.login !== actorLogin)
  throw new Error('Explicit planned actor must match a pinned maintainer');
const at = new Date().toISOString();
const picks = before['config/sandbox-pointers.json']
  ? JSON.parse(before['config/sandbox-pointers.json'])
  : undefined;
// Text equality cannot waive S1 dependencies. Check the complete proposed set,
// then repeat after exclusions because removing a base can disable its enhanced group.
let excluded;
do {
  const candidate = structuredClone(config);
  for (const row of reviews.filter((r) => r.set === 'A')) {
    const item = facts.items[row.canonical];
    const proposal = proposals.find((p) => pairKey(p.members) === pairKey(row.members));
    candidate.groups[row.canonical] = {
      members: row.members,
      kind: 'S',
      basis: {
        name: item.name,
        categoryId: item.categoryId,
        ...(proposal.basis.exoticFrameOwner === undefined
          ? {}
          : { exoticFrameOwner: proposal.basis.exoticFrameOwner }),
      },
      by: { id: actorId, login: actorLogin },
      at,
    };
  }
  const composed = engine.composeAliases(
    facts.aliases,
    candidate,
    facts.items,
    facts.sandboxConflicts,
    picks,
  );
  excluded = false;
  for (const issue of composed.issues) {
    const row = reviews.find((r) => r.set === 'A' && r.canonical === issue.canonical);
    if (!row) continue;
    row.set = 'B';
    row.reasons.push(
      issue.reason.includes('Enhanced member no longer shares')
        ? "S1 dependency: the bases' group must be accepted first; it remains in B"
        : `S1 composition: ${issue.reason}`,
    );
    excluded = true;
  }
} while (excluded);
groups.length = 0;
for (const row of reviews.filter((r) => r.set === 'A'))
  groups.push({
    canonical: row.canonical,
    members: row.members,
    ...(row.acknowledgeConflicts ? { acknowledgeConflicts: true } : {}),
  });
const enhanced = (group) => {
  const item = facts.items[group.canonical];
  return Number(item.isEnhanced ?? item.categoryId.includes('-enhanced'));
};
groups.sort((a, b) => enhanced(a) - enhanced(b));
mkdirSync(out, { recursive: true });
save('review.json', {
  head,
  counts: { A: groups.length, B: reviews.length - groups.length },
  groups: reviews,
  inputDigests: Object.fromEntries(
    ['items', 'aliases', 'categories', 'sandboxConflicts', 'aliasProposals'].map((n) => [
      n,
      digest(readFileSync(join(inputs, `${n}.json`))),
    ]),
  ),
});
save('selection.json', {
  head,
  generatorHead,
  at,
  actor: { id: Number(actorId), login: actorLogin },
  facts,
  groups,
});
console.log(`A=${groups.length}; B=${reviews.length - groups.length}; armour=${seenArmour.size}`);
