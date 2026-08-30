"""Build the pinned, opt-in Windows client probe; never installs it."""
from pathlib import Path
import argparse
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from grokctl.asar_patch import build_patch, verify_patch
from grokctl.profiles import ensure_private_dir, atomic_replace

ORIGINAL_SHA = "3476b583b2757ec94b155197a20d0ebe0123929ec280483726cc3d8d6caa5591"


def make_source(root: Path = ROOT, *, with_host_package=False) -> bytes:
    template = (root / "desktop/windows_028_bridge.cjs").read_text()
    if template.count("    __BRIDGE_MODULE__") != 1:
        raise ValueError("unexpected bridge template")
    bridge_source = (root / "src/client-bridge.cjs").read_text()
    daemon_import = 'require("./control-daemon.cjs")'
    if bridge_source.count(daemon_import) != 1:
        raise ValueError("unexpected daemon import")
    daemon_source = (root / "src/control-daemon.cjs").read_text()
    bridge_source = bridge_source.replace(daemon_import,
        '(() => { const module = {exports:{}};\n' + daemon_source + '\nreturn module.exports; })()')
    host_import = 'require("./host-bridge.cjs")'
    if bridge_source.count(host_import) != 1:
        raise ValueError("unexpected host bridge import")
    bridge_source = bridge_source.replace(host_import,
        '(() => { const module = {exports:{}};\n' + (root / "src/host-bridge.cjs").read_text() + '\nreturn module.exports; })()')
    if with_host_package:
        from desktop.host_package import build_host_package
        package = build_host_package(root)
        template = template.replace("null; // HOST_PACKAGE_PLACEHOLDER", json.dumps(package, separators=(",", ":")) + "; // HOST_PACKAGE_PLACEHOLDER")
    return template.replace("    __BRIDGE_MODULE__", bridge_source).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--with-host-package", action="store_true")
    args = parser.parse_args()
    source = make_source(with_host_package=args.with_host_package)
    subprocess.run(["node", "--check"], input=source, check=True)
    receipt = build_patch(args.archive, args.output, source, ORIGINAL_SHA)
    if verify_patch(args.archive, args.output, source, ORIGINAL_SHA) != receipt:
        raise ValueError("patch receipt mismatch")
    home = ensure_private_dir(args.home)
    mode = "native-switch" if args.with_host_package else "probe"
    atomic_replace(home / "bridge-enabled.json", json.dumps({"schemaVersion":1,"mode":mode}).encode())
    atomic_replace(home / "patch-receipt.json", json.dumps(receipt, indent=2).encode())
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
