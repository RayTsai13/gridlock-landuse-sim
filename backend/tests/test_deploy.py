import os
from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize('failure', ['', 'build', 'verify'])
def test_deploy_pins_revision_and_rolls_back_on_failure(tmp_path, failure):
    root = Path(__file__).resolve().parents[2]
    binaries = tmp_path / 'bin'
    binaries.mkdir()
    command = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['COMMAND_LOG'], 'a') as stream:
    stream.write(json.dumps([name, *args]) + '\\n')
if name == 'docker':
    if 'config' in args:
        print('{"name":"gridlock-test"}' if '--format' in args else 'name: gridlock-test')
    elif 'ps' in args:
        print('existing-container')
    elif 'inspect' in args:
        print('sha256:previous-image')
    elif 'printenv' in args:
        print(':80')
    if 'build' in args and os.environ.get('FAIL_AT') == 'build':
        sys.exit(1)
if name == 'curl' and os.environ.get('FAIL_AT') == 'verify':
    sys.exit(22)
'''
    for name in ('git', 'docker', 'curl', 'flock'):
        path = binaries / name
        path.write_text(command)
        path.chmod(0o755)
    log = tmp_path / 'commands.jsonl'
    current = 'a' * 40
    previous = 'b' * 40
    result = subprocess.run(['bash', str(root / 'scripts/deploy.sh'), current, previous], cwd=tmp_path,
                            env={**os.environ, 'PATH': f'{binaries}:{os.environ["PATH"]}', 'COMMAND_LOG': str(log), 'FAIL_AT': failure},
                            capture_output=True, text=True)
    transcript = log.read_text()
    assert f'"reset", "--hard", "{current}"' in transcript
    assert 'prune' not in transcript
    if failure:
        assert result.returncode != 0
        assert f'"reset", "--hard", "{previous}"' in transcript
        assert 'rollback-images.yml' in transcript
        assert '"--no-build", "--wait"' in transcript
    else:
        assert result.returncode == 0, result.stderr
        assert (tmp_path / '.deploy/current').read_text().strip() == current
        assert (tmp_path / '.deploy/previous').read_text().strip() == previous
