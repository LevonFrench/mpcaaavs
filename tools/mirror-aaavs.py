#!/usr/bin/env python3
"""Mirror the shared visualizer into a stock AAAVS checkout, without deleting files.

Preview is the default. --apply requires an unchanged destination or its previously
recorded mirror hash. Independent destination edits are conflicts, never overwritten.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

REPO = Path(__file__).resolve().parents[1]
STATE = '.aaavs-mirror-state.json'
SPEC = REPO / 'tools' / 'aaavs-mirror.json'


def digest(data: bytes) -> str:
    # Git's LF/CRLF checkout policy is not an independent source edit.
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()


def plain(path: Path) -> None:
    for item in (path, *path.parents):
        try:
            value = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(value.st_mode) or getattr(value, 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked/reparse path is not a mirror destination: {item}')


def safe(root: Path, relative: str) -> Path:
    if not relative or '\\' in relative or ':' in relative or any(p in ('', '.', '..') for p in relative.split('/')):
        raise ValueError(f'Invalid mirror path: {relative}')
    result = root.joinpath(*relative.split('/'))
    plain(result)
    return result


def replace_once(text: str, old: str, new: str, description: str) -> str:
    if new in text:
        return text
    if text.count(old) != 1:
        raise ValueError(f'{description}: expected integration point changed; review before mirroring')
    return text.replace(old, new, 1)


def integration(target: Path, spec: dict) -> dict[str, bytes]:
    result = {}
    package = json.loads(safe(target, 'package.json').read_text(encoding='utf-8-sig'))
    if package.get('name') != 'aaavs':
        raise ValueError('Destination must be the stock AAAVS package (name: aaavs)')
    scripts = package['scripts']
    scripts.update(spec['scripts'])
    # The normal stock build continues to produce studio/projector/offline artifacts.
    for key, suffix in (('build', ' && npm run build:player'), ('check', ' && npm run check:player')):
        if suffix not in scripts[key]:
            scripts[key] += suffix
    result['package.json'] = (json.dumps(package, indent=2, ensure_ascii=False) + '\n').encode()

    server = safe(target, 'tools/serve.mjs').read_text(encoding='utf-8')
    server = replace_once(server, "import { createHash } from 'node:crypto';", "import { createLibraryHandler } from './standalone-library.mjs';\nimport { createHash } from 'node:crypto';", 'Server library import')
    server = replace_once(server, 'const server = createServer((req, res) => {', 'const handleLibrary = createLibraryHandler(root);\nconst server = createServer(async (req, res) => {\n  if (await handleLibrary(req, res)) return;', 'Server library route')
    result['tools/serve.mjs'] = server.encode()

    index = safe(target, 'index.html').read_text(encoding='utf-8')
    player_link = '  <a id="sharedPlayer" href="standalone.html" style="position:fixed;top:12px;right:12px;z-index:20;padding:8px 12px;border:1px solid #606060;border-radius:3px;background:#202020;color:#eee;text-decoration:none">Player · presets &amp; setups</a>'
    if 'id="sharedPlayer"' not in index:
        index = replace_once(index, '  <canvas id="stage"></canvas>', '  <canvas id="stage"></canvas>\n' + player_link, 'Studio player link')
    # Published static Studio deployments do not have the local library service.
    # Keep their existing workflow intact and do not expose a dead Player link.
    local_link = player_link.replace('id="sharedPlayer"', 'id="sharedPlayer" hidden') + '\n  <script type="module">if (["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) document.getElementById("sharedPlayer").hidden = false;</script>'
    if local_link not in index:
        index = replace_once(index, player_link, local_link, 'Local Player availability')
    result['index.html'] = index.encode()

    ignore_path = safe(target, '.gitignore')
    ignore = ignore_path.read_text(encoding='utf-8')
    if f'/{STATE}' not in ignore:
        ignore += f'\n# Local mirror bookkeeping and rollback snapshots\n/{STATE}\n/.aaavs-mirror-backups/\n'
    result['.gitignore'] = ignore.encode()

    # This stock check concerns the historical AVS bank, not NERV manifests.
    check_path = safe(target, 'tools/avs-preset-sources-check.ts')
    check = check_path.read_text(encoding='utf-8')
    old = "const local = parseLocalAvsCatalog(catalogJson, parserJson, 'http://127.0.0.1:4300/');"
    check = replace_once(check, old, old[:-1] + ".filter(entry => entry.kind !== 'nerv');", 'Legacy AVS bank fixture')
    result['tools/avs-preset-sources-check.ts'] = check.encode()
    return result


def payloads(target: Path, spec: dict) -> dict[str, bytes]:
    result = {}
    for directory in spec['directories']:
        source = safe(REPO, directory['source'])
        for file in sorted(source.rglob('*')):
            if file.is_file():
                plain(file)
                if file.suffix not in ('.ts', '.css', '.wgsl', '.nerv'):
                    raise ValueError(f'Unreviewed shared file type: {file}')
                relative = file.relative_to(source).as_posix()
                result[directory['target'] + '/' + relative] = file.read_bytes()
    for item in spec['files']:
        result[item['target']] = safe(REPO, item['source']).read_bytes()
    result.update(integration(target, spec))
    return result


def atomic(path: Path, data: bytes) -> None:
    plain(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.aaavs-mirror-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def mirror(target: Path, apply: bool = False) -> dict:
    target = target.absolute()
    plain(target)
    if target == (REPO / 'visualizer').absolute():
        raise ValueError('The source checkout cannot be its own mirror destination')
    spec = json.loads(SPEC.read_text(encoding='utf-8'))
    state_path = safe(target, STATE)
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'version': 1, 'files': {}}
    if state.get('version') != 1 or not isinstance(state.get('files'), dict):
        raise ValueError('Unsupported mirror state')
    payload = payloads(target, spec)
    changes, conflicts = [], []
    for relative, data in payload.items():
        destination = safe(target, relative)
        actual = destination.read_bytes() if destination.exists() else None
        if actual is not None and digest(actual) == digest(data):
            continue
        previous = state['files'].get(relative)
        allowed = previous or spec['bootstrap'].get(relative)
        # Generated additions still need the original/last-mirrored hash when
        # they would change a file; never overwrite an independently edited script.
        if actual is not None and digest(actual) != allowed:
            conflicts.append(relative)
        else:
            changes.append((relative, actual, data))
    # Missing formerly mirrored files are intentional destination deletions until reviewed.
    for relative, actual, _ in changes:
        if actual is None and relative in state['files']:
            conflicts.append(relative)
    obsolete = [relative for relative in state['files'] if relative not in payload and safe(target, relative).exists()]
    conflicts.extend(obsolete)
    if conflicts:
        return {'status': 'conflict', 'target': str(target), 'conflicts': sorted(set(conflicts)), 'obsolete': obsolete, 'changed': 0}
    report = {'status': 'different' if changes else 'current', 'target': str(target), 'changed': len(changes), 'files': [row[0] for row in changes]}
    if not apply:
        return report
    lock = safe(target, '.aaavs-mirror.lock')
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        os.close(descriptor)
        # All conflicts are found before writing anything. Recheck for concurrent edits.
        for relative, before, _ in changes:
            path = safe(target, relative)
            actual = path.read_bytes() if path.exists() else None
            if actual != before:
                raise ValueError(f'Concurrent destination edit: {relative}')
        # Keep recoverable originals under an ignored content-addressed directory.
        for relative, before, data in changes:
            if before is not None:
                backup = safe(target, '.aaavs-mirror-backups/' + hashlib.sha256(before).hexdigest() + '/' + relative)
                if not backup.exists():
                    atomic(backup, before)
            atomic(safe(target, relative), data)
        state['files'] = {relative: digest(data) for relative, data in payload.items()}
        atomic(state_path, (json.dumps(state, indent=2, sort_keys=True) + '\n').encode())
        report['status'] = 'applied' if changes else 'current'
    finally:
        lock.unlink()
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, required=True, help='Absolute stock AAAVS directory')
    parser.add_argument('--apply', action='store_true', help='Apply reviewed differences; default is read-only')
    parser.add_argument('--check', action='store_true', help='Exit 1 on drift; useful as a release gate')
    arguments = parser.parse_args()
    if not arguments.target.is_absolute():
        parser.error('--target must be absolute')
    if arguments.apply and arguments.check:
        parser.error('--apply and --check are mutually exclusive')
    try:
        report = mirror(arguments.target, arguments.apply)
        print(json.dumps(report, indent=2))
        raise SystemExit(2 if report['status'] == 'conflict' else 1 if arguments.check and report['changed'] else 0)
    except (OSError, ValueError) as error:
        parser.exit(2, f'Mirror stopped: {error}\n')
