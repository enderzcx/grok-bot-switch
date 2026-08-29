#!/usr/bin/env python3
"""Loopback control-panel tests using a synthetic GROKCTL_HOME."""

from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping
import sys


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.models import ValidationError  # noqa: E402
from grokctl.service import GrokctlService  # noqa: E402
from grokctl.ui import (  # noqa: E402
    MAX_BODY_BYTES,
    ProviderPanel,
    start_panel,
    validate_bind_host,
)


SECRET_MARKER = "local-test-credential-aaaaaaaa"


def sample_profile(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "id": "custom-openai",
        "displayName": "Custom OpenAI",
        "protocol": "openai-chat",
        "baseUrl": "https://api.example.com/v1",
        "model": "model-name",
        "auth": {"type": "bearer"},
        "headers": {},
        "fallbackPolicy": "never",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


class AdditiveService:
    def __init__(self, inner: GrokctlService) -> None:
        self._inner = inner

    def __getattr__(self, name: str) -> object:
        value = getattr(self._inner, name)
        if not callable(value):
            return value

        def wrapped(*args: object, **kwargs: object) -> object:
            result = value(*args, **kwargs)
            if isinstance(result, dict):
                copied = dict(result)
                copied["extraProbe"] = "additive-ok"
                return copied
            return result

        return wrapped


class UiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        os.chmod(self.home, 0o700)
        self.service = GrokctlService(self.home)
        self.panel = start_panel(self.service)
        self._wait_ready()

    def tearDown(self) -> None:
        self.panel.stop()
        self.tmp.cleanup()

    def _wait_ready(self) -> None:
        deadline = time.time() + 2
        last: Exception | None = None
        while time.time() < deadline:
            try:
                self.request("GET", "/api/status", csrf=False, origin=False)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                last = exc
                time.sleep(0.02)
        self.fail(f"panel did not start: {last}")

    def request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        *,
        csrf: bool = True,
        origin: bool | str = True,
        extra_headers: Mapping[str, str] | None = None,
        raw: bytes | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        url = self.panel.url + path
        headers = {"Accept": "application/json"}
        if origin is True:
            headers["Origin"] = self.panel.url
        elif isinstance(origin, str):
            headers["Origin"] = origin
        if csrf and method not in {"GET", "HEAD"}:
            headers["X-CSRF-Token"] = self.panel.csrf_token
        if extra_headers:
            headers.update(extra_headers)
        data = raw
        if data is None and method == "POST":
            data = json.dumps({} if body is None else dict(body)).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return int(resp.status), dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return int(exc.code), dict(exc.headers), exc.read()

    def json(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> tuple[int, Any]:
        status, _headers, raw = self.request(method, path, body, **kwargs)
        text = raw.decode("utf-8")
        self.assertNotIn(SECRET_MARKER, text)
        self.assertNotIn(SECRET_MARKER.encode("ascii"), raw)
        return status, json.loads(text) if text else None

    def test_binds_loopback_ephemeral_port(self) -> None:
        self.assertEqual(self.panel.host, "127.0.0.1")
        self.assertGreater(self.panel.port, 0)
        httpd = self.panel._httpd
        assert httpd is not None
        self.assertEqual(httpd.server_address[0], "127.0.0.1")

    def test_rejects_non_loopback_bind(self) -> None:
        with self.assertRaises(ValidationError):
            validate_bind_host("0.0.0.0")
        with self.assertRaises(ValidationError):
            ProviderPanel(self.service, host="0.0.0.0")
        with self.assertRaises(ValidationError):
            ProviderPanel(self.service, host="127.0.0.1", port=-1)

    def test_static_assets(self) -> None:
        status, headers, raw = self.request("GET", "/", csrf=False, origin=False)
        self.assertEqual(status, 200)
        html = raw.decode("utf-8")
        self.assertIn("text/html", headers.get("Content-Type", headers.get("content-type", "")))
        self.assertIn("提供方切换", html)
        self.assertIn(self.panel.csrf_token, html)
        self.assertNotIn("BeefAPI", html)
        self.assertNotIn(SECRET_MARKER, html)
        js_status, js_headers, js_raw = self.request("GET", "/app.js", csrf=False, origin=False)
        self.assertEqual(js_status, 200)
        self.assertIn("javascript", js_headers.get("Content-Type", js_headers.get("content-type", "")))
        self.assertNotIn(self.panel.csrf_token, js_raw.decode("utf-8"))
        css_status, css_headers, css_raw = self.request("GET", "/styles.css", csrf=False, origin=False)
        self.assertEqual(css_status, 200)
        self.assertIn("text/css", css_headers.get("Content-Type", css_headers.get("content-type", "")))
        self.assertNotIn("ellipsis", css_raw.decode("utf-8"))

    def test_read_apis(self) -> None:
        status, payload = self.json("GET", "/api/status", csrf=False, origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(payload["desiredProfile"], "official")
        self.assertEqual(payload["home"], str(self.home))
        listed_status, listed = self.json("GET", "/api/providers", csrf=False, origin=False)
        self.assertEqual(listed_status, 200)
        self.assertEqual(listed["providers"][0]["id"], "official")
        shown_status, shown = self.json("GET", "/api/providers/official", csrf=False, origin=False)
        self.assertEqual(shown_status, 200)
        self.assertEqual(shown["displayName"], "官方 Grok")
        act_status, activity = self.json("GET", "/api/activity?limit=10", csrf=False, origin=False)
        self.assertEqual(act_status, 200)
        self.assertEqual(activity["events"], [])

    def test_csrf_and_origin_rejection(self) -> None:
        missing, payload = self.json("POST", "/api/plan", {"target": "official"}, csrf=False, origin=True)
        self.assertEqual(missing, 403)
        self.assertEqual(payload["error"]["code"], "forbidden")
        bad_origin, origin_payload = self.json(
            "POST",
            "/api/plan",
            {"target": "official"},
            csrf=True,
            origin="https://evil.example",
        )
        self.assertEqual(bad_origin, 403)
        self.assertEqual(origin_payload["error"]["code"], "forbidden")
        ok, plan = self.json("POST", "/api/plan", {"target": "official"})
        self.assertEqual(ok, 200)
        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["fallbackPolicy"], "never")

    def test_body_limits_and_json_shape(self) -> None:
        huge = b"{" + b"x" * (MAX_BODY_BYTES + 1)
        status, _headers, raw = self.request(
            "POST",
            "/api/providers",
            csrf=True,
            origin=True,
            raw=huge,
            extra_headers={"Content-Type": "application/json", "Content-Length": str(len(huge))},
        )
        self.assertEqual(status, 413)
        self.assertNotIn(SECRET_MARKER.encode("ascii"), raw)
        nested: dict[str, object] = {"target": "official"}
        cursor: dict[str, object] = nested
        for index in range(12):
            nxt: dict[str, object] = {}
            cursor[f"k{index}"] = nxt
            cursor = nxt
        deep_status, deep = self.json("POST", "/api/plan", nested)
        self.assertEqual(deep_status, 400)
        self.assertEqual(deep["error"]["code"], "validation")

    def test_secret_never_echoed(self) -> None:
        add_status, added = self.json("POST", "/api/providers", sample_profile())
        self.assertEqual(add_status, 200)
        self.assertEqual(added["id"], "custom-openai")
        set_status, installed = self.json(
            "POST",
            "/api/providers/custom-openai/secret",
            {"secret": SECRET_MARKER},
        )
        self.assertEqual(set_status, 200)
        self.assertTrue(installed["secret"]["installed"])
        self.assertIsNotNone(installed["secret"]["fingerprintPrefix"])
        blob = json.dumps(installed)
        self.assertNotIn(SECRET_MARKER, blob)
        shown_status, shown = self.json("GET", "/api/providers/custom-openai", csrf=False, origin=False)
        self.assertEqual(shown_status, 200)
        self.assertTrue(shown["secret"]["installed"])
        self.assertNotIn(SECRET_MARKER, json.dumps(shown))
        act_status, activity = self.json("GET", "/api/activity", csrf=False, origin=False)
        self.assertEqual(act_status, 200)
        self.assertNotIn(SECRET_MARKER, json.dumps(activity))
        html_status, _headers, html = self.request("GET", "/", csrf=False, origin=False)
        self.assertEqual(html_status, 200)
        self.assertNotIn(SECRET_MARKER.encode("ascii"), html)

    def test_dry_run_before_apply(self) -> None:
        self.json("POST", "/api/providers", sample_profile())
        skipped, payload = self.json("POST", "/api/use", {"target": "custom-openai", "apply": True})
        self.assertEqual(skipped, 400)
        self.assertIn("计划", payload["error"]["message"])
        plan_status, plan = self.json("POST", "/api/use", {"target": "custom-openai"})
        self.assertEqual(plan_status, 200)
        self.assertTrue(plan["dryRun"])
        self.assertEqual(plan["resolvedEndpoint"], "https://api.example.com/v1/chat/completions")
        self.assertEqual(plan["fallbackPolicy"], "never")
        apply_status, applied = self.json(
            "POST", "/api/use", {"target": "custom-openai", "apply": True}
        )
        self.assertEqual(apply_status, 503)
        self.assertEqual(applied["error"]["code"], "not-wired")
        again, again_payload = self.json(
            "POST", "/api/use", {"target": "custom-openai", "apply": True}
        )
        self.assertEqual(again, 400)
        self.assertIn("计划", again_payload["error"]["message"])
        rollback_plan_status, rollback_plan = self.json("POST", "/api/rollback", {"apply": False})
        self.assertEqual(rollback_plan_status, 200)
        self.assertTrue(rollback_plan["dryRun"])
        rollback_apply, rollback_body = self.json(
            "POST", "/api/rollback", {"target": "official", "apply": True}
        )
        self.assertEqual(rollback_apply, 503)
        self.assertEqual(rollback_body["error"]["code"], "not-wired")

    def test_remove_requires_preview(self) -> None:
        self.json("POST", "/api/providers", sample_profile())
        denied, denied_body = self.json(
            "POST", "/api/providers/custom-openai/remove", {"confirm": True}
        )
        self.assertEqual(denied, 400)
        self.assertIn("计划", denied_body["error"]["message"])
        preview_status, preview = self.json("POST", "/api/providers/custom-openai/remove", {})
        self.assertEqual(preview_status, 200)
        self.assertTrue(preview["dryRun"])
        self.assertEqual(preview["id"], "custom-openai")
        removed_status, removed = self.json(
            "POST", "/api/providers/custom-openai/remove", {"confirm": True}
        )
        self.assertEqual(removed_status, 200)
        self.assertTrue(removed["removed"])
        listed_status, listed = self.json("GET", "/api/providers", csrf=False, origin=False)
        self.assertEqual(listed_status, 200)
        self.assertEqual([item["id"] for item in listed["providers"]], ["official"])

    def test_test_config_and_live_not_wired(self) -> None:
        self.json("POST", "/api/providers", sample_profile())
        status, result = self.json("POST", "/api/test", {"target": "custom-openai", "live": False})
        self.assertEqual(status, 200)
        self.assertFalse(result["ok"])
        self.assertFalse(result["live"])
        live_status, live = self.json("POST", "/api/test", {"target": "custom-openai", "live": True})
        self.assertEqual(live_status, 503)
        self.assertEqual(live["error"]["code"], "not-wired")

    def test_additive_service_payload_is_passed_through(self) -> None:
        extra = AdditiveService(self.service)
        with start_panel(extra) as panel:  # type: ignore[arg-type]
            url = panel.url + "/api/status"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(payload["extraProbe"], "additive-ok")
            self.assertEqual(payload["desiredProfile"], "official")

    def test_csrf_from_html_can_mutate(self) -> None:
        _status, _headers, raw = self.request("GET", "/", csrf=False, origin=False)
        html = raw.decode("utf-8")
        token = html.split('name="csrf-token" content="', 1)[1].split('"', 1)[0]
        self.assertEqual(token, self.panel.csrf_token)
        status, payload = self.json(
            "POST",
            "/api/providers",
            sample_profile(id="html-token"),
            extra_headers={"X-CSRF-Token": token},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["id"], "html-token")
        self.assertEqual(payload["resolvedMethod"], "POST")


if __name__ == "__main__":
    unittest.main()
