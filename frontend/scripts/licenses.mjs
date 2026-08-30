// Reproducible notice generation from installed, lockfile-pinned runtime packages.
import fs from "node:fs";
import path from "node:path";
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const notices = [];
for (const [dir, entry] of Object.entries(lock.packages)) {
  if (!dir || entry.dev || !fs.existsSync(dir)) continue;
  const pkg = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  );
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  if (
    !files.length &&
    pkg.name === "react-remove-scroll-bar" &&
    pkg.version === "2.3.8"
  ) {
    // npm tarball omits the notice. Upstream repository MIT notice, retrieved
    // 2026-08-30; this package also declares MIT in its versioned metadata.
    notices.push(
      pkg.name +
        "@" +
        pkg.version +
        "\n\n" +
        fs.readFileSync("licenses/react-remove-scroll-bar-LICENSE.txt", "utf8"),
    );
    continue;
  }
  if (!files.length) throw new Error("Missing license for " + pkg.name);
  notices.push(
    [
      pkg.name + "@" + pkg.version,
      ...files.map((name) => fs.readFileSync(path.join(dir, name), "utf8")),
    ].join("\n\n"),
  );
}
fs.writeFileSync(
  "licenses/dependencies.txt",
  notices
    .join("\n\n" + "=".repeat(72) + "\n\n")
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+$/gm, "")
    .trimEnd() + "\n",
);
console.log(
  "Preserved license notices for " + notices.length + " runtime packages.",
);
