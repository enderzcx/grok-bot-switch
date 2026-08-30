"""Bounded, hash-pinned ASAR patch construction; never installs an archive.

The original payload is retained byte-for-byte. Only the entrypoint's header
offset, size and integrity change, pointing to an appended replacement member.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct


ENTRYPOINT = "dist/electron-main/main.cjs"
MARKER = b"GROK_BOT_SWITCH_CLIENT_BRIDGE"
APPEND_PREFIX = b"\n;/* " + MARKER + b" */\n"
MAX_ARCHIVE_SIZE = 512 * 1024 * 1024
MAX_HEADER_SIZE = 4 * 1024 * 1024
MAX_MAIN_SIZE = 32 * 1024 * 1024
MAX_BLOCK_SIZE = 16 * 1024 * 1024
DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024


class AsarPatchError(ValueError):
    """The requested patch could not be safely constructed or verified."""


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    if path.is_symlink():
        raise AsarPatchError("archive must not be a symlink")
    with os.fdopen(os.open(path, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARCHIVE_SIZE:
            raise AsarPatchError("archive must be a regular file within size limit")
        data = stream.read(MAX_ARCHIVE_SIZE + 1)
    if len(data) > MAX_ARCHIVE_SIZE:
        raise AsarPatchError("archive exceeds size limit")
    return data


def _unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise AsarPatchError("duplicate header JSON key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise AsarPatchError("nonfinite JSON number")


def _integer(value: object, limit: int, name: str) -> int:
    if type(value) is not int or not 0 <= value <= limit:
        raise AsarPatchError("invalid " + name)
    return value


def _offset(entry: dict, payload_size: int) -> int:
    offset = entry.get("offset")
    if not isinstance(offset, str) or not re.fullmatch(r"0|[1-9][0-9]{0,15}", offset):
        raise AsarPatchError("invalid member offset")
    size = _integer(entry.get("size"), payload_size, "member size")
    position = int(offset)
    if position + size > payload_size:
        raise AsarPatchError("member lies outside archive payload")
    return position


def _main(header: dict) -> dict:
    entry = header
    for name in ENTRYPOINT.split("/"):
        files = entry.get("files")
        if not isinstance(files, dict) or not isinstance(files.get(name), dict):
            raise AsarPatchError("missing main entrypoint")
        if "link" in entry or entry.get("unpacked"):
            raise AsarPatchError("main entrypoint has a linked or unpacked ancestor")
        entry = files[name]
    if "files" in entry or "link" in entry or "unpacked" in entry:
        raise AsarPatchError("main entrypoint must be a packed regular member")
    return entry


def _parse(data: bytes) -> tuple[dict, bytes, bytes]:
    if len(data) < 16 or len(data) > MAX_ARCHIVE_SIZE:
        raise AsarPatchError("invalid archive size")
    marker, header_size, pickle_size, json_size = struct.unpack_from("<4I", data)
    if marker != 4:
        raise AsarPatchError("unknown ASAR header marker")
    if not 8 <= header_size <= MAX_HEADER_SIZE or header_size != pickle_size + 4:
        raise AsarPatchError("invalid ASAR header size")
    if pickle_size % 4 or pickle_size != ((4 + json_size + 3) & ~3):
        raise AsarPatchError("invalid ASAR pickle size")
    end = 8 + header_size
    if end > len(data) or not json_size or 16 + json_size > end:
        raise AsarPatchError("truncated ASAR header")
    if any(data[16 + json_size:end]):
        raise AsarPatchError("invalid ASAR padding")
    raw_header = data[16:16 + json_size]
    try:
        header = json.loads(raw_header.decode("utf-8"), object_pairs_hook=_unique_object,
                            parse_constant=_reject_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise AsarPatchError("invalid ASAR JSON") from exc
    if not isinstance(header, dict) or not isinstance(header.get("files"), dict):
        raise AsarPatchError("invalid ASAR directory tree")
    payload = data[end:]
    pending = [header]
    while pending:
        node = pending.pop()
        if "files" in node:
            if not isinstance(node["files"], dict) or "link" in node or "offset" in node:
                raise AsarPatchError("invalid ASAR directory")
            for name, entry in node["files"].items():
                if not name or name in (".", "..") or "/" in name or "\\" in name or "\0" in name:
                    raise AsarPatchError("invalid ASAR member name")
                if not isinstance(entry, dict):
                    raise AsarPatchError("invalid ASAR member")
                pending.append(entry)
        elif "link" in node:
            if not isinstance(node["link"], str) or "offset" in node:
                raise AsarPatchError("invalid ASAR link")
        elif node.get("unpacked") is True:
            _integer(node.get("size"), MAX_ARCHIVE_SIZE, "unpacked member size")
        else:
            _offset(node, len(payload))
    main = _main(header)
    _integer(main.get("size"), MAX_MAIN_SIZE, "main size")
    return header, payload, raw_header


def _integrity(main: dict, contents: bytes) -> dict:
    previous = main.get("integrity")
    if previous is None:
        block_size = DEFAULT_BLOCK_SIZE
    else:
        if not isinstance(previous, dict) or previous.get("algorithm") != "SHA256":
            raise AsarPatchError("unsupported main integrity algorithm")
        block_size = _integer(previous.get("blockSize"), MAX_BLOCK_SIZE, "integrity block size")
        if block_size == 0:
            raise AsarPatchError("integrity block size must be positive")
    return {"algorithm": "SHA256", "hash": _digest(contents), "blockSize": block_size,
            "blocks": [_digest(contents[start:start + block_size])
                       for start in range(0, len(contents), block_size)]}


def _replacement(data: bytes, append_source: bytes, expected_sha256: str) -> tuple:
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
        raise AsarPatchError("an exact expected archive SHA256 is required")
    if _digest(data) != expected_sha256.lower():
        raise AsarPatchError("archive SHA256 does not match expected value")
    if not isinstance(append_source, bytes) or not append_source.strip():
        raise AsarPatchError("append source must be nonempty bytes")
    if MARKER in append_source:
        raise AsarPatchError("append source must not contain the reserved bridge marker")
    header, payload, _ = _parse(data)
    main = _main(header)
    offset = _offset(main, len(payload))
    old_main = payload[offset:offset + main["size"]]
    if MARKER in old_main:
        raise AsarPatchError("main entrypoint is already patched")
    if len(old_main) + len(APPEND_PREFIX) + len(append_source) + 1 > MAX_MAIN_SIZE:
        raise AsarPatchError("patched main exceeds size limit")
    new_main = old_main + APPEND_PREFIX + append_source + b"\n"
    patched_header = copy.deepcopy(header)
    _main(patched_header).update(offset=str(len(payload)), size=len(new_main),
                                 integrity=_integrity(main, new_main))
    return patched_header, payload, old_main, new_main


def _pack(header: dict, payload: bytes) -> bytes:
    raw_header = json.dumps(header, ensure_ascii=False, separators=(",", ":"),
                            allow_nan=False).encode("utf-8")
    pickle_size = (4 + len(raw_header) + 3) & ~3
    header_size = pickle_size + 4
    if header_size > MAX_HEADER_SIZE or 8 + header_size + len(payload) > MAX_ARCHIVE_SIZE:
        raise AsarPatchError("patched archive exceeds size limit")
    return (struct.pack("<4I", 4, header_size, pickle_size, len(raw_header)) + raw_header
            + b"\0" * (pickle_size - 4 - len(raw_header)) + payload)


def _verify(original: bytes, patched: bytes, append_source: bytes, expected_sha256: str) -> dict:
    expected_header, payload, old_main, new_main = _replacement(original, append_source, expected_sha256)
    actual_header, actual_payload, raw_header = _parse(patched)
    if actual_header != expected_header:
        raise AsarPatchError("patched header differs from the entrypoint-only change")
    if actual_payload != payload + new_main:
        raise AsarPatchError("patched payload does not preserve original bytes and exact appended main")
    return {"before_sha256": _digest(original), "after_sha256": _digest(patched),
            "old_main_sha256": _digest(old_main), "new_main_sha256": _digest(new_main),
            "header_sha256": _digest(raw_header), "entrypoint": ENTRYPOINT,
            "original_size": len(original), "patched_size": len(patched)}


def verify_patch(original: Path, patched: Path, append_source: bytes, expected_sha256: str) -> dict:
    """Verify all metadata and payload bytes against the exact hash-pinned input."""
    return _verify(_read(Path(original)), _read(Path(patched)), append_source, expected_sha256)


def build_patch(archive: Path, output: Path, append_source: bytes, expected_sha256: str) -> dict:
    """Create a new patch artifact exclusively; input and installed apps are never modified."""
    archive, output = Path(archive), Path(output)
    if archive.resolve() == output.resolve() or output.exists() or output.is_symlink():
        raise AsarPatchError("output must be a new path distinct from the input")
    original = _read(archive)
    header, payload, _, new_main = _replacement(original, append_source, expected_sha256)
    patched = _pack(header, payload + new_main)
    receipt = _verify(original, patched, append_source, expected_sha256)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(output, flags, 0o600), "wb") as stream:
        stream.write(patched)
        stream.flush()
        os.fsync(stream.fileno())
    if _read(output) != patched:
        raise AsarPatchError("output readback does not match verified patch")
    return receipt
