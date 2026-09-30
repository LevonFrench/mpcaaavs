"""CPU fixture: prove installed private data stays out of public release artifacts."""
import importlib.util
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_package', ROOT / 'tools/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
(ROOT / '.tmp').mkdir(exist_ok=True)

with tempfile.TemporaryDirectory(prefix='release-fixture-', dir=ROOT / '.tmp') as temporary:
    fixture = Path(temporary)
    player = fixture / 'player'
    player.mkdir()
    for relative in release.RUNTIME_FILES:
        file = player / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'fixture build bytes')
    for relative in (
        'mpc-hc-aaavs.pdb', 'mpc-hc-aaavs.ini', 'mpc-hc-aaavs.history.ini',
        'AAAVS.WebView2/private-profile.txt', 'visualizer/avs presets/setups.json',
        'visualizer/avs presets/folders.json', 'visualizer/avs presets/stats.json',
        'visualizer/avs presets/catalog/presets.json', 'visualizer/avs presets/presets/private.avs',
        'visualizer/hud-presets/showcase/private.hud', 'visualizer/hud-presets.private/hud-titles.json',
        'visualizer/avs presets/catalog/hud-titles.json',
        'show-assets-private/fixture-pack/pack.json', 'show-assets-private/fixture-pack/atlas/sprites.png',
        'visualizer/show-assets-private/fixture-pack/pack.json', 'visualizer/show-assets-private/fixture-pack/atlas/sprites.png',
        'MediaInfo.dll', 'D3DX9_43.dll',
    ):
        file = player / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b'PRIVATE_FIXTURE_DO_NOT_SHIP')
    archive, extracted, sha, count = release.package(player, fixture / 'output', 'fixture')
    assert release.digest(archive.read_bytes()) == sha
    assert count > 16
    with zipfile.ZipFile(archive) as package:
        for name in package.namelist():
            assert b'PRIVATE_FIXTURE_DO_NOT_SHIP' not in package.read(name), name
            assert not name.endswith(('.pdb', '.history.ini', '.dll', '.avs')), name
    with zipfile.ZipFile(archive) as package:
        assert not any('show-assets-private' in name.lower() for name in package.namelist())
    assert not any('show-assets-private' in path.as_posix().lower() for path in extracted.rglob('*'))
    assert 'show-assets-private' not in (extracted / 'SHA256SUMS').read_text()
    catalog = json.loads((extracted / 'visualizer/avs presets/catalog/presets.json').read_text())
    assert len(catalog['presets']) == 16
    assert all(item['kind'] == 'nerv' and 'rating' not in item and 'notWorking' not in item for item in catalog['presets'])
    assert (extracted / 'mpc-hc-aaavs.ini').read_text() == '[Settings]\n'
    try:
        release.package(player, fixture / 'output', 'fixture')
        raise AssertionError('Existing release overwritten')
    except ValueError as error:
        assert 'already exists' in str(error)
    for data in (
        str(ROOT).encode(), str(ROOT).encode('utf-16le'),
        b'RSDS' + bytes(20) + b'C:\\private\\candidate.pdb\0',
    ):
        try:
            release.privacy_check(data, (ROOT,))
            raise AssertionError('Build-machine path was accepted')
        except ValueError:
            pass
    release.privacy_check(b'RSDS' + bytes(20) + b'mpc-hc-aaavs.pdb\0', (ROOT,))
    # The guard itself: any spelling of a path inside a private asset directory is refused; ordinary paths are not.
    for name in (
        'show-assets-private/pack/pack.json', 'visualizer/show-assets-private/pack/atlas/a.png', 'a/Show-Assets-Private/x',
        'SHOW-ASSETS-PRIVATE', 'a\\show-assets-private\\x', 'a//show-assets-private//x', 'show-assets-private./x', 'show-assets-private /x',
    ):
        try:
            release.private_asset_check((name,))
            raise AssertionError(f'Private asset path was accepted: {name!r}')
        except ValueError as error:
            assert 'Private show assets' in str(error)
    release.private_asset_check(('visualizer/mpc.html', 'visualizer/dist/mpc-host.js', 'docs/design/ASSET-PACK-MANIFEST.md', 'show-assets/fonts/a.ttf', 'my-show-assets-private-notes.txt'))
    # A private directory reaching the whitelisted inputs stops packaging before any output is created.
    saved = release.RUNTIME_FILES, release.DOCUMENTS
    try:
        for attribute, entry in (('RUNTIME_FILES', 'visualizer/show-assets-private/fixture-pack/pack.json'), ('DOCUMENTS', 'show-assets-private/notes.md')):
            release.RUNTIME_FILES, release.DOCUMENTS = saved
            setattr(release, attribute, (*getattr(release, attribute), entry))
            if attribute == 'RUNTIME_FILES':
                (player / entry).parent.mkdir(parents=True, exist_ok=True)
                (player / entry).write_bytes(b'PRIVATE_FIXTURE_DO_NOT_SHIP')
            try:
                release.package(player, fixture / 'guarded', attribute.lower())
                raise AssertionError(f'Private asset input was packaged via {attribute}')
            except ValueError as error:
                assert 'Private show assets' in str(error), error
            assert not (fixture / 'guarded').exists() or not any((fixture / 'guarded').iterdir()), 'guard must stop before creating output'
    finally:
        release.RUNTIME_FILES, release.DOCUMENTS = saved
    # The repository keeps private packs out of git at both places a host can read them from.
    ignore = (ROOT / '.gitignore').read_text().splitlines()
    assert '/show-assets-private/' in ignore and '/visualizer/show-assets-private/' in ignore
    assert not any(release.PRIVATE_ASSET_DIRECTORY in part.lower() for part in release.RUNTIME_FILES + release.DOCUMENTS)
print('Public release package PASS: private-data exclusion, 16 NERV scenes, extraction hashes, overwrite and path-leak rejection, show-assets-private exclusion and guard.')
