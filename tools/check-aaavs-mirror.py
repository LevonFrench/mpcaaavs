"""CPU-only source mirror transaction/conflict checks in temporary directories."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('mirror', Path(__file__).with_name('mirror-aaavs.py'))
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)


class MirrorCheck(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aaavs-mirror-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.target = self.root / 'source', self.root / 'stock'
        self.source.mkdir(); self.target.mkdir()
        mirror.REPO = self.source
        mirror.SPEC = self.source / 'spec.json'
        self.spec = {'directories': [{'source': 'src', 'target': 'src'}], 'files': [], 'bootstrap': {}, 'integration': [], 'scripts': {}}
        (self.source / 'src').mkdir()
        (self.source / 'src' / 'shared.ts').write_text('original\n')
        self.saved_integration = mirror.integration
        mirror.integration = lambda target, spec: {}
        self.addCleanup(setattr, mirror, 'integration', self.saved_integration)
        self.save()

    def save(self):
        mirror.SPEC.write_text(json.dumps(self.spec))

    def test_adopt_repeat_source_update_and_independent_edit(self):
        self.assertEqual(mirror.mirror(self.target)['status'], 'different')
        self.assertFalse((self.target / 'src').exists())
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'applied')
        self.assertEqual(mirror.mirror(self.target)['status'], 'current')
        (self.source / 'src/shared.ts').write_text('updated\n')
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'applied')
        (self.target / 'src/shared.ts').write_text('independent\n')
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'conflict')
        self.assertEqual((self.target / 'src/shared.ts').read_text(), 'independent\n')

    def test_bootstrap_exact_hash_and_obsolete(self):
        (self.target / 'src').mkdir()
        (self.target / 'src/shared.ts').write_text('old stock\n')
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'conflict')
        self.spec['bootstrap']['src/shared.ts'] = mirror.digest(b'old stock\n')
        self.save()
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'applied')
        (self.source / 'src/shared.ts').unlink()
        report = mirror.mirror(self.target)
        self.assertEqual(report['obsolete'], ['src/shared.ts'])
        self.assertTrue((self.target / 'src/shared.ts').exists())

    def test_interrupted_write_can_resume_without_overwriting_independent_edits(self):
        (self.source / 'src/second.ts').write_text('second\n')
        original = mirror.atomic
        writes = 0
        def interrupted(path, data):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError('simulated failure')
            original(path, data)
        mirror.atomic = interrupted
        try:
            with self.assertRaises(OSError):
                mirror.mirror(self.target, True)
        finally:
            mirror.atomic = original
        self.assertFalse((self.target / '.aaavs-mirror.lock').exists())
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'applied')
        self.assertEqual(mirror.mirror(self.target)['status'], 'current')

    def test_integration_scripts_are_not_silently_overwritten(self):
        (self.target / 'package.json').write_text('stock')
        mirror.integration = lambda target, spec: {'package.json': b'generated'}
        self.spec['integration'] = ['package.json']
        self.spec['bootstrap']['package.json'] = mirror.digest(b'stock')
        self.save()
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'applied')
        (self.target / 'package.json').write_text('custom')
        self.assertEqual(mirror.mirror(self.target, True)['status'], 'conflict')
        self.assertEqual((self.target / 'package.json').read_text(), 'custom')

    def test_path_escape_and_reparse(self):
        for relative in ['../outside', '/absolute', 'src/../outside', 'C:/outside', 'src\\outside']:
            with self.assertRaises(ValueError):
                mirror.safe(self.target, relative)
        self.assertEqual(mirror.digest(b'a\r\nb'), mirror.digest(b'a\nb'))


if __name__ == '__main__':
    unittest.main()
