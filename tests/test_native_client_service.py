import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from grokctl.client_bridge import ClientBridgeError
from grokctl.models import ConflictError, GrokctlError
from grokctl.profiles import atomic_replace
from grokctl.service import GrokctlService


class NativeClientServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name) / "home"
        self.service = GrokctlService(self.home)
        self.profile = {"schemaVersion":1,"id":"custom","displayName":"Custom","mode":"external",
                        "protocol":"openai-chat","baseUrl":"https://api.example.com/v1","model":"custom-model",
                        "auth":{"type":"bearer"},"headers":{},"parameters":{},"fallbackPolicy":"never","enabled":True}
        self.service.add_provider(self.profile)
        self.key = "SENTINEL_SUPPLIER_KEY"
        self.service.set_secret("custom", io.BytesIO(self.key.encode()))
        atomic_replace(self.home / "bridge-enabled.json", b'{"schemaVersion":1,"mode":"native-switch"}')
        self.state = {"connected":True,"mode":"native-switch","hostReachable":True,"providerSwitchReady":True,
                      "runtime":{"runtimeKind":"native-host","activeProfile":"official","desiredProfile":"official",
                                 "profileDigest":None,"blocking":[],"previousProfile":None}}
        self.status_patch = patch("grokctl.native_client_service.client_bridge.status", side_effect=lambda *_: self.state)
        self.status_patch.start()
        self.install_patch = patch("grokctl.native_client_service.discover_installation", return_value={"installations":[
            {"path":str(Path(self.temp.name)/"Grok Bot"),"executable":str(Path(self.temp.name)/"Grok Bot/Grok Bot.exe"),"version":"0.28.0"}]})
        self.install_patch.start()
        self.calls = []
        def call(_home, action, **kwargs):
            self.calls.append((action, kwargs))
            if action == "plan":
                return {"status":"planned","verified":False,"target":"custom"}
            if action == "begin":
                return {"status":"pending","phase":"awaiting-restart","verified":False,"target":"custom"}
            if action == "progress":
                return {"status":"verified","verified":True,"target":"custom"}
            return {"ok":True}
        self.call_patch = patch("grokctl.native_client_service.client_bridge.call", side_effect=call)
        self.call_patch.start()

    def tearDown(self):
        self.call_patch.stop()
        self.install_patch.stop()
        self.status_patch.stop()
        self.temp.cleanup()

    def test_status_uses_native_readback_without_synthetic_activation(self):
        result = self.service.status()
        self.assertEqual(result["runtimeKind"], "native-host")
        self.assertEqual(result["activeProfile"], "official")
        self.assertTrue(result["host"]["wired"])
        self.assertEqual(self.calls, [])

    def test_begin_transfers_key_once_and_does_not_claim_pending_as_active(self):
        result = self.service.use("custom", apply=True)
        self.assertEqual(result["status"], "pending")
        self.assertFalse(result["verified"])
        begins = [kwargs for action, kwargs in self.calls if action == "begin"]
        self.assertEqual(len(begins), 1)
        self.assertEqual(begins[0]["secret"], self.key)
        self.assertNotIn(self.key, json.dumps(result))
        self.assertNotIn(self.key, self.service.activity_path.read_text())
        self.assertEqual(self.service.status()["activeProfile"], "official")
        self.assertTrue(self.service.native_progress()["verified"])

    def test_unconfirmed_begin_is_not_retried(self):
        self.call_patch.stop()
        calls = []
        def call(_home, action, **kwargs):
            calls.append(action)
            if action == "plan":
                return {"status":"planned","verified":False,"target":"custom"}
            raise ClientBridgeError("native-operation-unconfirmed")
        with patch("grokctl.native_client_service.client_bridge.call", side_effect=call):
            with self.assertRaises(GrokctlError):
                self.service.use("custom", apply=True)
        self.assertEqual(calls.count("begin"), 1)

    def test_current_previous_and_pending_profiles_keep_key_delete_guard(self):
        for field in ("activeProfile", "previousProfile", "desiredProfile"):
            old = self.state["runtime"].get(field)
            self.state["runtime"][field] = "custom"
            with self.subTest(field=field), self.assertRaises(ConflictError):
                self.service.remove_secret("custom")
            self.assertTrue(self.service.secrets.status("custom").installed)
            self.state["runtime"][field] = old

    def test_unknown_native_state_never_falls_through_to_destructive_local_edit(self):
        self.state = {"connected":False}
        with self.assertRaises(ConflictError):
            self.service.remove_provider("custom")
        self.assertTrue(self.service.secrets.status("custom").installed)

    def test_profile_digest_drift_is_not_shown_as_applied(self):
        self.state["runtime"].update(activeProfile="custom",profileDigest="f"*64)
        result = self.service.status()
        self.assertIsNone(result["activeProfile"])
        self.assertIn("profile-changed", result["blocking"])


if __name__ == "__main__":
    unittest.main()
