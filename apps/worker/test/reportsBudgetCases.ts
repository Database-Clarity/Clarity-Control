export type BudgetSend = (
  label: string,
  path: string,
  method?: string,
  body?: unknown,
  id?: number,
  headers?: Record<string, string>,
) => Promise<Response>;
export async function reportBudgetCases(send: BudgetSend, execute: (sql: string) => Promise<void>) {
  const payload = {
    request_id: crypto.randomUUID(),
    withdraw_secret: 'a'.repeat(43),
    viewed_hash: 123,
    lang: 'en',
    rev: 'a'.repeat(16),
    data_commit: '1'.repeat(40),
    category: 'wrong-value',
    note: 'x'.repeat(1000),
    notes: Array.from({ length: 5 }, () => ({
      category: 'wrong-value',
      text: 'x'.repeat(500),
      anchor: {
        rev: 'a'.repeat(16),
        exact: 'x'.repeat(200),
        prefix: 'p'.repeat(32),
        suffix: 's'.repeat(32),
        start: 0,
        end: 200,
        line: 0,
      },
    })),
    links: ['https://youtu.be/example', 'https://streamable.com/example'],
    turnstile: 'valid',
  };
  Object.assign(payload, {
    source_url: 'https://example.org/' + 'x'.repeat(2000),
    src: 's'.repeat(64),
  });
  const oversize = new TextEncoder().encode(JSON.stringify(payload)).length - 8192;
  if (oversize > 0)
    payload.note = payload.note.slice(0, Math.max(0, payload.note.length - oversize));
  const created = await send('POST max five notes', '/reports', 'POST', payload, 5);
  if (created.status !== 201)
    throw new Error(`Budget POST failed: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  await send('POST idempotent retry', '/reports', 'POST', payload, 5);
  await execute('DELETE FROM limits');
  const selector = {
    ...payload,
    request_id: crypto.randomUUID(),
    note: '',
    notes: [
      {
        ...payload.notes[0],
        anchor: { ...payload.notes[0].anchor, exact: 'x'.repeat(4096), end: 4096 },
      },
    ],
  };
  const long = await send('POST max selector', '/reports', 'POST', selector);
  if (long.status !== 201) throw new Error(`Selector budget failed: ${long.status}`);
  const longId = ((await long.json()) as { id: string }).id;
  await send('Receipt status', `/reports/r/${id}`);
  await send('Receipt full five notes', `/reports/r/${id}/view`, 'POST', {}, 5);
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    const image = new Uint8Array(524288),
      view = new DataView(image.buffer);
    if (mime === 'image/jpeg') image.set([255, 216, 255, 218]);
    if (mime === 'image/png') {
      image.set([137, 80, 78, 71, 13, 10, 26, 10]);
      view.setUint32(8, image.length - 32);
      image.set(new TextEncoder().encode('IDAT'), 12);
      image.set(new TextEncoder().encode('IEND'), image.length - 8);
    }
    if (mime === 'image/webp') {
      image.set(new TextEncoder().encode('RIFF'));
      view.setUint32(4, image.length - 8, true);
      image.set(new TextEncoder().encode('WEBPVP8 '), 8);
      view.setUint32(16, image.length - 20, true);
    }
    const result = await send(`Upload 512 KiB ${mime}`, `/reports/${id}/files`, 'POST', image, 5, {
      'Content-Type': mime,
      'X-Report-Request-Id': payload.request_id,
    });
    if (result.status !== 201)
      throw new Error(`Budget upload failed: ${result.status} ${await result.text()}`);
  }
  await send('Read 512 KiB screenshot', `/reports/${id}/files/1`, 'GET', undefined, 1);
  await send('Delete screenshot', `/reports/${id}/files/1`, 'DELETE', undefined, 1);
  await execute(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<199) INSERT INTO reports(id,owner_hash,viewed_hash,variant,lang,rev,data_commit,category,note,trust,request_id,payload_hash,created_at,updated_at) SELECT 'seed-'||x,123,123,'base','en','aaaaaaaaaaaaaaaa','1111111111111111111111111111111111111111','wrong-value','${'x'.repeat(1000)}','anonymous','seed-'||x,'test',1,1 FROM n`,
  );
  await execute(
    `INSERT INTO notes(report_id,n,category,text,exact,prefix,suffix,start,end,line,whole) SELECT r.id,n.n,n.category,n.text,n.exact,n.prefix,n.suffix,n.start,n.end,n.line,n.whole FROM reports r CROSS JOIN notes n WHERE r.id LIKE 'seed-%' AND n.report_id='${id}'`,
  );
  await send('Tooltip 200 reports 1000 notes', '/reports?hash=123&lang=en', 'GET', undefined, 1);
  await send('Public anchors bounded 100', '/reports/public?hash=123&lang=en');
  await send('My reports', '/reports/mine', 'GET', undefined, 5);
  await send('Grouped list', '/reports/list', 'GET', undefined, 1);
  await execute(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1695) INSERT OR IGNORE INTO open_counts SELECT x,lang,1 FROM n CROSS JOIN (SELECT 'en' lang UNION SELECT 'de' UNION SELECT 'fr')`,
  );
  const index = await send('Full index 5085 keys', '/reports/index', 'GET', undefined, 1);
  await send('Index 304', '/reports/index', 'GET', undefined, 1, {
    'If-None-Match': index.headers.get('ETag')!,
  });
  await send(
    'Reanchor max selector',
    `/reports/${id}/action`,
    'POST',
    { action: 'reanchor', expected_version: 1, n: 1, anchor: selector.notes[0].anchor },
    1,
  );
  await send(
    'Close action',
    `/reports/${id}/action`,
    'POST',
    { action: 'close', expected_version: 2 },
    1,
  );
  await send(
    'Reopen action',
    `/reports/${id}/action`,
    'POST',
    { action: 'reopen', expected_version: 3 },
    1,
  );
  await send('Withdraw three screenshots', `/reports/r/${id}/withdraw`, 'POST', {}, 5);
  await send('Maintainer DELETE', `/reports/${longId}`, 'DELETE', undefined, 1);
  await send('Admin storage', '/reports/admin', 'GET', undefined, 1);
  await send(
    'Admin pause',
    '/reports/admin',
    'POST',
    { action: 'pause', scope: 'anonymous', value: true },
    1,
  );
  await send('Purge bounded eight reports', '/reports/admin', 'POST', { action: 'purge-now' }, 1);
}
