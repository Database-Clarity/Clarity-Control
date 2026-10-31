"""Rebuild compact reviewed records. Usage: python ... <validation-dir> <research-dir>.
Inputs are dated audit artifacts, never loaded at application runtime. Review generated diffs.
"""
import json, sys
from pathlib import Path
v, r = map(Path, sys.argv[1:])
root = Path(__file__).resolve().parents[2]

def load(p):
    return json.loads(p.read_text(encoding='utf-8'))

def save(p, x):
    (root / p).write_text(json.dumps(x, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
d = load(v / 'dispositions.json')
s = load(r / 'suggestions.json')
g = load(r / 'fresh-grid.json')
nodes = {n['hash']: {'name': n['name'], 'category': n['category'], 'template': n['template'], 'imports': n['mainImports']} for e in d['entries'] for n in e['dependencyChain']}
rules = {e['hash']: {'rule': e['rule'], 'dependencies': [n['hash'] for n in e['dependencyChain']], **{k: e['expectedCurrentSourceSelection'][k] for k in ['gid', 'section', 'rowKey', 'cells']}} for e in d['entries']}
save(Path('packages/core/src/compendium/reviewed-nodes.json'), nodes)
save(Path('packages/core/src/compendium/reviewed-rules.json'), rules)
keys = {(x['gid'], x['rowKey']) for x in rules.values()}
tabs = []
for t in g['tabs']:
    rows = [row for row in t['rows'] if (t['gid'], row['name']) in keys or any((row['nameNorm'] == rr['nameNorm'] for rr in t['rows'] if (t['gid'], rr['name']) in keys))]
    if not rows:
        continue
    positions = {(row['anchor']['row'], row['anchor']['col']) for row in rows}
    for row in rows:
        for rule in rules.values():
            if (t['gid'], row['name']) == (rule['gid'], rule['rowKey']):
                positions.update(((row['anchor']['row'] + o['dRow'], row['anchor']['col'] + o['dCol']) for o in rule['cells']))
    tabs.append({**t, 'rows': rows, 'grid': [c for c in t['grid'] if (c['row'], c['col']) in positions]})
save(Path('packages/core/test/compendium/fixtures/reviewed-source.json'), {'fetchedAt': g['fetchedAt'], 'tabs': tabs})
save(Path('packages/core/test/compendium/fixtures/reviewed-expected.json'), {e['hash']: e['expectedCurrentSourceSelection']['snapshot'] for e in d['entries']})
places = []
entries = {}

def fingerprint(value):

    def js_numbers(x):
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, list):
            return [js_numbers(v) for v in x]
        if isinstance(x, dict):
            return {k: js_numbers(v) for k, v in x.items()}
        return x
    text = json.dumps(js_numbers(value), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    raw = text.encode('utf-16-le')
    h = 2166136261
    for i in range(0, len(raw), 2):
        h = (h ^ raw[i] + 256 * raw[i + 1]) * 16777619 & 4294967295
    return str(len(raw) // 2) + ':' + str(h)

def place(x, rationale):
    gid = x['gid']
    tab = next((t for t in g['tabs'] if t['gid'] == gid), None)
    key = x.get('rowKey')
    section = x.get('section')
    if not key and x.get('rows') and tab:
        candidates = [c for c in tab['grid'] if c['row'] == x['rows'][0]]
        if candidates:
            key = candidates[0]['cell']['plain'].strip()
    row = next((rr for rr in (tab or {}).get('rows', []) if rr['name'] == key), None)
    if row:
        section = row.get('section')
    elif section not in {rr.get('section') for rr in (tab or {}).get('rows', [])}:
        section = None
    p = {'gid': gid, 'rationale': rationale, 'relation': x.get('relation', 'navigation only')}
    if section:
        p['section'] = section
    if key:
        p['rowKey'] = key
        anchors = [c for c in (tab or {}).get('grid', []) if c['cell']['plain'].strip() == key.strip()]
        if len(anchors) == 1:
            a = anchors[0]
            p['fingerprint'] = fingerprint([{'dRow': c['row'] - a['row'], 'col': c['col'], 'cell': c['cell']} for c in tab['grid'] if abs(c['row'] - a['row']) <= 8])
    if x.get('relativeCells'):
        p['cells'] = x['relativeCells']
    if key:
        cells = [c['cell']['plain'].strip() for c in (tab or {}).get('grid', []) if c['cell']['plain'].strip() == key.strip()]
        if len(cells) != 1:
            p['rationale'] += ' Anchor uniqueness needs review.'
    idx = next((i for i, q in enumerate(places) if q == p), len(places))
    if idx == len(places):
        places.append(p)
    return idx
for e in s['entries']:
    if e['classification'] == 'safe-rule candidate':
        continue
    contexts = ([e['proposal']] if e['proposal'] else []) + e['alternatives'] + e['reviewContext']
    ids = [place(x, ' '.join(e['evidence']) if x.get('rowKey') else x.get('relation', 'Navigation context only.')) for x in contexts]
    entries[e['hash']] = {'name': e['name'], 'category': e['category'], 'places': ids}
save(Path('apps/web/src/features/compendium/research-hints.json'), {'observedAt': g['fetchedAt'], 'places': places, 'entries': entries})
