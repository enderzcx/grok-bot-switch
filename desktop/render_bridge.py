"""Generate the native payload bundled with the desktop executable."""
import argparse
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from desktop.build_windows_probe import make_source
from grokctl.profiles import atomic_replace

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
source = make_source(with_host_package=True)
subprocess.run(["node", "--check"], input=source, check=True)
atomic_replace(args.output, source)
