"""Containment tests: never import native helper or start a database."""
import ast
import pathlib
import unittest
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'tests/run-inbox-check.py'
NODE = 'C:/Users/user/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe'


def functions_only():
    tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
    names = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    assert {'public_environment', 'validate_command'} <= names, 'runner needs explicit public environment and argv validation before logging'
    safe = ast.Module(body=[n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))], type_ignores=[])
    scope: dict[str, Any] = {'__file__': str(SOURCE)}
    exec(compile(safe, str(SOURCE), 'exec'), scope)
    return scope


class Containment(unittest.TestCase):
    def test_denied_ambient_sentinel_and_overrides_never_propagate(self):
        from unittest.mock import patch
        f = functions_only()['public_environment']
        with patch.dict('os.environ', {'ALDER_DENIED_AMBIENT_SENTINEL': 'public-test-marker', 'PGHOST': 'wrong-host', 'NODE_OPTIONS': '--inspect', 'OPENAI_API_KEY': 'public-denial-marker'}, clear=True):
            env = f(pathlib.Path('C:/owned/scratch'), pathlib.Path('C:/owned/output'))
        self.assertFalse({'ALDER_DENIED_AMBIENT_SENTINEL', 'PGHOST', 'NODE_OPTIONS', 'OPENAI_API_KEY'} & env.keys())
        self.assertEqual(env['SystemRoot'], 'C:/Windows')
        self.assertEqual(env['TEMP'], str(pathlib.Path('C:/owned/scratch')))
        self.assertEqual(set(env), {'SystemRoot','WINDIR','ComSpec','PATH','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','ALDER_INBOX_OUTPUT'})

    def test_secret_argv_refused_without_echo_and_known_check_allowed(self):
        f = functions_only()['validate_command']
        f([NODE, '--import', 'tsx', '--test', '--test-concurrency=1', 'tests/inbox-ui.test.tsx'])
        for args in [[NODE,'--eval','public-secret-marker'], [NODE,'--import','tsx','tests/browser-inbox.ts'], [NODE,'--import','tsx','tests/browser-inbox-component.ts','--password=public-secret-marker']]:
            with self.assertRaises(ValueError) as failure:
                f(args)
            self.assertNotIn('public-secret-marker', str(failure.exception))

    def test_rejected_secret_argument_never_reaches_reporting(self):
        import subprocess, sys
        f = functions_only()['public_environment']
        run = subprocess.run([sys.executable, '-I', '-B', str(SOURCE), 'round2-public-denial', '90', NODE, '--eval', 'public-secret-marker'], capture_output=True, text=True, env=f(ROOT, ROOT))
        self.assertEqual(run.returncode, 2)
        self.assertNotIn('public-secret-marker', run.stdout + run.stderr)
        self.assertIn('CHECK_ARGUMENTS_REFUSED', run.stdout)
        self.assertFalse((ROOT / 'docs/inbox-checks/round2-public-denial.json').exists())
        self.assertFalse((ROOT / 'docs/inbox-checks/round2-public-denial.log').exists())

    def test_pg_entrypoint_is_unconditionally_contained(self):
        text = (ROOT / 'tests/browser-inbox.ts').read_text(encoding='utf-8')
        self.assertIn('INBOX_PG_INTEGRATION_UNRUN_UNSAFE_RUNNER_DISABLED', text)
        self.assertNotIn('--auth=trust', text)
        self.assertNotIn('execFileSync', text)

if __name__ == '__main__':
    unittest.main()
