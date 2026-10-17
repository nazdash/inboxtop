"""Explicit fictional credential test in a disposable Linux Secret Service session."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if sys.platform != 'linux':
    raise SystemExit('Run this disposable Secret Service test on Linux.')
if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 scripts/check-linux-vault.py /path/to/compiled-binary')
binary = str(Path(sys.argv[1]).resolve())
for tool in ('dbus-run-session', 'gnome-keyring-daemon', 'secret-tool'):
    if not shutil.which(tool):
        raise SystemExit(f'Missing {tool}; install dbus, gnome-keyring and libsecret-tools.')
with tempfile.TemporaryDirectory(prefix='inboxtop-vault-test-') as directory:
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'LC_ALL')}
    env.update(HOME=directory, XDG_CONFIG_HOME=directory + '/config',
               XDG_DATA_HOME=directory + '/data', XDG_RUNTIME_DIR=directory + '/run')
    Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700)
    missing = directory + '/fictional-missing.env'
    command = [binary, 'doctor', '--env', missing, '--test-vault', '--json']
    # No actual user's bus, keyring, credentials or environment are inherited.
    shell = 'printf "%s" "fictional-test-only" | gnome-keyring-daemon --unlock --components=secrets >/dev/null; exec "$@"'
    result = subprocess.run(['dbus-run-session', '--', 'sh', '-c', shell, 'vault-test', *command],
                            env=env, capture_output=True, text=True, timeout=60)
    report = json.loads(result.stdout)
    assert any(c['id'] == 'credential_store' and c['status'] == 'pass' for c in report['checks']), 'Disposable vault roundtrip failed'
    # Deliberately unavailable bus must fail closed; it must not create plaintext credentials.
    env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + directory + '/no-bus'
    failed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=45)
    report = json.loads(failed.stdout)
    assert any(c['id'] == 'credential_store' and c['status'] == 'fail' for c in report['checks']), 'Unavailable store did not fail closed'
    print('PASS: isolated Linux vault roundtrip and unavailable-store failure')
