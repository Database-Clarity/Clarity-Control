import { readFileSync, appendFileSync } from 'node:fs';
const [urlArg, temperature, versionId] = process.argv.slice(2);
const base = new URL(urlArg);
if (
  !base.hostname.endsWith('.workers.dev') ||
  !base.hostname.includes('clarity-publisher-cpu-preview') ||
  !['cold', 'warm'].includes(temperature) ||
  !versionId
)
  throw new Error('Supply version preview URL, cold|warm, version UUID');
const { mode, count, hashes, expected, token } = JSON.parse(
  readFileSync('scripts/publisher/cpu/dist/client.json'),
);
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function opId() {
  let t = Date.now(),
    s = '';
  for (let i = 0; i < 10; i++) {
    s = alphabet[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s + '0000000000000000';
}
async function sample(index) {
  const id = opId();
  const url = new URL(
    mode === 'publish' ? '/publish' : mode === 'kick' ? '/publish/kick' : '/publish/status',
    base,
  );
  // status rejects unknown query parameters; correlation is through the sample header.
  if (mode === 'pending' || mode === 'terminal') url.searchParams.set('opId', id);
  const sampleId = `${versionId}-${temperature}-${mode}-${count}-${index}`;
  const response = await fetch(url, {
    method: mode === 'publish' || mode === 'kick' ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-CPU-Sample': sampleId,
    },
    ...(mode === 'publish' || mode === 'kick'
      ? { body: JSON.stringify(mode === 'publish' ? { opId: id, hashes, expected } : { opId: id }) }
      : {}),
  });
  const result = await response.text();
  if (response.status !== (mode === 'publish' || mode === 'kick' ? 202 : 200))
    throw new Error(`${response.status}: ${result}`);
  appendFileSync(
    'scripts/publisher/cpu/dist/samples.jsonl',
    JSON.stringify({ sampleId, versionId, temperature, mode, count, status: response.status }) +
      '\n',
  );
}
if (temperature === 'warm') await sample('prime');
for (let i = 0; i < (temperature === 'cold' ? 1 : 20); i++) await sample(i);
