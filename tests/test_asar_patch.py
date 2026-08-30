"""Synthetic ASAR fixtures: no installed apps or credentials are accessed."""

import copy
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from grokctl import asar_patch as ap


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fixture(header=None, payload=None):
    main = b"'use strict';\nconsole.log('stock');\n"
    other = b"OTHER_MEMBER\x00\xff"
    if payload is None:
        payload = main + other + b"UNREFERENCED_TRAILER"
    if header is None:
        header = {"custom": "preserved", "files": {
            "dist": {"files": {"electron-main": {"files": {"main.cjs": {
                "size": len(main), "offset": "0", "executable": True,
                "integrity": {"algorithm": "SHA256", "hash": digest(main), "blockSize": 8,
                              "blocks": [digest(main[i:i+8]) for i in range(0, len(main), 8)]}}}}}},
            "other.bin": {"size": len(other), "offset": str(len(main)), "custom": {"x": [1]}},
            "linked": {"link": "other.bin"},
            "external": {"size": 9, "unpacked": True}}}
    raw = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode()
    padding = (-len(raw)) % 4
    pickle_size = 4 + len(raw) + padding
    return struct.pack("<4I", 4, pickle_size + 4, pickle_size, len(raw)) + raw + b"\0" * padding + payload


def unpack(data):
    _, header_size, _, json_size = struct.unpack_from("<4I", data)
    return json.loads(data[16:16+json_size]), data[8+header_size:]


def main_entry(header):
    return header["files"]["dist"]["files"]["electron-main"]["files"]["main.cjs"]


class AsarPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.original = self.root / "original.asar"
        self.output = self.root / "patched.asar"
        self.source = b"(() => { globalThis.syntheticBridge = true; })();"
        self.data = fixture()
        self.original.write_bytes(self.data)

    def build(self, data=None):
        if data is not None:
            self.original.write_bytes(data)
        return ap.build_patch(self.original, self.output, self.source, digest(self.original.read_bytes()))

    def test_append_only_payload_metadata_and_integrity(self):
        receipt = self.build()
        original_header, original_body = unpack(self.data)
        patched = self.output.read_bytes()
        header, body = unpack(patched)
        old = main_entry(original_header)
        new = main_entry(header)
        expected_main = original_body[:old["size"]] + ap.APPEND_PREFIX + self.source + b"\n"
        self.assertEqual(body, original_body + expected_main)
        self.assertEqual(new["offset"], str(len(original_body)))
        self.assertEqual(new["size"], len(expected_main))
        self.assertEqual(new["integrity"], {
            "algorithm": "SHA256", "hash": digest(expected_main), "blockSize": 8,
            "blocks": [digest(expected_main[i:i+8]) for i in range(0, len(expected_main), 8)]})
        unchanged = copy.deepcopy(header)
        main_entry(unchanged).update({key: old[key] for key in ("offset", "size", "integrity")})
        self.assertEqual(unchanged, original_header)
        self.assertEqual(self.original.read_bytes(), self.data)
        self.assertEqual(receipt["before_sha256"], digest(self.data))
        self.assertEqual(receipt["after_sha256"], digest(patched))
        self.assertEqual(receipt["old_main_sha256"], digest(original_body[:old["size"]]))
        self.assertEqual(receipt["new_main_sha256"], digest(expected_main))
        json_size = struct.unpack_from("<I", patched, 12)[0]
        self.assertEqual(receipt["header_sha256"], digest(patched[16:16+json_size]))
        self.assertEqual(receipt["entrypoint"], ap.ENTRYPOINT)
        self.assertEqual(ap.verify_patch(self.original, self.output, self.source, digest(self.data)), receipt)

    def test_unknown_or_missing_hash_refused(self):
        for expected in ("0" * 64, "", None, "abcd"):
            with self.subTest(expected=expected), self.assertRaises(ap.AsarPatchError):
                ap.build_patch(self.original, self.output, self.source, expected)
            self.assertFalse(self.output.exists())

    def test_double_patch_refused(self):
        self.build()
        with self.assertRaisesRegex(ap.AsarPatchError, "already patched"):
            ap.build_patch(self.output, self.root / "twice.asar", self.source, digest(self.output.read_bytes()))

    def test_main_links_unpacked_and_directories_refused(self):
        for changes in ({"link": "other.bin"}, {"unpacked": True}, {"unpacked": False}, {"files": {}}):
            header, body = unpack(self.data)
            main_entry(header).update(changes)
            with self.subTest(changes=changes), self.assertRaises(ap.AsarPatchError):
                self.build(fixture(header, body))
            self.assertFalse(self.output.exists())

    def test_unpacked_ancestor_refused(self):
        header, body = unpack(self.data)
        header["files"]["dist"]["unpacked"] = True
        with self.assertRaises(ap.AsarPatchError):
            self.build(fixture(header, body))

    def test_malformed_offsets_and_sizes_refused_for_every_packed_member(self):
        for member in ("main", "other"):
            for changes in ({"offset": "-1"}, {"offset": "999999"}, {"offset": 0},
                            {"offset": "00"}, {"size": -1}, {"size": True}, {"size": 999999}):
                header, body = unpack(self.data)
                entry = main_entry(header) if member == "main" else header["files"]["other.bin"]
                entry.update(changes)
                with self.subTest(member=member, changes=changes), self.assertRaises(ap.AsarPatchError):
                    self.build(fixture(header, body))

    def test_existing_output_same_path_and_symlink_refused(self):
        self.output.write_bytes(b"KEEP")
        with self.assertRaises(ap.AsarPatchError):
            self.build()
        self.assertEqual(self.output.read_bytes(), b"KEEP")
        with self.assertRaises(ap.AsarPatchError):
            ap.build_patch(self.original, self.original, self.source, digest(self.data))
        link = self.root / "dangling.asar"
        link.symlink_to(self.root / "nonexistent.asar")
        with self.assertRaises(ap.AsarPatchError):
            ap.build_patch(self.original, link, self.source, digest(self.data))
        self.assertTrue(link.is_symlink())

    def test_output_creation_is_exclusive_even_after_precheck(self):
        real_open = ap.os.open
        def racing_open(path, flags, *args):
            if Path(path) == self.output and flags & ap.os.O_CREAT:
                self.output.write_bytes(b"WINNER")
            return real_open(path, flags, *args)
        with patch.object(ap.os, "open", side_effect=racing_open), self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(self.output.read_bytes(), b"WINNER")

    def test_malformed_pickle_and_size_bounds_refused(self):
        first = struct.unpack_from("<4I", self.data)
        for index, value in ((0, 5), (1, ap.MAX_HEADER_SIZE + 1), (1, 8), (2, 1), (3, 0), (3, 999999)):
            values = list(first)
            values[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(ap.AsarPatchError):
                self.build(struct.pack("<4I", *values) + self.data[16:])
        for data in (b"", self.data[:12], self.data[:30]):
            with self.assertRaises(ap.AsarPatchError):
                self.build(data)

    def test_resource_limits_without_large_allocations(self):
        for name, limit in (("MAX_ARCHIVE_SIZE", 10), ("MAX_HEADER_SIZE", 10), ("MAX_MAIN_SIZE", 10)):
            with self.subTest(name=name), patch.object(ap, name, limit), self.assertRaises(ap.AsarPatchError):
                self.build()

    def test_patched_size_limit_is_checked_before_output_creation(self):
        for name, limit in (("MAX_ARCHIVE_SIZE", len(self.data)), ("MAX_MAIN_SIZE", 40)):
            with self.subTest(name=name), patch.object(ap, name, limit), self.assertRaises(ap.AsarPatchError):
                self.build()
            self.assertFalse(self.output.exists())

    def test_invalid_integrity_refused_and_absent_integrity_created(self):
        for integrity in ({"algorithm": "SHA512", "blockSize": 8},
                          {"algorithm": "SHA256", "blockSize": 0},
                          {"algorithm": "SHA256", "blockSize": True},
                          {"algorithm": "SHA256", "blockSize": ap.MAX_BLOCK_SIZE + 1}):
            header, body = unpack(self.data)
            main_entry(header)["integrity"] = integrity
            with self.subTest(integrity=integrity), self.assertRaises(ap.AsarPatchError):
                self.build(fixture(header, body))
        header, body = unpack(self.data)
        del main_entry(header)["integrity"]
        self.build(fixture(header, body))
        self.assertEqual(main_entry(unpack(self.output.read_bytes())[0])["integrity"]["blockSize"], ap.DEFAULT_BLOCK_SIZE)

    def test_verification_rejects_changes_to_other_metadata_and_payload(self):
        self.build()
        valid = self.output.read_bytes()
        header, body = unpack(valid)
        header["files"]["other.bin"]["custom"]["x"] = [2]
        changed_original_body = fixture(unpack(valid)[0], b"X" + body[1:])
        wrong_offset_header = unpack(valid)[0]
        main_entry(wrong_offset_header)["offset"] = "0"
        for modified in (fixture(header, body), valid[:-1] + b"X", changed_original_body,
                         fixture(wrong_offset_header, body)):
            self.output.write_bytes(modified)
            with self.assertRaises(ap.AsarPatchError):
                ap.verify_patch(self.original, self.output, self.source, digest(self.data))
        self.output.write_bytes(valid)
        with self.assertRaises(ap.AsarPatchError):
            ap.verify_patch(self.original, self.output, b"different();", digest(self.data))

    def test_reserved_marker_and_empty_source_refused(self):
        for source in (b"", b"  ", ap.MARKER, "not bytes"):
            with self.subTest(source=source), self.assertRaises(ap.AsarPatchError):
                ap.build_patch(self.original, self.output, source, digest(self.data))

    def test_duplicate_json_keys_refused(self):
        raw = b'{"files":{},"files":{}}'
        size = (4 + len(raw) + 3) & ~3
        data = struct.pack("<4I", 4, size + 4, size, len(raw)) + raw + b"\0" * (size - 4 - len(raw))
        with self.assertRaisesRegex(ap.AsarPatchError, "duplicate"):
            self.build(data)

    def test_nonzero_padding_and_nonfinite_json_refused(self):
        raw = b'{"files":{},"x":NaN}'
        size = (4 + len(raw) + 3) & ~3
        data = struct.pack("<4I", 4, size + 4, size, len(raw)) + raw + b"\0" * (size - 4 - len(raw))
        with self.assertRaisesRegex(ap.AsarPatchError, "nonfinite"):
            self.build(data)
        raw = b'{"files":{}} '
        size = (4 + len(raw) + 3) & ~3
        data = struct.pack("<4I", 4, size + 4, size, len(raw)) + raw + b"X" * (size - 4 - len(raw))
        with self.assertRaisesRegex(ap.AsarPatchError, "padding"):
            self.build(data)


if __name__ == "__main__":
    unittest.main()
