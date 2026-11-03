import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// No server and no remote resources. Any missed fetch injection fails closed here.
globalThis.fetch = () => {
  throw new Error('External I/O escaped CPU harness');
};
for (const mode of ['publish', 'pending', 'terminal', 'kick'])
  for (const count of [1, 100, 2511]) {
    execFileSync(process.execPath, ['scripts/publisher/cpu/prepare.mjs', mode, String(count)], {
      stdio: 'pipe',
    });
    const root = 'scripts/publisher/cpu/dist';
    const { default: worker } = await import(
      pathToFileURL(resolve(`${root}/worker.mjs`)).href + `?case=${mode}-${count}`
    );
    const { vars: env } = JSON.parse(readFileSync(`${root}/wrangler.json`));
    const { token, hashes, expected } = JSON.parse(readFileSync(`${root}/client.json`));
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = Date.now(),
      prefix = '';
    for (let i = 0; i < 10; i++) {
      prefix = alphabet[t % 32] + prefix;
      t = Math.floor(t / 32);
    }
    const opId = prefix + '0000000000000000';
    const path =
      mode === 'publish'
        ? '/publish'
        : mode === 'kick'
          ? '/publish/kick'
          : `/publish/status?opId=${opId}`;
    const response = await worker.fetch(
      new Request(`https://cpu.invalid${path}`, {
        method: mode === 'publish' || mode === 'kick' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(mode === 'publish' || mode === 'kick'
          ? { body: JSON.stringify(mode === 'publish' ? { opId, hashes, expected } : { opId }) }
          : {}),
      }),
      env,
      { waitUntil() {} },
    );
    if (response.status !== (mode === 'publish' || mode === 'kick' ? 202 : 200))
      throw new Error(`${mode}/${count}: ${response.status} ${await response.text()}`);
    console.log(`PASS ${mode}/${count}`);
  }
