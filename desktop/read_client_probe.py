"""Read paired probe receipts without printing its local pairing token."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grokctl.profiles import atomic_replace, _file_is_private_regular


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--operation", choices=["status", "inspect", "host-bundle"], default="status")
    args = parser.parse_args()
    manifest_path = args.home / "client-bridge.json"
    _file_is_private_regular(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    port = manifest["port"]
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("invalid bridge port")
    request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/{args.operation}",
        headers={"Authorization": "Bearer " + manifest["token"]})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=40) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        result = json.loads(error.read(8192))
        result["httpStatus"] = error.code
    if args.operation == "host-bundle" and "bundle" in result:
        source = result.pop("bundle").encode()
        if hashlib.sha256(source).hexdigest() != result["sha256"]:
            raise ValueError("bundle hash mismatch")
        target = args.home / "host-main.cjs"
        atomic_replace(target, source)
        result.update(path=str(target), size=len(source))
    for program in result.get("programSources", []):
        source = program.pop("source").encode()
        digest = hashlib.sha256(source).hexdigest()
        if digest != program["sha256"]:
            raise ValueError("program hash mismatch")
        target = args.home / ("supervisor-" + digest + ".txt")
        atomic_replace(target, source)
        program.update(localPath=str(target), size=len(source))
    atomic_replace(args.home / (args.operation + "-receipt.json"), json.dumps(result, indent=2).encode())
    print(json.dumps(result))


if __name__ == "__main__":
    main()
