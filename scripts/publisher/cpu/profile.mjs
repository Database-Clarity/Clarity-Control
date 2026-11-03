// Sampling attribution is approximate; async native crypto may appear under idle/native frames.
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(process.argv[2]));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parents = new Map();
for (const node of profile.nodes)
  for (const child of node.children ?? []) parents.set(child, node.id);
const totals = {};
const frames = {};
const categories = [
  ['session crypto', /^(verifyToken|hmac|signToken)$/],
  ['App JWT RS256', /^appJwt$/],
  ['Ed25519 key import', /^signingKey$/],
  ['canonicalisation/digest', /^(stableStringify|publishIntentDigest)$/],
  ['base64', /^(base64|base64url|unbase64|btoa|atob|encodeBase64)$/],
  ['GitHub response parsing', /^(publishSnapshot|graphql|parseJsonFile)$/],
  [
    'JSON/validation',
    /^(parse|safeParse|validatePublishBody|validatePublishTime|body|JSONParse|JSONStringify)$/,
  ],
];
for (let i = 0; i < profile.samples.length; i++) {
  let id = profile.samples[i];
  const leaf = nodes.get(id).callFrame.functionName || '(anonymous)';
  const micros = profile.timeDeltas[i];
  frames[leaf] = (frames[leaf] ?? 0) + micros;
  const stack = [];
  while (id) {
    stack.push(nodes.get(id).callFrame.functionName);
    id = parents.get(id);
  }
  const category =
    categories.find(([, pattern]) => stack.some((name) => pattern.test(name)))?.[0] ??
    'native/runtime/other';
  totals[category] = (totals[category] ?? 0) + micros;
}
console.log(
  JSON.stringify(
    {
      totalsMicros: totals,
      topSelfMicros: Object.entries(frames)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    },
    null,
    2,
  ),
);
