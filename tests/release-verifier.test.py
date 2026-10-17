"""Release verification must reject corruption and unsafe archives before extraction."""
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('release_verifier', Path(__file__).resolve().parents[1] / 'scripts/verify-release.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ArchiveChecks(unittest.TestCase):
    def fixture(self, parent, unsafe=None):
        directory = parent / 'candidate'
        directory.mkdir()
        content = b'fictional source snapshot'
        (directory / 'README.md').write_bytes(content)
        (directory / 'SHA256SUMS').write_text(hashlib.sha256(content).hexdigest() + '  README.md\n')
        archive = parent / 'candidate.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            bundle.add(directory, arcname='candidate')
            if unsafe:
                member = tarfile.TarInfo(unsafe)
                member.size = 7
                bundle.addfile(member, io.BytesIO(b'outside'))
        Path(str(archive) + '.sha256').write_text(verifier.digest(archive) + '  candidate.tar.gz\n')
        return archive, directory

    def test_valid_source_archive(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            archive, _ = self.fixture(Path(temp))
            verifier.verify(archive)

    def test_archive_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            archive, _ = self.fixture(Path(temp))
            with archive.open('ab') as output:
                output.write(b'tampered')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                verifier.verify(archive)

    def test_traversal_before_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            archive, _ = self.fixture(Path(temp), '../outside.txt')
            with self.assertRaisesRegex(ValueError, 'Unsafe archive member'):
                verifier.verify(archive)
            self.assertFalse((Path(temp) / 'outside.txt').exists())

    def test_extra_payload_file(self):
        with tempfile.TemporaryDirectory() as temp:
            _, directory = self.fixture(Path(temp))
            (directory / 'unexpected').write_text('extra')
            with self.assertRaisesRegex(ValueError, 'contents do not match'):
                verifier.verify_payload(directory)


if __name__ == '__main__':
    unittest.main()
