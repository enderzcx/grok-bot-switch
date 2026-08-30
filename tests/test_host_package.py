import base64
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import zlib

from desktop.host_package import FILES, HOST_INIT, build_host_package


class HostPackageTests(unittest.TestCase):
    def test_extracted_package_imports_runner_and_worker_in_isolated_python(self):
        source_root = Path(__file__).resolve().parents[1]
        source_init = (source_root / "grokctl/__init__.py").read_bytes()
        package = build_host_package(source_root)
        self.assertEqual((source_root / "grokctl/__init__.py").read_bytes(), source_init)
        raw = zlib.decompress(base64.b64decode(package["payload"]))
        self.assertEqual(hashlib.sha256(raw).hexdigest(), package["sha256"])
        manifest = json.loads(raw)
        with tempfile.TemporaryDirectory() as directory:
            extracted = Path(directory) / "extracted"
            for name, member in manifest["files"].items():
                contents = base64.b64decode(member["content"])
                self.assertEqual(hashlib.sha256(contents).hexdigest(), member["sha256"])
                self.assertEqual(member["sha256"], package["files"][name])
                target = extracted / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents)
            self.assertFalse((extracted / "grokctl/service.py").exists())
            self.assertEqual((extracted / "grokctl/__init__.py").read_bytes(), HOST_INIT)
            for module in ("ops.native_runner", "ops.native_hop_worker"):
                with self.subTest(module=module):
                    script = (
                        "import importlib,pathlib,sys; "
                        "root=pathlib.Path(sys.argv[1]); sys.path.insert(0,str(root)); "
                        "module=importlib.import_module(sys.argv[2]); "
                        "assert pathlib.Path(module.__file__).is_relative_to(root); "
                        "assert 'grokctl.service' not in sys.modules; print('isolated-import-ok')"
                    )
                    result = subprocess.run([sys.executable, "-I", "-c", script, str(extracted), module],
                                            cwd=directory, capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), "isolated-import-ok")

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
                expected = HOST_INIT if name == "grokctl/__init__.py" else ("fixture: " + name).encode()
                self.assertEqual(base64.b64decode(file["content"]), expected)

    def test_missing_source_refuses_partial_package(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "missing package source"):
                build_host_package(Path(directory))

    def test_rendered_host_package_keeps_payload_and_member_integrity(self):
        root = Path(__file__).resolve().parents[1]
        package = build_host_package(root)
        literal = json.dumps(package, sort_keys=True, separators=(",", ":"))
        template = (root / "desktop/windows_028_bridge.cjs").read_text()
        anchor = "null; // HOST_PACKAGE_PLACEHOLDER"
        self.assertEqual(template.count(anchor), 1)
        rendered = template.replace(anchor, literal + "; // HOST_PACKAGE_PLACEHOLDER")
        checked = subprocess.run(["node", "--check"], input=rendered, capture_output=True, text=True, timeout=15)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        script = "const pkg = " + literal + ";\n" + r"""
const assert = require('node:assert/strict');
const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
const raw = require('node:zlib').inflateSync(Buffer.from(pkg.payload, 'base64'));
assert.equal(hash(raw), pkg.sha256);
const manifest = JSON.parse(raw);
for (const [name, member] of Object.entries(manifest.files)) {
  const bytes = Buffer.from(member.content, 'base64');
  assert.equal(hash(bytes), member.sha256);
  assert.equal(member.sha256, pkg.files[name]);
}
assert.equal(manifest.files['grokctl/service.py'], undefined);
assert.equal(Buffer.from(manifest.files['grokctl/__init__.py'].content, 'base64').toString(), EXPECTED_INIT);
console.log('rendered-integrity-ok');
""".replace("EXPECTED_INIT", json.dumps(HOST_INIT.decode()))
        result = subprocess.run(["node", "-"], input=script, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "rendered-integrity-ok")


if __name__ == "__main__":
    unittest.main()
