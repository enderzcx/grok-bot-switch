#!/usr/bin/env python3
"""Pipe one existing BeefAPI token to the Grok Bot host without printing it."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys


BEEFAPI_EXEC = "/Users/sunny/.codex/bin/beefapi-exec"
DESTINATION = "root@100.104.143.85"
REMOTE_PATH = "/workspace/grok-home/secrets/beefapi-grok.token"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Provision one dedicated, limited Grok-group BeefAPI token without printing it.")
    parser.add_argument("--token-id", type=int, required=True)
    parser.add_argument("--destination", default=DESTINATION)
    parser.add_argument("--remote-path", default=REMOTE_PATH)
    args = parser.parse_args(argv)
    if args.token_id <= 0:
        parser.error("--token-id must be positive")

    sql = (
        "SELECT chr(115) || chr(107) || chr(45) || key FROM tokens "
        f"WHERE id = {args.token_id} AND status = 1 AND deleted_at IS NULL "
        "AND to_jsonb(tokens)->>(chr(103)||chr(114)||chr(111)||chr(117)||chr(112)) "
        "= (chr(103)||chr(114)||chr(111)||chr(107)) "
        "AND unlimited_quota = false AND remain_quota > 0 "
        "AND model_limits_enabled = true AND model_limits = 'grok-4.6';"
    )
    shell_safe_sql = sql.replace("$", "\\$")
    remote_query = (
        "docker exec beefapi-postgres sh -lc \""
        "PGPASSWORD=\\$POSTGRES_PASSWORD psql -U \\$POSTGRES_USER -d \\$POSTGRES_DB "
        f"-At -c '{shell_safe_sql}'\""
    )
    source = subprocess.run(
        [BEEFAPI_EXEC, "--raw", remote_query],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if source.returncode != 0:
        sys.stderr.write("BeefAPI token selection failed: " + source.stderr.decode("utf-8", "replace")[-600:] + "\n")
        return 2
    try:
        envelope = json.loads(source.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"BeefAPI token selection returned a non-JSON envelope (bytes={len(source.stdout)})\n")
        return 3
    if envelope.get("exitCode") != 0:
        error = str(envelope.get("stderr") or "remote query failed")
        sys.stderr.write("BeefAPI token selection query failed: " + error[-600:] + "\n")
        return 3
    token = str(envelope.get("stdout") or "").strip().encode()
    if not re.fullmatch(rb"sk-[A-Za-z0-9_-]{20,}", token):
        sys.stderr.write(f"BeefAPI token selection returned an invalid shape (bytes={len(token)})\n")
        return 4

    remote_program = (
        "import grp,os,pathlib,pwd,stat,sys; "
        f"p=pathlib.Path({args.remote_path!r}); "
        "p.parent.mkdir(parents=True,exist_ok=True); "
        "data=sys.stdin.buffer.read().strip(); "
        "assert data.startswith(b'sk-') and len(data)>=20 and len(data.split())==1; "
        "fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); "
        "os.write(fd,data+b'\\n'); os.close(fd); os.chmod(p,0o600); "
        "os.chown(p,pwd.getpwnam('box').pw_uid,grp.getgrnam('box').gr_gid); "
        "print('SECRET_INSTALLED bytes=%d mode=600' % len(data))"
    )
    destination = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", args.destination, "python3 -c " + shlex.quote(remote_program)],
        input=token,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    token_fingerprint = hashlib.sha256(token).hexdigest()[:12]
    token = b""
    if destination.returncode != 0:
        sys.stderr.write("Remote secret provisioning failed: " + destination.stderr.decode("utf-8", "replace")[-600:] + "\n")
        return 5
    print(destination.stdout.decode("utf-8", "replace").strip())
    print(f"TOKEN_ID={args.token_id} GROUP=grok MODEL=grok-4.6 LIMITED=true fingerprint={token_fingerprint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
