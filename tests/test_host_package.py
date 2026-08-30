import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zlib

from desktop.host_package import FILES, build_host_package


class HostPackageTests(unittest.TestCase):
    def test_package_is_deterministic_and_has_only_allowlisted_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in FILES:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture: " + name)
            (root / "secret.key").write_text("SENTINEL_KEY")
            first = build_host_package(root)
            self.assertEqual(first, build_host_package(root))
            raw = zlib.decompress(base64.b64decode(first["payload"]))
            self.assertEqual(hashlib.sha256(raw).hexdigest(), first["sha256"])
            decoded = json.loads(raw)
            self.assertEqual(set(decoded["files"]), set(FILES))
            self.assertNotIn("SENTINEL", raw.decode())
            for name, file in decoded["files"].items():
                self.assertEqual(hashlib.sha256(base64.b64decode(file["content"])).hexdigest(), first["files"][name])

    def test_missing_source_refuses_partial_package(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "missing package source"):
                build_host_package(Path(directory))


if __name__ == "__main__":
    unittest.main()
