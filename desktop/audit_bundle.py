"""Copy public installed application code for bounded compatibility auditing.

Never reads the user-data directory. Does not change the installed archive.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(args.archive.read_bytes()).hexdigest()
    backup = args.output / (digest + ".asar")
    if not backup.exists():
        with backup.open("xb") as target, args.archive.open("rb") as source:
            import shutil
            shutil.copyfileobj(source, target)
    if hashlib.sha256(backup.read_bytes()).hexdigest() != digest:
        raise ValueError("backup hash mismatch")
    manifest = {"archiveSha256": digest, "members": {}}
    with backup.open("rb") as source:
        sizes = struct.unpack("<4I", source.read(16))
        if not 0 < sizes[3] < 4 * 1024 * 1024:
            raise ValueError("invalid archive header")
        header = json.loads(source.read(sizes[3]))
        for name in ("dist/electron-main/main.cjs", "dist/node-agent-coordinator/main.cjs", "dist/electron-preload/preload.cjs", "package.json"):
            node = header
            for part in name.split("/"):
                node = node["files"][part]
            if node.get("unpacked") or node.get("link") or not 0 < node["size"] < 32 * 1024 * 1024:
                raise ValueError("unsupported archive member")
            source.seek(8 + sizes[1] + int(node["offset"]))
            data = source.read(node["size"])
            destination = args.output / name.replace("/", "_")
            if destination.exists() and destination.read_bytes() != data:
                raise ValueError("audit output already belongs to another version")
            destination.write_bytes(data)
            manifest["members"][name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
