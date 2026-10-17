"""Verify every archive/checksum, then run fictional smoke tests from an extracted install."""
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

root = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_payload(directory):
    expected = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        checksum, name = line.split('  ', 1)
        path = Path(name)
        if path.is_absolute() or '..' in path.parts or name in expected:
            raise ValueError('Unsafe or duplicate checksum path')
        expected[name] = checksum
    actual = {str(p.relative_to(directory)): digest(p) for p in directory.rglob('*')
              if p.is_file() and p != directory / 'SHA256SUMS'}
    if actual != expected:
        raise ValueError('Archive contents do not match SHA256SUMS')


def verify(archive):
    expected, filename = Path(str(archive) + '.sha256').read_text().strip().split('  ', 1)
    if filename != archive.name or digest(archive) != expected:
        raise ValueError('Archive checksum mismatch')
    with tempfile.TemporaryDirectory(prefix='inboxtop-release-check-') as temporary:
        with tarfile.open(archive) as bundle:
            members = bundle.getmembers()
            names = set()
            for member in members:
                path = Path(member.name)
                if (path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir())
                        or member.name in names):
                    raise ValueError('Unsafe archive member')
                names.add(member.name)
            # Python 3.11 distributions do not all include tarfile's newer data
            # filter. Extract only the regular files/directories validated above;
            # never delegate links, devices or owner/setuid bits to tarfile.
            for member in members:
                destination = Path(temporary) / member.name
                if not destination.resolve().is_relative_to(Path(temporary).resolve()):
                    raise ValueError('Archive path escaped the extraction directory')
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, destination.open('wb') as target:
                        shutil.copyfileobj(source, target)
                    destination.chmod(member.mode & 0o777)
        dirs = list(Path(temporary).iterdir())
        if len(dirs) != 1 or not dirs[0].is_dir():
            raise ValueError('Expected one release directory')
        directory = dirs[0]
        verify_payload(directory)
        manifest_path = directory / 'BUILD.json'
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            executable = manifest['executable']
            if Path(executable).name != executable:
                raise ValueError('Invalid executable name')
            binary = directory / executable
            # No user's settings, .env, credentials or runtime preload configuration.
            home = Path(temporary) / 'home'
            home.mkdir()
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'TMPDIR', 'LANG', 'LC_ALL')}
            env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'),
                       XDG_DATA_HOME=str(home / '.local/share'), INBOXTOP_TEST_BINARY=str(binary))
            version = subprocess.check_output([str(binary), '--version'], cwd=directory, env=env, text=True).strip()
            assert version == manifest['version'], 'Executable/manifest version mismatch'
            json.loads(subprocess.check_output([str(binary), 'setup', '--schema'], cwd=directory, env=env))
            subprocess.run([sys.executable, str(root / 'scripts/smoke-terminal.py')],
                           cwd=directory, env=env, check=True)
        print(f'PASS: {archive.name} checksums, contents and applicable terminal checks', flush=True)


if __name__ == '__main__':
    package = json.loads((root / 'package.json').read_text())
    archives = [Path(p).resolve() for p in sys.argv[1:]] or sorted(
        (root / 'dist').glob(f"{package['name']}-{package['version']}-*.tar.gz"))
    if not archives:
        raise SystemExit('No archives. Run npm run package:release first.')
    for archive in archives:
        verify(archive)
