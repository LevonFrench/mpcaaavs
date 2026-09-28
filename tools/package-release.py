"""Create a public-only portable preview and verify its extracted ZIP on the CPU."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PRODUCT = 'mpc-hc-aaavs'
DOCUMENTS = (
    'Readme.md', 'COPYING.txt', 'THIRD-PARTY-AVS-TRANSITIONS.txt', 'THIRD-PARTY-NERV.txt',
    'docs/BUILDING.md', 'docs/RELEASING.md', 'docs/RELEASE-NOTES.md',
    'docs/PRESET-MANAGEMENT.md', 'docs/NERV-SCENES.md', 'docs/AUDIO-WIRING.md',
    'docs/AVS-TRANSITIONS.md', 'docs/MPC-HC-UPSTREAM-README.md', 'docs/Compilation.md',
    'docs/Authors.txt',
)
RUNTIME_FILES = (
    f'{PRODUCT}.exe', 'visualizer/mpc.html', 'visualizer/dist/mpc-host.js',
    'visualizer/dist/avs-render.worker.js', 'visualizer/dist/nerv-render.worker.js',
)


def no_links(path):
    path = Path(os.path.abspath(path))
    for item in (*reversed(path.parents), path):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Linked release inputs and outputs are not permitted')
    return path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def privacy_check(data, roots):
    lowered = data.lower()
    for root in roots:
        if not root:
            continue
        for spelling in {str(root), str(root).replace('\\', '/'), str(root).replace('/', '\\')}:
            for encoding in ('utf-8', 'utf-16le'):
                if spelling.lower().encode(encoding) in lowered:
                    raise ValueError('Embedded build-machine path found in release input')
    # PDBs should use /PDBALTPATH:%_PDB%; never ship a full local debug path.
    if re.search(rb'RSDS.{20}[A-Za-z]:[\\/]', data, re.DOTALL):
        raise ValueError('Executable contains an absolute PDB path; rebuild with /PDBALTPATH:%_PDB%')


def package(player, output, label):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', label):
        raise ValueError('Label must be 1-64 letters, digits, dots, hyphens, or underscores')
    player, output = no_links(player), no_links(output)
    name = f'{PRODUCT}-{label}-windows-x64-lite'
    destination = output / name
    archive = output / f'{name}.zip'
    extracted = output / f'{name}-extracted'
    sidecar = output / f'{name}.zip.sha256'
    if any(path.exists() for path in (destination, archive, extracted, sidecar)):
        raise ValueError('Release output already exists; use a new label or output directory')
    inputs = [(player / relative, relative) for relative in RUNTIME_FILES]
    inputs += [(ROOT / relative, relative) for relative in DOCUMENTS]
    roots = (ROOT, os.environ.get('USERPROFILE'), os.environ.get('HOME'))
    # Validate all whitelisted inputs before creating an output directory.
    for source, relative in inputs:
        no_links(source)
        if not source.is_file():
            raise ValueError(f'Required release input is missing: {relative}')
        privacy_check(source.read_bytes(), roots)
    destination.mkdir(parents=True)
    for source, relative in inputs:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    # A fresh profile selects portable mode and contains no saved user data.
    (destination / f'{PRODUCT}.ini').write_text('[Settings]\n', encoding='utf-8')
    (destination / f'start-{PRODUCT}.cmd').write_text(
        f'@echo off\nstart "" "%~dp0{PRODUCT}.exe" %*\n', encoding='ascii')
    collection = destination / 'visualizer' / 'avs presets'
    subprocess.run(['node', str(ROOT / 'visualizer/tools/install-nerv-presets.mjs'), str(collection)],
                   check=True, cwd=ROOT)
    catalog = json.loads((collection / 'catalog/presets.json').read_text(encoding='utf-8'))
    if len(catalog['presets']) != 16 or any(entry.get('kind') != 'nerv' for entry in catalog['presets']):
        raise ValueError('Public package must contain exactly the 16 NERV scenes')
    # Lock placeholders are implementation state, not public package content.
    lock = collection / 'catalog/ratings.lock'
    if lock.exists():
        lock.unlink()
    files = sorted(path for path in destination.rglob('*') if path.is_file())
    records = {}
    for file in files:
        no_links(file)
        data = file.read_bytes()
        privacy_check(data, roots)
        records[file.relative_to(destination).as_posix()] = digest(data)
    sums = ''.join(f'{sha}  {relative}\n' for relative, sha in records.items())
    (destination / 'SHA256SUMS').write_text(sums, encoding='utf-8', newline='\n')
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package_zip:
        for file in sorted(path for path in destination.rglob('*') if path.is_file()):
            package_zip.write(file, f'{name}/{file.relative_to(destination).as_posix()}')
    # Extract only our just-created relative ZIP paths, then independently hash every file.
    with zipfile.ZipFile(archive) as package_zip:
        package_zip.extractall(extracted)
    extracted_root = extracted / name
    actual = {path.relative_to(extracted_root).as_posix() for path in extracted_root.rglob('*') if path.is_file()}
    if actual != set(records) | {'SHA256SUMS'}:
        raise ValueError('Extracted release inventory differs')
    for relative, expected in records.items():
        if digest((extracted_root / relative).read_bytes()) != expected:
            raise ValueError(f'Extracted release hash mismatch: {relative}')
    if (extracted_root / 'SHA256SUMS').read_text(encoding='utf-8') != sums:
        raise ValueError('Extracted checksum manifest differs')
    archive_hash = digest(archive.read_bytes())
    sidecar.write_text(f'{archive_hash}  {archive.name}\n', encoding='ascii')
    return archive, extracted_root, archive_hash, len(records)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--player-directory', type=Path, default=ROOT / 'bin/mpc-hc_x64 Lite')
    parser.add_argument('--output-directory', type=Path, default=ROOT / 'releases')
    parser.add_argument('--label', default='preview')
    args = parser.parse_args()
    try:
        archive, extracted, sha, count = package(args.player_directory, args.output_directory, args.label)
        print(f'Public preview: {archive}\nVerified extracted copy: {extracted}\n{count} files; SHA-256 {sha}')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Package failed: {error}\n')
