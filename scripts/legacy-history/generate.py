"""Frozen, published-only raw history. No network or writes to source repositories."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import gzip

CUTOFF = '0bd5daebe80c1efcbad21d86658ec5d70e4f0da5'
MAPPING = '5ef58d3446c4e5a4b6bf463dec69ca55504c7904'
DATA = 'df5db11d2bb7970a77a342fa4a9ec0a133c35582'
LANGUAGES = 'en de es es-mx fr it ja ko pl pt-br ru zh-chs zh-cht'.split()
PATHS = ['liveDescriptions.json', 'liveDescription.json.json']


def git(repo, *args):
    return subprocess.check_output(['git', '--git-dir=' + str(repo), *args])


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def records_from_snapshot(snapshot):
    """A transitional file can contain both real flat records and nested placeholders."""
    flat = {key: value for key, value in snapshot.items()
            if key.isdecimal() and isinstance(value, dict)}
    nested = snapshot.get('perks', {})
    if not isinstance(nested, dict):
        raise ValueError('Malformed perks container')

    def holds_text(records):
        return any(isinstance(record, dict) and isinstance(record.get('editor'), dict)
                   and any(isinstance(value, dict) and isinstance(value.get('main'), str)
                           for value in record['editor'].values())
                   for record in records.values())

    flat_text, nested_text = holds_text(flat), holds_text(nested)
    if flat_text and nested_text:
        raise ValueError('Ambiguous authored text in both source containers')
    return flat if flat_text else nested if nested_text else {}


def project(record):
    if record is None:
        return None
    editor = record.get('editor', {})
    if ('pt-rb' in editor and 'pt-br' in editor
            and editor['pt-rb'].get('main') != editor['pt-br'].get('main')):
        raise ValueError('Conflicting Portuguese language spellings')
    return {lang: editor.get(lang, editor.get('pt-rb', {}) if lang == 'pt-br' else {})['main']
            for lang in LANGUAGES
            if isinstance(editor.get(lang, editor.get('pt-rb', {}) if lang == 'pt-br' else {}).get('main'), str)}


def resolve(source, aliases):
    seen = set()
    while source in aliases:
        if source in seen:
            raise ValueError('Alias cycle')
        seen.add(source)
        alias = aliases[source]
        # Frames and name aliases are never evidence of tooltip identity here.
        if alias['kind'] != 'sandbox':
            return None
        source = str(alias['to'])
    return source


def append_revision(lane, state, metadata):
    if lane and lane[-1]['text'] == state:
        return
    if not lane and state is None:
        return
    lane.append({**metadata, 'text': state})


class Objects:
    def __init__(self, repo):
        self.process = subprocess.Popen(['git', '--git-dir=' + str(repo), 'cat-file', '--batch'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def read(self, spec):
        self.process.stdin.write((spec + '\n').encode())
        self.process.stdin.flush()
        header = self.process.stdout.readline().split()
        if header[-1] == b'missing':
            return None
        data = self.process.stdout.read(int(header[-1]))
        assert self.process.stdout.read(1) == b'\n'
        return data

    def close(self):
        self.process.stdin.close()
        self.process.wait()


def generate(repo, mapping_repo, output):
    aliases = json.loads(git(mapping_repo, 'show', MAPPING + ':templates/v2/aliases.json'))
    items = json.loads(git(mapping_repo, 'show', MAPPING + ':templates/v2/items.json'))
    current = {pathlib.PurePosixPath(p).stem for p in git(
        repo, 'ls-tree', '-r', '--name-only', DATA, 'tooltips').decode().splitlines()}
    excluded = {str(h) for h, item in items.items()
                if item.get('categoryId') in ('weapon-frame', 'weapon-frame-enhanced')}
    for h, alias in aliases.items():
        if alias['kind'] == 'frame':
            excluded.update((h, str(alias['to'])))
    rows = git(repo, 'log', '--reverse', '--topo-order', '--format=%H%x00%an%x00%aI%x00%B%x00',
               CUTOFF, '--', *PATHS).decode().split('\x00')
    lanes, gaps = {}, []
    objects = Objects(repo)
    try:
        for offset in range(0, len(rows) - 1, 4):
            commit, author, date, message = rows[offset:offset + 4]
            commit = commit.strip()
            metadata = dict(commit=commit, author=author, date=date, message=message.rstrip())
            raw = None
            for path in PATHS:
                raw = objects.read(commit + ':' + path)
                if raw:
                    break
            if not raw:
                gaps.append(commit)
                continue
            snapshot = json.loads(raw)
            records = records_from_snapshot(snapshot)
            if not records:
                gaps.append(commit)
                continue
            eligible = {}
            for source, record in records.items():
                if not isinstance(record, dict) or 'editor' not in record:
                    continue
                target = resolve(source, aliases)
                if (source in excluded or target in excluded or target not in current
                        or record.get('type') in ('Weapon Frame', 'Weapon Frame Enhanced')):
                    continue
                eligible[source] = (target, record)
            for source in sorted(set(lanes) | set(eligible), key=int):
                if source in eligible:
                    target, record = eligible[source]
                    lane = lanes.setdefault(source, {'hash': int(target), 'sourceHash': int(source),
                                                     'verified': source == target, 'revisions': []})
                    append_revision(lane['revisions'], project(record), metadata)
                else:
                    append_revision(lanes[source]['revisions'], None, metadata)
    finally:
        objects.close()
    grouped = {}
    for lane in lanes.values():
        grouped.setdefault(lane['hash'], []).append(lane)
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError('Output must be empty; never mix generations')
    manifest = dict(schemaVersion=1, cutoff=CUTOFF, mappingCommit=MAPPING, dataCommit=DATA,
                    paths=PATHS, gaps=gaps, files={})
    for target, sources in sorted(grouped.items()):
        value = dict(schemaVersion=1, hash=target, cutoff=CUTOFF, mappingCommit=MAPPING,
                     lanes=sorted(sources, key=lambda lane: lane['sourceHash']))
        data = encode(value)
        filename = str(target) + '.json'
        (output / filename).write_bytes(data)
        manifest['files'][str(target)] = dict(sha256=hashlib.sha256(data).hexdigest(),
                                             bytes=len(data), gzipBytes=len(gzip.compress(data, mtime=0)),
                                             revisions=sum(len(l['revisions']) for l in sources))
    (output / 'manifest.json').write_bytes(encode(manifest))
    print(json.dumps(dict(files=len(grouped), bytes=sum(f['bytes'] for f in manifest['files'].values()),
                          gzipBytes=sum(f['gzipBytes'] for f in manifest['files'].values()),
                          maxBytes=max(f['bytes'] for f in manifest['files'].values()), gaps=gaps)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source_bare_repo')
    parser.add_argument('mapping_bare_repo')
    parser.add_argument('empty_output')
    args = parser.parse_args()
    generate(args.source_bare_repo, args.mapping_bare_repo, args.empty_output)
