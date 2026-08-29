#!/bin/sh
set -eu

backup=/workspace/grok-home/backups/pre-external-only/host-main.cjs
target=/home/box/sand-host/host-main.cjs
config=/workspace/grok-home/config/external-only.json

test -f "$backup"
/exec-daemon/node --check "$backup"
install -m 0644 -o box -g box "$backup" "$target.rollback-tmp"
mv "$target.rollback-tmp" "$target"
if test -f "$config"; then
  mv "$config" "$config.disabled"
fi
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

