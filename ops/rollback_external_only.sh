#!/bin/sh
set -eu

backup=/workspace/grok-home/backups/direct-external-only/3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef.cjs
target=/home/box/sand-host/host-main.cjs
config=/workspace/grok-home/config/direct-external-only.json
secret=/workspace/grok-home/secrets/beefapi-grok.token
hop_pid=/workspace/grok-home/run/beefapi-hop.pid

test -f "$backup"
/exec-daemon/node --check "$backup"
install -m 0644 -o box -g box "$backup" "$target.rollback-tmp"
mv "$target.rollback-tmp" "$target"
if test -f "$config"; then
  mv "$config" "$config.disabled"
fi
if test -f "$hop_pid"; then
  pid=$(tr -d '[:space:]' < "$hop_pid")
  case "$pid" in
    ''|*[!0-9]*) echo "invalid hop pid file" >&2; exit 1 ;;
  esac
  if test -r "/proc/$pid/cmdline" && tr '\000' ' ' < "/proc/$pid/cmdline" | grep -Fq '/workspace/grok-home/bin/beefapi-hop.py'; then
    kill "$pid" || true
  fi
  rm -f "$hop_pid"
fi
rm -f "$secret"
python3 - <<'PY'
import json, os, time, uuid
path = "/tmp/sand-supervisor/command.json"
temp = path + ".rollback-tmp"
payload = {
    "id": "grok-home-rollback-" + str(uuid.uuid4()),
    "kind": "restart",
    "issuedAtMs": int(time.time() * 1000),
    "reason": "rollback grok_home external-only routing",
}
with open(temp, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
os.replace(temp, path)
print(payload["id"])
PY
