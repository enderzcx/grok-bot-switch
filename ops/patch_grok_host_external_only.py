#!/usr/bin/env python3
"""Apply the anchored Grok Bot 0.30 external-only credential hook."""

from __future__ import annotations

import argparse
from pathlib import Path


ANCHOR = """function resolveSandRequestedModel(inputs) {
  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs;"""

HELPER = r'''function resolveSandExternalOnlyRequestedModel() {
  const configPath = "/workspace/grok-home/config/external-only.json";
  const fs = require("node:fs");
  if (!fs.existsSync(configPath)) return null;
  const path = require("node:path");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (config.enabled !== true) return null;
  if (config.schemaVersion !== 1 || config.mode !== "external-only" || config.nativeFallback !== false) {
    throw new Error("invalid external-only routing contract");
  }
  if (config.provider !== "beefapi" || config.group !== "grok") {
    throw new Error("external-only provider/group must be beefapi/grok");
  }
  if (config.modelId !== "grok-4.6" && config.modelId !== "grok-4.5") {
    throw new Error("external-only model is not in the approved Grok allowlist");
  }
  if (config.baseUrl !== "https://beefapi.com/v1") {
    throw new Error("external-only base URL must be the approved BeefAPI endpoint");
  }
  const keyFile = path.resolve(String(config.keyFile ?? ""));
  const secretRoot = "/workspace/grok-home/secrets/";
  if (!keyFile.startsWith(secretRoot)) {
    throw new Error("external-only credential must stay under the isolated secret root");
  }
  const keyInfo = fs.lstatSync(keyFile);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 63) !== 0) {
    throw new Error("external-only credential must be a private direct regular file");
  }
  const apiKey = fs.readFileSync(keyFile, "utf8").trim();
  if (!apiKey.startsWith("sk-") || apiKey.length < 20 || /\s/.test(apiKey)) {
    throw new Error("external-only credential has an invalid token shape");
  }
  const rawParameters = Array.isArray(config.parameters) ? config.parameters : [];
  const seenParameterIds = new Set();
  const parameters = rawParameters.map((parameter) => {
    if (parameter == null || typeof parameter.id !== "string" || parameter.id.length === 0 || typeof parameter.value !== "string" || seenParameterIds.has(parameter.id)) {
      throw new Error("external-only model parameters are invalid");
    }
    seenParameterIds.add(parameter.id);
    return new RequestedModel_ModelParameterValue({ id: parameter.id, value: parameter.value });
  });
  return new RequestedModel({
    modelId: config.modelId,
    maxMode: config.maxMode === true,
    parameters,
    credentials: {
      case: "apiKeyCredentials",
      value: new ApiKeyCredentials({ apiKey, baseUrl: config.baseUrl })
    },
    builtInModel: false
  });
}
function resolveSandRequestedModel(inputs) {
  const externalOnlyRequestedModel = resolveSandExternalOnlyRequestedModel();
  if (externalOnlyRequestedModel != null) return externalOnlyRequestedModel;
  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs;'''


def patch(source: str) -> str:
    if "function resolveSandExternalOnlyRequestedModel()" in source:
        return source
    count = source.count(ANCHOR)
    if count != 1:
        raise RuntimeError(f"external-only anchor count={count}, expected 1")
    return source.replace(ANCHOR, HELPER, 1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    original = args.source.read_text(encoding="utf-8")
    updated = patch(original)
    args.output.write_text(updated, encoding="utf-8")
    print("changed=" + str(updated != original).lower())
    print("external_only_hook_count=" + str(updated.count("function resolveSandExternalOnlyRequestedModel()")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

