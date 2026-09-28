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
        'visualizer/avs presets/catalog/presets.json', 'visualizer/avs presets/presets/private.avs',
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
print('Public release package PASS: private-data exclusion, 16 NERV scenes, extraction hashes, overwrite and path-leak rejection.')
