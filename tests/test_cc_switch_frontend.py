"""Source-transplant provenance and production asset security contracts."""
import hashlib
import json
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

class CcSwitchFrontendTests(unittest.TestCase):
    def test_upstream_components_are_real_pinned_source_copies(self):
        frontend=ROOT/'frontend'
        manifest=json.loads((frontend/'upstream.json').read_text())
        self.assertEqual(manifest['commit'],'d8065cc628fcd373d00c4363d718095f19e78c9e')
        self.assertGreaterEqual(len(manifest['files']),15)
        for item in manifest['files']:
            with self.subTest(path=item['local']):
                self.assertEqual(hashlib.sha256((frontend/item['local']).read_bytes()).hexdigest(),item['sha256'])
        self.assertIn('Copyright (c) 2025 Jason Young',(frontend/'licenses/CC-Switch-MIT.txt').read_text())

    def test_transplant_has_no_tauri_or_other_client_runtime_bindings(self):
        for source in (ROOT/'frontend/src').rglob('*'):
            if source.suffix in {'.ts','.tsx'}:
                text=source.read_text()
                self.assertNotIn('@tauri-apps/',text)
                self.assertNotIn('localStorage',text)
                self.assertNotIn('sessionStorage',text)

    def test_browser_csp_does_not_enable_unsafe_inline_or_eval(self):
        from grokctl.ui import ProviderPanel
        from grokctl.service import GrokctlService
        import tempfile
        import urllib.request
        with tempfile.TemporaryDirectory() as home:
            with ProviderPanel(GrokctlService(Path(home))) as panel:
                with urllib.request.urlopen(panel.url) as response:
                    csp=response.headers['Content-Security-Policy']
                    self.assertNotIn('unsafe-inline',csp)
                    self.assertNotIn('unsafe-eval',csp)
                    self.assertIn("'nonce-"+panel.csrf_token+"'",csp)
                    self.assertIn("connect-src 'self'",csp)
