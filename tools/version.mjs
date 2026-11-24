import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
if (args.length && !check) throw new Error("Usage: node tools/version.mjs [--check]");

const version = readFileSync(new URL("VERSION", root), "utf8").trim();
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const match = version.match(semver);
if (!match || match[1]?.split(".").some(part => /^0\d+$/.test(part)))
  throw new Error("VERSION must contain a valid semantic version, such as 0.1.0 or 0.2.0-beta.1");

// Prepare every change before writing, and preserve existing manifest formatting.
const changes = new Map();
function update(file, transform) {
  const original = readFileSync(new URL(file, root), "utf8");
  const updated = transform(original);
  if (updated !== original) changes.set(file, updated);
}

function replaceVersion(text, pattern) {
  if ([...text.matchAll(new RegExp(pattern.source, pattern.flags + "g"))].length !== 1)
    throw new Error(`Expected one version field matching ${pattern}`);
  return text.replace(pattern, (_, before, after) => before + version + after);
}

for (const file of ["package.json", "apps/editor/package.json", "sdk/javascript/package.json"]) {
  update(file, text => {
    text = replaceVersion(text, /("version"\s*:\s*")[^"\r\n]*(")/);
    if (file === "apps/editor/package.json")
      text = replaceVersion(text, /("@pamatcad\/sdk"\s*:\s*")[^"\r\n]*(")/);
    return text;
  });
}

for (const file of ["Cargo.toml", "apps/editor/src-tauri/Cargo.toml"])
  update(file, text => replaceVersion(text, /^(version\s*=\s*")[^"\r\n]*(")/m));

update("package-lock.json", text => {
  const lock = JSON.parse(text);
  lock.version = version;
  for (const path of ["", "apps/editor", "sdk/javascript"])
    lock.packages[path].version = version;
  lock.packages["apps/editor"].dependencies["@pamatcad/sdk"] = version;
  return JSON.stringify(lock, null, 2) + "\n";
});

for (const [file, packages] of [
  ["Cargo.lock", ["pamatcad-core", "pamatcad-host", "pamatcad-wasm"]],
  ["apps/editor/src-tauri/Cargo.lock", ["pamatcad-core", "pamatcad-host", "pamatcad-editor"]],
]) {
  update(file, text => {
    for (const name of packages)
      text = replaceVersion(text, new RegExp(`^(name = "${name}"\\r?\\nversion = ")[^"\\r\\n]*(")`, "m"));
    return text;
  });
}

if (check && changes.size) {
  console.error(`Versions differ from VERSION (${version}):\n${[...changes.keys()].join("\n")}\nRun npm run version:sync.`);
  process.exitCode = 1;
} else {
  for (const [file, text] of changes) {
    writeFileSync(new URL(file, root), text);
    console.log(`Updated ${file}`);
  }
  console.log(`PamatCAD versions match VERSION (${version}).`);
}
