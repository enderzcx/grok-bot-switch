"""Owned provider-hop child; accepts only a private generation config path."""
import argparse
import hashlib
import json
import logging
import os
import sys
from pathlib import Path

# Executed by absolute path, with a trusted package root and no PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grokctl.profiles import atomic_replace
from ops.native_hop import process_identity, read_private
from ops.provider_hop import bind_server, load_runtime


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    server = None
    try:
        if not args.config.is_absolute():
            return 1
        raw = read_private(args.config)
        payload = json.loads(raw)
        if payload.get("listenPort") != 0 or payload.get("listenHost") != "127.0.0.1":
            return 1
        logging.disable(logging.CRITICAL)
        runtime = load_runtime(args.config)
        server = bind_server(runtime)
        # socketserver's default handler prints tracebacks to stderr, potentially
        # including request data. The private log must not contain raw failures.
        server.handle_error = lambda *_args: None
        if read_private(args.config) != raw:
            return 1
        ticks, _ = process_identity(os.getpid())
        ready = {"pid": os.getpid(), "port": server.server_address[1], "startedTicks": ticks,
                 "configDigest": hashlib.sha256(raw).hexdigest()}
        atomic_replace(args.config.parent / "hop-ready.json", json.dumps(ready, sort_keys=True).encode())
        server.serve_forever()
        return 0
    except Exception:
        return 1  # no config, credentials, or raw failure text in child logs
    finally:
        if server is not None:
            server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
