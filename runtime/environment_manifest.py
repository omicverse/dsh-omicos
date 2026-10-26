"""Hash an environment from a base Python -I -S process, without loading its site hooks."""
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import sys

root = Path(sys.argv[1]).resolve()
config = (root / 'pyvenv.cfg').read_text()
if 'include-system-site-packages = false' not in config.lower():
    raise RuntimeError('System site packages must be disabled')
locations = list(root.glob('lib/python*/site-packages')) + [root / 'Lib' / 'site-packages']
packages = {}
for distribution in metadata.distributions(path=[str(path) for path in locations if path.is_dir()]):
    name = distribution.metadata.get('Name')
    if not name or not distribution.files:
        raise RuntimeError('Distribution is missing name/files metadata')
    key = re.sub(r'[-_.]+', '-', name).lower()
    if key in packages:
        raise RuntimeError('Duplicate installed distribution')
    packages[key] = distribution.version
files = {}
size = 0
for directory, directories, names in os.walk(root, followlinks=False):
    for name in directories:
        path = Path(directory) / name
        if path.is_symlink():
            if not path.resolve().is_relative_to(root):
                raise RuntimeError('Environment directory link escapes its root')
            files['@directory-link/' + path.relative_to(root).as_posix()] = path.resolve().relative_to(root).as_posix()
    for name in names:
        path = Path(directory) / name
        resolved = path.resolve()
        # venv links only its base Python executables outside the environment.
        interpreter = path.parent.name in ('bin', 'Scripts') and re.fullmatch(r'python(?:\d+(?:\.\d+)*)?(?:\.exe)?', name)
        if not resolved.is_relative_to(root) and not interpreter:
            raise RuntimeError('Environment file link escapes its root')
        if not resolved.is_file():
            raise RuntimeError('Environment file is not regular')
        if len(files) >= 300000:
            raise RuntimeError('Environment contains too many files')
        digest = hashlib.sha256()
        with resolved.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1048576), b''):
                size += len(chunk)
                if size > 20 * 1024**3:
                    raise RuntimeError('Environment exceeds 20 GiB verification limit')
                digest.update(chunk)
        files[path.relative_to(root).as_posix()] = digest.hexdigest()
canonical = json.dumps({'packages': packages, 'files': files}, sort_keys=True, separators=(',', ':'))
version = next((line.split('=', 1)[1].strip() for line in config.splitlines() if line.startswith('version =')), 'unknown')
print(json.dumps({'pythonVersion': version, 'installed': packages, 'manifestSha256': hashlib.sha256(canonical.encode()).hexdigest()}))
